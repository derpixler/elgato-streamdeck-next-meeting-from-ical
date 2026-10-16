import { execFile } from "node:child_process";
import { existsSync } from "node:fs";
import type { Logger } from "@elgato/utils/logging";

/** Raw event as emitted by scripts/calendar.js. All times are epoch SECONDS. */
export type RawEvent = {
	id: string;
	title: string;
	start: number;
	end: number;
	dayStart: number;
	availability: 0 | 1 | 2 | 3;
	status: 0 | 1 | 2;
	calId: string;
	calName: string;
	location: string;
	urls: string[];
};

/** An event after duplicate collapsing; `mergedCount` is 1 when nothing merged. */
export type MergedEvent = RawEvent & { mergedCount: number };

export type CalendarInfo = {
	id: string;
	name: string;
	source: string;
	writable: boolean;
};

/** EKAuthorizationStatus: 0 notDetermined, 1 restricted, 2 denied, 3 fullAccess, 4 writeOnly. */
export type AuthStatus = 0 | 1 | 2 | 3 | 4;

export type StateKind =
	| "booting"
	| "needs-consent"
	| "requesting"
	| "denied"
	| "ready"
	| "empty"
	| "no-calendars"
	| "error"
	| "misconfigured";

export type CalendarState = {
	kind: StateKind;
	events: MergedEvent[];
	/** Local midnight of the probe's "today", epoch seconds. */
	todayStart: number;
	tz: string;
	/** True when the last probe failed but we are still serving a warm cache. */
	stale: boolean;
	widened: boolean;
	lastProbeAt: number;
	error?: string;
};

export type Config = {
	/** False until the first run has picked a default selection. */
	configured: boolean;
	calendarIds: string[];
	dedupe: boolean;
	hideFree: boolean;
	roomBaseUrl: string;
	extraHosts: string[];
	/** Play a system sound when an event starts. */
	sound: boolean;
	/** A name from /System/Library/Sounds, without the extension. */
	soundName: string;
	/** Seconds the display stays on a browsed event; 0 never returns on its own. */
	autoReturnSec: number;
	/** Keep an event that is happening right now at the top of the list. */
	showRunning: boolean;
};

export const DEFAULT_CONFIG: Config = {
	configured: false,
	calendarIds: [],
	dedupe: true,
	hideFree: true,
	roomBaseUrl: "",
	extraHosts: [],
	sound: true,
	soundName: "Ping",
	autoReturnSec: 20,
	showRunning: true,
};

export type RefreshReason =
	| "start"
	| "appear"
	| "cadence"
	| "wake"
	| "midnight"
	| "boundary"
	| "press"
	| "settings"
	| "drift";

const OSASCRIPT = "/usr/bin/osascript";

const TIMEOUT_STATUS = 5_000;
const TIMEOUT_QUERY = 10_000;
/** Never kill the request child on a short timer — the TCC prompt belongs to tccd. */
const TIMEOUT_REQUEST = 300_000;

/** How long to wait for the user to answer the prompt, and how often to look. */
const REQUEST_BUDGET_MS = 180_000;
const REQUEST_POLL_MS = 1_500;

const CADENCE_IDLE = 120_000;
const CADENCE_NEAR = 30_000;
const CADENCE_EMPTY = 600_000;
/** Probe burst after start, because CalDAV accounts may not have synced yet. */
const STARTUP_BURST = [0, 5_000, 20_000, 30_000];
const NEAR_WINDOW_MS = 15 * 60 * 1000;
const BACKOFF = [5_000, 10_000, 30_000, 60_000];

/**
 * Turn a raw probe result into what the dial shows: drop what the settings
 * exclude, collapse the same meeting appearing on several calendars, and sort
 * chronologically. Pure, so the filtering rules are testable on their own.
 *
 * Duplicates are keyed on start time plus a normalised title, which collapses
 * "Sprint Review" x7 and "SprintReview" into one entry. It cannot collapse the
 * same meeting under genuinely different titles, and nothing could.
 *
 * The calendar filter matters here and not only in the query: one probe serves
 * every dial by asking for the union of their selections, so each dial has to
 * narrow the result to its own calendars or it would see the other dials'.
 */
export function shapeEvents(raw: RawEvent[], cfg: Config, now: number): MergedEvent[] {
	let kept = raw;
	if (cfg.calendarIds.length > 0) {
		const wanted = new Set(cfg.calendarIds);
		kept = kept.filter((e) => wanted.has(e.calId));
	}
	if (cfg.hideFree) kept = kept.filter((e) => e.availability !== 1);
	if (!cfg.showRunning) kept = kept.filter((e) => e.start * 1000 > now);

	if (!cfg.dedupe) {
		return kept.map((e) => ({ ...e, mergedCount: 1 })).sort((a, b) => a.start - b.start);
	}

	const byKey = new Map<string, MergedEvent>();
	for (const e of kept) {
		const key = `${e.start}|${e.title.toLowerCase().replace(/[^a-z0-9]+/g, "")}`;
		const hit = byKey.get(key);
		if (hit) hit.mergedCount += 1;
		else byKey.set(key, { ...e, mergedCount: 1 });
	}
	return [...byKey.values()].sort((a, b) => a.start - b.start);
}

