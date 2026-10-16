import streamDeck, {
	action,
	type DialAction,
	type DialDownEvent,
	type DialRotateEvent,
	type DialUpEvent,
	type DidReceiveSettingsEvent,
	type PropertyInspectorDidAppearEvent,
	type SendToPluginEvent,
	SingletonAction,
	type WillAppearEvent,
	type WillDisappearEvent,
} from "@elgato/streamdeck";
import type { JsonObject, JsonValue } from "@elgato/utils";
import { execFile } from "node:child_process";
import {
	type CalendarInfo,
	type CalendarState,
	type CalendarStore,
	type Config,
	DEFAULT_CONFIG,
	shapeEvents,
} from "../calendar/store.js";
import { pickMeetingLink } from "../links.js";
import {
	buildFeedback,
	DEFAULT_TITLE_TIMING,
	feedbackDelta,
	tickInterval,
	type Feedback,
	type TitleTiming,
} from "../render/strip.js";

/**
 * Every dial carries its own settings. They were global at first, which meant a
 * second dial silently mirrored the first however it was configured.
 */
type Settings = Partial<Config> & JsonObject;

type Inst = {
	action: DialAction<Settings>;
	cfg: Config;
	/** The source of truth while browsing — an index would swap events underfoot. */
	pinnedEventId: string | null;
	index: number;
	returnTimer?: NodeJS.Timeout;
	trailingTimer?: NodeJS.Timeout;
	lastSent: Feedback | null;
	lastSentAt: number;
	flashUntil: number;
	flashText: string;
	/** When the shown title started scrolling, so it always begins at its head. */
	marqueeAnchor: number;
	marqueeFor: string | null;
};

const MIN_RENDER_GAP_MS = 40;
const PRESS_DEBOUNCE_MS = 800;
const PRESS_FRESHNESS_MS = 30_000;
const FLASH_MS = 2_000;
const PRIVACY_PANE = "x-apple.systempreferences:com.apple.preference.security?Privacy_Calendars";
const SOUNDS_DIR = "/System/Library/Sounds";
/**
 * Only announce an event whose start we actually witnessed. Without this, every
 * plugin restart during a meeting would replay its sound.
 */
const ANNOUNCE_WINDOW_MS = 60_000;

/** Fills in defaults for anything a dial has not been configured with yet. */
export function readConfig(raw: Partial<Config> | undefined): Config {
	return {
		configured: raw?.configured === true,
		calendarIds: Array.isArray(raw?.calendarIds) ? raw.calendarIds : DEFAULT_CONFIG.calendarIds,
		dedupe: typeof raw?.dedupe === "boolean" ? raw.dedupe : DEFAULT_CONFIG.dedupe,
		hideFree: typeof raw?.hideFree === "boolean" ? raw.hideFree : DEFAULT_CONFIG.hideFree,
		roomBaseUrl: typeof raw?.roomBaseUrl === "string" ? raw.roomBaseUrl : DEFAULT_CONFIG.roomBaseUrl,
		extraHosts: Array.isArray(raw?.extraHosts) ? raw.extraHosts : DEFAULT_CONFIG.extraHosts,
		sound: typeof raw?.sound === "boolean" ? raw.sound : DEFAULT_CONFIG.sound,
		soundName: typeof raw?.soundName === "string" && raw.soundName ? raw.soundName : DEFAULT_CONFIG.soundName,
		autoReturnSec:
			typeof raw?.autoReturnSec === "number" && raw.autoReturnSec >= 0
				? raw.autoReturnSec
				: DEFAULT_CONFIG.autoReturnSec,
		showRunning: typeof raw?.showRunning === "boolean" ? raw.showRunning : DEFAULT_CONFIG.showRunning,
	};
}

function clamp(n: number, lo: number, hi: number): number {
	return Math.max(lo, Math.min(hi, n));
}

@action({ UUID: "com.derpixler.next-meeting.dial" })
export class NextMeeting extends SingletonAction<Settings> {
	readonly #store: CalendarStore;
	#instances = new Map<string, Inst>();
	/** ONE timer for the whole class, not one per instance. */
	#tick?: NodeJS.Timeout;
	#lastPressAt = 0;
	/** Tunable at runtime via the `scroll=` deep link; see README. */
	#titleTiming: TitleTiming = { ...DEFAULT_TITLE_TIMING };
	#announced = new Set<string>();
	readonly #startedAt = Date.now();

	constructor(store: CalendarStore) {
		super();
		this.#store = store;
		this.#store.onChange(() => this.#renderAll());
	}

	/**
	 * Copies the pre-per-dial global settings onto every visible dial. Needed
	 * because a dial that had already written its own (defaulted) settings never
	 * reaches the adoption path in #ensureDefaultSelection.
	 */
	async adoptLegacySettings(): Promise<string> {
		const legacy = readConfig(await streamDeck.settings.getGlobalSettings<Partial<Config>>());
		if (!legacy.configured) return "no previous global settings to adopt";
		for (const inst of this.#instances.values()) {
			inst.cfg = { ...legacy };
			await inst.action.setSettings(inst.cfg);
			this.#store.setSelection(inst.action.id, legacy.calendarIds);
			this.#renderOne(inst, true);
		}
		return `adopted ${legacy.calendarIds.length} calendars onto ${this.#instances.size} dial(s)`;
	}

	/** What each dial is configured with, for the `dump` deep link. */
	describe(): string[] {
		return [...this.#instances.values()].map(
			(i) =>
				`  dial ${i.action.id.slice(0, 8)} calendars=${i.cfg.calendarIds.length || "all"} ` +
				`dedupe=${i.cfg.dedupe} hideFree=${i.cfg.hideFree} showRunning=${i.cfg.showRunning} ` +
				`sound=${i.cfg.sound ? i.cfg.soundName : "off"} autoReturn=${i.cfg.autoReturnSec}s`,
		);
	}