type Probe = Record<string, unknown> & { ok?: unknown; mode?: unknown };

/**
 * Owns the EventKit child process: authorization state, the cache, the probe
 * cadence and duplicate collapsing. Deliberately one module — auth, cache and
 * cadence are a single state machine, and splitting them would only create
 * near-circular dependencies to express one switch.
 */
export class CalendarStore {
	readonly #scriptPath: string;
	readonly #log: Logger;
	/** Calendar ids per dial instance; the probe uses their union. */
	#selections = new Map<string, string[]>();
	#state: CalendarState = {
		kind: "booting",
		events: [],
		todayStart: 0,
		tz: "UTC",
		stale: false,
		widened: false,
		lastProbeAt: 0,
	};
	#listeners = new Set<() => void>();
	#timer?: NodeJS.Timeout;
	#midnightTimer?: NodeJS.Timeout;
	#boundaryTimer?: NodeJS.Timeout;
	#inFlight?: Promise<void>;
	#requesting = false;
	#fixture = false;
	#visible = false;
	#started = false;
	#burstIndex = 0;
	#backoffIndex = -1;
	/** Offset applied to every clock read; dev-only, driven by the deep-link harness. */
	#clockOffsetMs = 0;

	constructor(scriptPath: string, log: Logger) {
		this.#scriptPath = scriptPath;
		this.#log = log;
	}

	now(): number {
		return Date.now() + this.#clockOffsetMs;
	}

	setClockOffset(ms: number): void {
		this.#clockOffsetMs = ms;
		this.#log.info(`clock offset set to ${ms}ms`);
		this.#emit();
	}

	getState(): Readonly<CalendarState> {
		return this.#state;
	}

	/**
	 * Which calendars this dial wants. One probe serves every dial by querying
	 * the union, and each dial then filters the result for itself — otherwise
	 * two dials would mean two osascript processes on every cadence tick.
	 */
	setSelection(instanceId: string, calendarIds: string[]): void {
		const before = this.#unionKey();
		this.#selections.set(instanceId, calendarIds);
		if (this.#unionKey() !== before) void this.refresh("settings");
		else this.#emit();
	}

	dropSelection(instanceId: string): void {
		if (!this.#selections.delete(instanceId)) return;
		if (this.#selections.size > 0) void this.refresh("settings");
	}

	/** Empty means "every calendar", which is what an unconfigured dial gets. */
	#union(): string[] {
		const all = new Set<string>();
		for (const ids of this.#selections.values()) {
			if (ids.length === 0) return [];
			for (const id of ids) all.add(id);
		}
		return [...all];
	}

	#unionKey(): string {
		return this.#union().sort().join(",");
	}

	onChange(cb: () => void): { dispose(): void } {
		this.#listeners.add(cb);
		return { dispose: () => this.#listeners.delete(cb) };
	}

	/** Stops the probe cadence entirely when no dial is visible. */
	setVisible(visible: boolean): void {
		this.#visible = visible;
		if (!visible) {
			clearTimeout(this.#timer);
			this.#timer = undefined;
			return;
		}
		if (!this.#started) {
			this.#started = true;
			void this.refresh("start");
		}
		this.#schedule();
	}

	start(): void {
		if (!existsSync(this.#scriptPath)) {
			this.#log.error(`calendar script missing at ${this.#scriptPath}`);
			this.#set({ kind: "misconfigured", error: "script missing" });
			return;
		}
		this.#log.info(`calendar script: ${this.#scriptPath}`);
	}

	/** Coalesces concurrent callers onto one in-flight probe. */
	refresh(reason: RefreshReason): Promise<void> {
		if (this.#fixture) return Promise.resolve();
		if (this.#state.kind === "misconfigured") return Promise.resolve();
		if (this.#requesting) return Promise.resolve();
		if (this.#inFlight) return this.#inFlight;
		this.#inFlight = this.#probe(reason).finally(() => {
			this.#inFlight = undefined;
		});
		return this.#inFlight;
	}

	/**
	 * Raises the one TCC prompt this app ever gets, and reports what the user
	 * decided.
	 *
	 * `requestFullAccessToEventsWithCompletion:` does NOT reliably fire its
	 * completion block when the responsible parent is a GUI app — observed here
	 * as an osascript child spinning its run loop until the timeout while the
	 * grant had already landed in TCC. So the decision is detected by polling
	 * `authorizationStatusForEntityType`, which is instant and never prompts,
	 * and the request child is killed as soon as the user has answered.
	 */
	async requestAccess(): Promise<AuthStatus> {
		if (this.#requesting) return 0;

		// Already answered elsewhere (e.g. in System Settings)? Don't prompt.
		const pre = await this.#readStatus();
		if (pre !== 0) {
			await this.refresh("settings");
			return pre;
		}

		this.#requesting = true;
		this.#set({ kind: "requesting" });
		const child = this.#spawn("request", TIMEOUT_REQUEST);
		child.promise.catch(() => {
			/* killed or timed out; the poll below is what decides */
		});

		try {
			const deadline = Date.now() + REQUEST_BUDGET_MS;
			while (Date.now() < deadline) {
				await new Promise((r) => setTimeout(r, REQUEST_POLL_MS));
				const status = await this.#readStatus();
				if (status !== 0) {
					this.#log.info(`access request answered: status=${status}`);
					return status;
				}
			}
			this.#log.warn("access request not answered within the budget");
			return 0;
		} catch (err) {
			this.#log.error("access request failed", err);
			return 0;
		} finally {
			child.kill();
			this.#requesting = false;
			await this.refresh("settings");
		}
	}

	/** Instant and never prompts; returns 0 when it cannot be determined. */
	async #readStatus(): Promise<AuthStatus> {
		try {
			return Number((await this.#run("status", TIMEOUT_STATUS)).status) as AuthStatus;
		} catch (err) {
			this.#log.error("status probe failed", err);
			return 0;
		}
	}

	async listCalendars(): Promise<CalendarInfo[]> {
		try {
			const p = await this.#run("calendars", TIMEOUT_QUERY);
			if (p.ok !== true || !Array.isArray(p.calendars)) return [];
			return p.calendars as CalendarInfo[];
		} catch (err) {
			this.#log.error("listing calendars failed", err);
			return [];
		}
	}

	/**
	 * Dev-only: replace the state wholesale so the deep-link harness can test
	 * render paths. Freezes the probe cadence, otherwise the next probe would
	 * overwrite the fixture a second later. `releaseFixture()` resumes.
	 */
	injectState(state: Partial<CalendarState>): void {
		this.#fixture = true;
		this.#set(state);
	}

	/** Leaves fixture mode and goes back to live data. */
	async releaseFixture(): Promise<void> {
		this.#fixture = false;
		await this.refresh("settings");
	}

	// ---------------------------------------------------------------- internals

	async #probe(reason: RefreshReason): Promise<void> {
		try {
			const status = Number((await this.#run("status", TIMEOUT_STATUS)).status) as AuthStatus;
			if (status === 0) {
				this.#log.info("calendar access not yet granted — press the dial to request it");
				this.#set({ kind: "needs-consent", stale: false });
				return;
			}
			if (status !== 3) {
				this.#log.warn(`calendar access unavailable (EKAuthorizationStatus ${status})`);
				this.#set({ kind: "denied", stale: false });
				return;
			}

			const p = await this.#run("query", TIMEOUT_QUERY);
			if (p.ok !== true) {
				if (p.reason === "no-matching-calendars") {
					this.#set({ kind: "no-calendars", events: [], stale: false });
					return;
				}
				throw new Error(`probe rejected: ${String(p.reason ?? "unknown")}`);
			}
			if (!Array.isArray(p.events) || !Number.isFinite(Number(p.todayStart))) {
				throw new Error("probe payload malformed");
			}

			const raw = (p.events as RawEvent[]).filter(
				(e) => Number.isFinite(e.start) && Number.isFinite(e.end) && typeof e.id === "string",
			);
			const events = this.#shape(raw);
			this.#backoffIndex = -1;
			this.#set({
				kind: events.length === 0 ? "empty" : "ready",
				events,
				todayStart: Number(p.todayStart),
				tz: typeof p.tz === "string" ? p.tz : "UTC",
				widened: p.widened === true,
				stale: false,
				lastProbeAt: Date.now(),
				error: undefined,
			});
			this.#log.debug(`probe(${reason}): ${events.length} events, widened=${p.widened}`);
			this.#armMidnight();
			this.#armBoundary();
		} catch (err) {
			this.#onProbeError(err, reason);
		} finally {
			this.#schedule();
		}
	}

	#onProbeError(err: unknown, reason: RefreshReason): void {
		const code = (err as NodeJS.ErrnoException | undefined)?.code;
		if (code === "ENOENT") {
			this.#log.error(`osascript or script not found (${this.#scriptPath})`, err);
			this.#set({ kind: "misconfigured", error: "script missing" });
			return;
		}
		this.#backoffIndex = Math.min(this.#backoffIndex + 1, BACKOFF.length - 1);
		this.#log.error(`probe(${reason}) failed`, err);
		// A failed probe never clobbers a good cache.
		if (this.#state.events.length > 0) {
			this.#set({ stale: true, error: String(err) });
		} else {
			this.#set({ kind: "error", stale: true, error: String(err) });
		}
	}

	/**
	 * The store only sorts. Filtering and duplicate collapsing are per dial, so
	 * they happen where the settings live — see shapeEvents().
	 */
	#shape(raw: RawEvent[]): MergedEvent[] {
		return [...raw].map((e) => ({ ...e, mergedCount: 1 })).sort((a, b) => a.start - b.start);
	}

	#set(patch: Partial<CalendarState>): void {
		this.#state = { ...this.#state, ...patch };
		this.#emit();
	}

	#emit(): void {
		for (const cb of this.#listeners) {
			try {
				cb();
			} catch (err) {
				this.#log.error("state listener threw", err);
			}
		}
	}

	#schedule(): void {
		clearTimeout(this.#timer);
		this.#timer = undefined;
		if (!this.#visible || this.#state.kind === "misconfigured") return;
		this.#timer = setTimeout(() => void this.refresh("cadence"), this.#interval());
		this.#timer.unref?.();
	}

	#interval(): number {
		if (this.#backoffIndex >= 0) return BACKOFF[this.#backoffIndex]!;
		if (this.#burstIndex < STARTUP_BURST.length) return STARTUP_BURST[this.#burstIndex++]!;
		const { kind, events } = this.#state;
		if (kind === "empty" || kind === "no-calendars") return CADENCE_EMPTY;
		const next = events[0];
		if (!next) return CADENCE_EMPTY;
		const until = next.start * 1000 - this.now();
		return until <= NEAR_WINDOW_MS ? CADENCE_NEAR : CADENCE_IDLE;
	}

	/** The "tomorrow"/"in 3 d" labels go stale at local midnight. */
	#armMidnight(): void {
		clearTimeout(this.#midnightTimer);
		const nextMidnight = (this.#state.todayStart + 86_400) * 1000 + 2_000;
		const delay = nextMidnight - this.now();
		if (delay <= 0 || delay > 36 * 3600 * 1000) return;
		this.#midnightTimer = setTimeout(() => void this.refresh("midnight"), delay);
		this.#midnightTimer.unref?.();
	}

	/**
	 * An event becoming "running", or ending, changes the list without anything
	 * else happening — especially with showRunning off, where it must drop out
	 * the moment it starts. Wake up on those two instants instead of waiting for
	 * the cadence.
	 */
	#armBoundary(): void {
		clearTimeout(this.#boundaryTimer);
		const next = this.#state.events[0];
		if (!next) return;
		const now = this.now();
		const edges = [next.start * 1000 + 1_000, next.end * 1000 + 1_000].filter((t) => t > now);
		if (edges.length === 0) return;
		const delay = Math.min(...edges) - now;
		if (delay > 12 * 3600 * 1000) return;
		this.#boundaryTimer = setTimeout(() => void this.refresh("boundary"), delay);
		this.#boundaryTimer.unref?.();
	}

	#run(mode: string, timeout: number): Promise<Probe> {
		return this.#spawn(mode, timeout).promise;
	}

	#spawn(mode: string, timeout: number): { promise: Promise<Probe>; kill: () => void } {
		const env: NodeJS.ProcessEnv = { ...process.env, CALX_MODE: mode };
		if (mode === "query") {
			env.CALX_DAYS = "7";
			env.CALX_MAX = "60";
			const union = this.#union();
			if (union.length > 0) env.CALX_CALENDARS = union.join(",");
		}
		let child: ReturnType<typeof execFile> | undefined;
		const promise = new Promise<Probe>((resolve, reject) => {
			child = execFile(
				OSASCRIPT,
				["-l", "JavaScript", this.#scriptPath],
				{ env, timeout, maxBuffer: 8 * 1024 * 1024, killSignal: "SIGKILL" },
				(err, stdout, stderr) => {
					const out = stdout.trim();
					if (out === "") {
						// Empty stdout with non-empty stderr is the classic JXA syntax error.
						const detail = stderr.trim().slice(0, 500);
						reject(
							Object.assign(new Error(`osascript produced no output: ${detail || err?.message || "unknown"}`), {
								code: (err as NodeJS.ErrnoException | null)?.code,
							}),
						);
						return;
					}
					try {
						const parsed = JSON.parse(out) as Probe;
						if (typeof parsed !== "object" || parsed === null) throw new Error("not an object");
						resolve(parsed);
					} catch (parseErr) {
						reject(new Error(`unparsable probe output: ${String(parseErr)}`));
					}
				},
			);
		});
		return {
			promise,
			kill: () => {
				if (child && child.exitCode === null && !child.killed) child.kill("SIGKILL");
			},
		};
	}
}