	/** Re-anchors every dial so the effect of a change is visible immediately. */
	setTitleTiming(timing: Partial<TitleTiming>): TitleTiming {
		this.#titleTiming = { ...this.#titleTiming, ...timing };
		const now = Date.now();
		for (const inst of this.#instances.values()) inst.marqueeAnchor = now;
		this.#renderAll();
		return this.#titleTiming;
	}

	override async onWillAppear(ev: WillAppearEvent<Settings>): Promise<void> {
		if (!ev.action.isDial()) return;
		const inst: Inst = {
			action: ev.action,
			cfg: readConfig(ev.payload.settings),
			pinnedEventId: null,
			index: 0,
			lastSent: null,
			lastSentAt: 0,
			flashUntil: 0,
			flashText: "",
			marqueeAnchor: Date.now(),
			marqueeFor: null,
		};
		this.#instances.set(ev.action.id, inst);
		streamDeck.logger.trace(`appear action=${ev.action.id} instances=${this.#instances.size}`);

		await ev.action.setFeedbackLayout("layouts/next-meeting.json");
		await ev.action.setTriggerDescription({ rotate: "Browse events", push: "Open meeting link" });

		this.#store.setSelection(ev.action.id, inst.cfg.calendarIds);
		this.#store.setVisible(true);
		this.#ensureTick();
		this.#renderOne(inst, true);
		// Encoder events and the first setFeedback can race the WebSocket
		// handshake after a cold boot (elgatosf/streamdeck#154).
		setTimeout(() => this.#renderOne(inst, true), 250);
		void this.#store.refresh("appear");
		void this.#ensureDefaultSelection(inst);
	}

	override onWillDisappear(ev: WillDisappearEvent<Settings>): void {
		const inst = this.#instances.get(ev.action.id);
		clearTimeout(inst?.returnTimer);
		clearTimeout(inst?.trailingTimer);
		this.#instances.delete(ev.action.id);
		this.#store.dropSelection(ev.action.id);
		if (this.#instances.size === 0) {
			clearTimeout(this.#tick);
			this.#tick = undefined;
			this.#store.setVisible(false);
		}
	}

	override onDialRotate(ev: DialRotateEvent<Settings>): void {
		const inst = this.#instances.get(ev.action.id) ?? this.#adopt(ev.action);
		const events = this.#viewFor(inst).events;
		streamDeck.logger.trace(
			`rotate ticks=${ev.payload.ticks} action=${ev.action.id} known=${this.#instances.size} events=${events.length}`,
		);
		if (events.length === 0) return;
		// Apply every tick rather than debouncing them away — travelling far on a
		// fast spin is exactly what a dial is for. The render is what gets throttled.
		const next = clamp(this.#resolveIndex(inst) + ev.payload.ticks, 0, events.length - 1);
		inst.index = next;
		inst.pinnedEventId = events[next]!.id;
		streamDeck.logger.trace(`rotate → index ${next} "${events[next]!.title}"`);
		this.#resetReturnTimer(inst);
		this.#renderOne(inst);
	}

	override onDialDown(_ev: DialDownEvent<Settings>): void {
		// Intentionally empty: acting on release keeps press-and-rotate and
		// long-press available as future gestures.
	}

	override async onDialUp(ev: DialUpEvent<Settings>): Promise<void> {
		const now = Date.now();
		if (now - this.#lastPressAt < PRESS_DEBOUNCE_MS) return;
		this.#lastPressAt = now;

		const inst = this.#instances.get(ev.action.id) ?? this.#adopt(ev.action);
		const state = this.#viewFor(inst);

		if (state.kind === "needs-consent") {
			const status = await this.#store.requestAccess();
			if (status === 3) await this.#ensureDefaultSelection(inst);
			return;
		}
		if (state.kind === "denied") {
			this.#open(PRIVACY_PANE);
			return;
		}
		if (state.kind === "error" && state.events.length === 0) {
			await this.#store.refresh("press");
			return;
		}
		if (state.events.length === 0) {
			await ev.action.showAlert();
			return;
		}

		// The one place staleness actively harms: opening a cancelled meeting's
		// room. Fail open if the refresh errors — a cached link beats nothing.
		if (Date.now() - state.lastProbeAt > PRESS_FRESHNESS_MS) {
			try {
				await this.#store.refresh("press");
			} catch {
				/* fall through to the cached link */
			}
		}

		const target = this.#viewFor(inst).events[this.#resolveIndex(inst)];
		if (!target) return;

		const link = pickMeetingLink(target, inst.cfg);
		if (link) {
			streamDeck.logger.info(`opening ${link.kind} link for "${target.title}"`);
			await streamDeck.system.openUrl(link.url);
			return;
		}

		streamDeck.logger.info(`no meeting link for "${target.title}" — opening Calendar.app`);
		this.#flash(inst, "Opening Calendar…");
		this.#openCalendar();
	}

	override onDidReceiveSettings(ev: DidReceiveSettingsEvent<Settings>): void {
		const inst = this.#instances.get(ev.action.id);
		if (!inst) return;
		inst.cfg = readConfig(ev.payload.settings);
		this.#store.setSelection(ev.action.id, inst.cfg.calendarIds);
		this.#renderOne(inst, true);
	}

	/**
	 * First run for this dial: an empty selection means "all calendars", which on
	 * a machine with delegated colleague calendars surfaces other people's
	 * meetings. Pick the user's own calendars so a freshly placed dial is useful
	 * straight away. Own = writable and not a delegated "Name (Name)" share.
	 */
	async #ensureDefaultSelection(inst: Inst): Promise<void> {
		if (inst.cfg.configured) return;

		// Settings used to be global. Adopt an existing configuration rather than
		// resetting a dial that was already set up before the move to per-dial
		// settings.
		const legacy = readConfig(await streamDeck.settings.getGlobalSettings<Partial<Config>>());
		if (legacy.configured) {
			streamDeck.logger.info(`adopting previous global settings for this dial (${legacy.calendarIds.length} calendars)`);
			inst.cfg = legacy;
			await inst.action.setSettings(inst.cfg);
			this.#store.setSelection(inst.action.id, legacy.calendarIds);
			this.#renderOne(inst, true);
			return;
		}

		const calendars = await this.#store.listCalendars();
		if (calendars.length === 0) return;
		const own = calendars.filter((c: CalendarInfo) => c.writable && !/\(/.test(c.name));
		const picked = (own.length > 0 ? own : calendars).map((c: CalendarInfo) => c.id);
		streamDeck.logger.info(`new dial: defaulting to ${picked.length} of ${calendars.length} calendars`);
		inst.cfg = { ...inst.cfg, configured: true, calendarIds: picked };
		await inst.action.setSettings(inst.cfg);
		this.#store.setSelection(inst.action.id, picked);
		this.#renderOne(inst, true);
	}

	override async onPropertyInspectorDidAppear(_ev: PropertyInspectorDidAppearEvent<Settings>): Promise<void> {
		await this.#sendCalendars();
	}

	override async onSendToPlugin(ev: SendToPluginEvent<JsonValue, Settings>): Promise<void> {
		const payload = ev.payload as { event?: string };
		switch (payload.event) {
			case "getCalendars":
				await this.#sendCalendars();
				break;
			case "requestAccess": {
				const status = await this.#store.requestAccess();
				const inst = this.#instances.get(ev.action.id);
				if (status === 3 && inst) await this.#ensureDefaultSelection(inst);
				await this.#sendCalendars();
				break;
			}
			case "openPrivacyPane":
				this.#open(PRIVACY_PANE);
				break;
			case "previewSound":
				this.#play(String((payload as { soundName?: unknown }).soundName ?? "Ping"));
				break;
		}
	}

	// ---------------------------------------------------------------- internals

	async #sendCalendars(): Promise<void> {
		const [calendars, state] = [await this.#store.listCalendars(), this.#store.getState()];
		await streamDeck.ui.sendToPropertyInspector({
			event: "calendars",
			calendars,
			authKind: state.kind,
		});
	}

	/** Covers a rotate arriving before onWillAppear registered the instance. */
	#adopt(dial: DialAction<Settings>): Inst {
		const inst: Inst = {
			action: dial,
			cfg: { ...DEFAULT_CONFIG },
			pinnedEventId: null,
			index: 0,
			lastSent: null,
			lastSentAt: 0,
			flashUntil: 0,
			flashText: "",
			marqueeAnchor: Date.now(),
			marqueeFor: null,
		};
		this.#instances.set(dial.id, inst);
		return inst;
	}

	/**
	 * One probe feeds every dial, so each dial filters the shared raw list with
	 * its own settings. Handing the renderer a state object with the filtered
	 * list keeps the renderer unaware that any of this is per instance.
	 */
	#viewFor(inst: Inst): CalendarState {
		const state = this.#store.getState();
		return { ...state, events: shapeEvents(state.events, inst.cfg, this.#store.now()) };
	}

	#resolveIndex(inst: Inst): number {
		const events = this.#viewFor(inst).events;
		if (!inst.pinnedEventId) return 0;
		const i = events.findIndex((e) => e.id === inst.pinnedEventId);
		return i >= 0 ? i : clamp(inst.index, 0, Math.max(0, events.length - 1));
	}

	/**
	 * Back to the next event after a while. Five seconds turned out to be far
	 * too short to read an entry and keep browsing — the display snapped back
	 * mid-look — so this is configurable, and 0 disables it entirely.
	 */
	#resetReturnTimer(inst: Inst): void {
		clearTimeout(inst.returnTimer);
		const seconds = inst.cfg.autoReturnSec;
		if (seconds <= 0) return;
		inst.returnTimer = setTimeout(() => {
			inst.pinnedEventId = null;
			inst.index = 0;
			this.#renderOne(inst);
		}, seconds * 1000);
		inst.returnTimer.unref?.();
	}

	#flash(inst: Inst, text: string): void {
		inst.flashUntil = Date.now() + FLASH_MS;
		inst.flashText = text;
		this.#renderOne(inst, true);
		setTimeout(() => this.#renderOne(inst, true), FLASH_MS + 50);
	}

	#ensureTick(): void {
		clearTimeout(this.#tick);
		if (this.#instances.size === 0) return;
		const now = Date.now();
		let delay = Number.POSITIVE_INFINITY;
		for (const inst of this.#instances.values()) {
			delay = Math.min(
				delay,
				tickInterval(
					this.#viewFor(inst),
					this.#resolveIndex(inst),
					this.#store.now(),
					now - inst.marqueeAnchor,
					this.#titleTiming,
				),
			);
		}
		if (!Number.isFinite(delay)) delay = 60_000;
		this.#tick = setTimeout(() => {
			this.#renderAll();
			this.#ensureTick();
		}, delay);
		this.#tick.unref?.();
	}

	#renderAll(): void {
		this.#announceStart();
		for (const inst of this.#instances.values()) this.#renderOne(inst);
		this.#ensureTick();
	}

	/**
	 * Chime once, when the next event starts. Deliberately tied to the event the
	 * dial is actually counting down to, not to whatever the user has rotated to.
	 */
	#announceStart(): void {
		for (const inst of this.#instances.values()) {
			if (!inst.cfg.sound) continue;

			const next = this.#viewFor(inst).events[0];
			if (!next) continue;
			const startMs = next.start * 1000;
			const since = Date.now() - startMs;
			if (since < 0 || since > ANNOUNCE_WINDOW_MS) continue;
			// Only a start we actually witnessed, or every restart during a
			// meeting would replay its sound.
			if (startMs < this.#startedAt) continue;
			// Class-wide, so two dials showing the same event chime once.
			if (this.#announced.has(next.id)) continue;

			this.#announced.add(next.id);
			if (this.#announced.size > 64) {
				this.#announced = new Set([...this.#announced].slice(-32));
			}
			this.#play(inst.cfg.soundName);
		}
	}

	#play(name: string): void {
		// Keep the name a bare file name: it comes from settings and is passed
		// to a process argument.
		const safe = /^[A-Za-z0-9 _-]{1,40}$/.test(name) ? name : "Ping";
		const file = `${SOUNDS_DIR}/${safe}.aiff`;
		execFile("/usr/bin/afplay", [file], (err) => {
			if (err) streamDeck.logger.error(`could not play ${file}`, err);
		});
	}

	/**
	 * Idempotent and diff-guarded, so the shared tick, the per-instance timers
	 * and store notifications can all funnel through it without contending.
	 */
	#renderOne(inst: Inst, force = false): void {
		const now = Date.now();
		const sinceLast = now - inst.lastSentAt;
		if (!force && sinceLast < MIN_RENDER_GAP_MS) {
			// Trailing edge: never lose the final position of a fast spin.
			clearTimeout(inst.trailingTimer);
			inst.trailingTimer = setTimeout(() => this.#renderOne(inst), MIN_RENDER_GAP_MS - sinceLast);
			inst.trailingTimer.unref?.();
			return;
		}

		const state = this.#viewFor(inst);
		const index = this.#resolveIndex(inst);
		const shownId = state.events[index]?.id ?? null;
		if (shownId !== inst.marqueeFor) {
			inst.marqueeFor = shownId;
			inst.marqueeAnchor = now;
		}
		const phase = now - inst.marqueeAnchor;
		const feedback =
			inst.flashUntil > now
				? {
						...buildFeedback(state, index, this.#store.now(), phase, this.#titleTiming),
						evtitle: { value: inst.flashText },
					}
				: buildFeedback(state, index, this.#store.now(), phase, this.#titleTiming);

		// setFeedbackLayout resets items to their layout defaults, so a forced
		// render must send everything; otherwise send only what changed.
		const payload = force ? feedback : feedbackDelta(feedback, inst.lastSent);
		if (Object.keys(payload).length === 0) return;
		inst.lastSent = feedback;
		inst.lastSentAt = now;
		void inst.action.setFeedback(payload);
	}

	#open(url: string): void {
		execFile("/usr/bin/open", [url], (err) => {
			if (err) streamDeck.logger.error(`open ${url} failed`, err);
		});
	}

	#openCalendar(): void {
		execFile("/usr/bin/open", ["-a", "Calendar"], (err) => {
			if (err) streamDeck.logger.error("opening Calendar.app failed", err);
		});
	}
}
