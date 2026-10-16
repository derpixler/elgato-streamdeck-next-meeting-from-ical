import type { FeedbackPayload } from "@elgato/streamdeck";
import type { CalendarState, MergedEvent } from "../calendar/store.js";

/** What setFeedback accepts for our layout's six keys. */
export type Feedback = FeedbackPayload;

const DIM = "#9aa0a8";
const MUTED = "#8a8f98";
const BAR_BG = "#2a2d33";
const BAR_GREY = "#55595f";

type Band = { text: string; fill: string };

const BAND_CALM: Band = { text: "#e6e9ef", fill: "#4a90d9" };
const BAND_SOON: Band = { text: "#ffd45e", fill: "#e8b23a" };
const BAND_NEAR: Band = { text: "#ff8c42", fill: "#ff8c42" };
const BAND_IMMINENT: Band = { text: "#ff5555", fill: "#ff5555" };
const BAND_RUNNING: Band = { text: "#5ad17a", fill: "#3a7d4e" };

/** Fixed horizon for the urgency curve: a working-day scale. */
const HORIZON_MS = 4 * 3600 * 1000;

/**
 * How long the backdrop stays lit after an event starts. Solid, not blinking —
 * a strobing 200×100 canvas is exactly the redraw pattern the strip shows as
 * flicker, and "it has started" does not need motion to be noticed.
 */
export const SIGNAL_MS = 2 * 60 * 1000;
const SIGNAL_FILL = "#b3261e";
const SIGNAL_BAR_BG = "#5e1410";

/**
 * The backdrop lights up for the first two minutes after an event starts. Only
 * for the event that is actually next — while browsing, a red canvas would say
 * "this is happening now" about something you are merely looking at.
 *
 * Only `enabled` is toggled: the image itself lives in the layout, because a raw
 * SVG string is rejected as a pixmap value ("invalid image or file not found")
 * and a rejected value fails the whole feedback update, freezing every cell.
 */
export function signalCanvas(msUntil: number, browsing: boolean, stale: boolean): { enabled: boolean } {
	const lit = !browsing && !stale && msUntil <= 0 && msUntil > -SIGNAL_MS;
	return { enabled: lit };
}

/** The evtitle cell, from layouts/next-meeting.json. */
const TITLE_WIDTH_PX = 192;
const TITLE_FONT_PX = 18;

/**
 * Long titles scroll: hold at the head, run to the end, hold, run back.
 *
 * The rate is deliberately tunable at runtime (see the `scroll=` deep link),
 * because how much the touch strip can take is not documented and not something
 * that can be judged from here. With per-cell updates a scrolling title changes
 * exactly one layout cell per frame, which is what makes this affordable at all.
 */
export type TitleTiming = {
	/** Pause at each end, in ms. */
	holdMs: number;
	/** Time per character step, in ms. */
	stepMs: number;
};

export const DEFAULT_TITLE_TIMING: TitleTiming = { holdMs: 2_500, stepMs: 180 };

/**
 * Approximate advance widths in em, calibrated against NSFont measurements of
 * the system font at 18px / weight 600 (the strip's actual font):
 * "Prompt Engineering Sync" → model 210px vs measured 212, 25×"W" → 428 vs 435,
 * "Sprint Review" → 118 vs 115. Good to a few percent, which is all the
 * character-stepping marquee needs.
 */
const EM_NARROW = 0.25; // i l I j . , : ; ' ! | space
const EM_THIN = 0.35; // r f t ( ) [ ] / \\ -
const EM_WIDE = 0.95; // W M m w @ %
const EM_UPPER = 0.7;
const EM_DEFAULT = 0.55;

function charEm(ch: string): number {
	if ("ilIj.,:;'!| ".includes(ch)) return EM_NARROW;
	if ("rft()[]/\\-".includes(ch)) return EM_THIN;
	if ("WMmw@%".includes(ch)) return EM_WIDE;
	if (ch >= "A" && ch <= "Z") return EM_UPPER;
	return EM_DEFAULT;
}

/** Estimated rendered width in pixels at the title's font size. */
export function textWidth(text: string, fontPx = TITLE_FONT_PX): number {
	let em = 0;
	for (const ch of text) em += charEm(ch);
	return em * fontPx;
}

export type TitleWindow = {
	/** The title sliced from the left; the layout clips the right edge. */
	text: string;
	/** Milliseconds until the slice changes, so the tick can stay lazy. */
	nextChangeMs: number;
};

/** How far left the title must travel before its end is fully visible. */
export function titleTravel(text: string, widthPx = TITLE_WIDTH_PX): number {
	if (textWidth(text) <= widthPx) return 0;
	let offset = 0;
	while (offset < text.length && textWidth(text.slice(offset)) > widthPx) offset++;
	return offset;
}

/**
 * Where a scrolling title sits at `phaseMs` into its cycle: hold at the head,
 * step to the end, hold, step back. Pure, so the caller owns the phase — the
 * action anchors it per dial and resets it when the shown event changes, so a
 * title always starts at its beginning.
 */
export function titleWindow(
	text: string,
	phaseMs: number,
	timing: TitleTiming = DEFAULT_TITLE_TIMING,
	widthPx = TITLE_WIDTH_PX,
): TitleWindow {
	const maxOffset = titleTravel(text, widthPx);
	if (maxOffset === 0) return { text, nextChangeMs: Number.POSITIVE_INFINITY };

	const { holdMs, stepMs } = timing;
	const travel = maxOffset * stepMs;
	const cycle = 2 * (holdMs + travel);
	const t = ((phaseMs % cycle) + cycle) % cycle;

	let offset: number;
	let nextChangeMs: number;
	if (t < holdMs) {
		offset = 0;
		nextChangeMs = holdMs - t;
	} else if (t < holdMs + travel) {
		const k = t - holdMs;
		offset = Math.floor(k / stepMs) + 1;
		nextChangeMs = stepMs - (k % stepMs);
	} else if (t < 2 * holdMs + travel) {
		offset = maxOffset;
		nextChangeMs = 2 * holdMs + travel - t;
	} else {
		const k = t - (2 * holdMs + travel);
		offset = maxOffset - (Math.floor(k / stepMs) + 1);
		nextChangeMs = stepMs - (k % stepMs);
	}

	return { text: text.slice(Math.max(0, Math.min(maxOffset, offset))), nextChangeMs };
}

/** Hides the bar and leaves the value cells empty. */
function barOff(): Feedback {
	return { urgency: { enabled: false } };
}

function message(ctx: string, title: string, opts: Partial<Feedback> = {}): Feedback {
	return {
		canvas: { enabled: false },
		ctx: { value: ctx, color: MUTED },
		page: { value: "" },
		evtitle: { value: title, color: "#ffffff" },
		countdown: { value: "" },
		clock: { value: "" },
		...barOff(),
		...opts,
	};
}

function clockLabel(epochSeconds: number, tz: string, withWeekday: boolean): string {
	try {
		return new Intl.DateTimeFormat("en-GB", {
			hour: "2-digit",
			minute: "2-digit",
			hour12: false,
			timeZone: tz,
			...(withWeekday ? { weekday: "short" } : {}),
		}).format(new Date(epochSeconds * 1000));
	} catch {
		return new Intl.DateTimeFormat("en-GB", { hour: "2-digit", minute: "2-digit", hour12: false }).format(
			new Date(epochSeconds * 1000),
		);
	}
}

/**
 * Countdown text. The left cell is ~110px at 24px, so roughly seven glyphs —
 * every branch below fits that.
 */
export function formatCountdown(msUntil: number, running: boolean, dayOffset: number): string {
	if (running) return "NOW";
	const mins = msUntil / 60_000;
	if (mins <= 10) {
		const total = Math.max(0, Math.round(msUntil / 1000));
		return `${Math.floor(total / 60)}:${String(total % 60).padStart(2, "0")}`;
	}
	if (mins < 60) return `${Math.round(mins)} min`;
	const hours = msUntil / 3_600_000;
	if (dayOffset === 1) return "tomorrow";
	if (dayOffset >= 2) return `in ${dayOffset} d`;
	let h = Math.floor(hours);
	let m = Math.round((hours - h) * 60);
	if (m === 60) {
		h += 1;
		m = 0;
	}
	return `${h}h ${m}m`;
}

/**
 * Urgency, not elapsed time. A literal now→start bar has no honest full scale,
 * and switching range by magnitude makes the fill jump at every boundary. This
 * curve is continuous and monotone: half full at an hour, three quarters at a
 * quarter of an hour, and never below a visible nub.
 */
export function urgencyFill(msUntil: number, running: boolean, startMs: number, endMs: number, now: number): number {
	if (running) {
		const span = Math.max(1, endMs - startMs);
		return Math.max(0, Math.min(100, (100 * (now - startMs)) / span));
	}
	return Math.max(3, 100 * (1 - Math.sqrt(Math.min(1, Math.max(0, msUntil) / HORIZON_MS))));
}

function band(msUntil: number, running: boolean): Band {
	if (running) return BAND_RUNNING;
	const mins = msUntil / 60_000;
	if (mins <= 2) return BAND_IMMINENT;
	if (mins <= 15) return BAND_NEAR;
	if (mins <= 60) return BAND_SOON;
	return BAND_CALM;
}

function titleFor(ev: MergedEvent): string {
	const prefix = ev.mergedCount > 1 ? `×${ev.mergedCount} ` : "";
	return `${prefix}${ev.calName}`.slice(0, 24);
}

/**
 * The whole render decision, pure: state plus a resolved index plus the clock
 * in, one setFeedback payload out. No I/O, so it unit-tests with a fake clock.
 */
export function buildFeedback(
	state: CalendarState,
	index: number,
	now: number,
	titlePhaseMs: number = now,
	timing: TitleTiming = DEFAULT_TITLE_TIMING,
): Feedback {
	switch (state.kind) {
		case "booting":
			return message("Calendar", "Loading…", { countdown: { value: "--", color: DIM } });
		case "needs-consent":
			return message("Calendar", "Press to allow access");
		case "requesting":
			return message("Calendar", "Approve in the dialog…", { countdown: { value: "…", color: DIM } });
		case "denied":
			return message("No access", "Calendar access denied", {
				ctx: { value: "No access", color: "#e8b23a" },
				clock: { value: "Settings →", color: MUTED },
			});
		case "no-calendars":
			return message("Calendar", "No calendars selected", {
				clock: { value: "Settings →", color: MUTED },
			});
		case "misconfigured":
			return message("Plugin error", "Script missing");
		case "empty":
			return message("Calendar", "No upcoming events", {
				clock: { value: state.widened ? "next 35 d" : "next 7 d", color: MUTED },
				urgency: { enabled: true, value: 0, bar_fill_c: BAR_GREY, bar_bg_c: BAR_BG },
			});
		case "error":
			if (state.events.length === 0) {
				return message("Calendar ⚠", "Calendar unavailable", {
					clock: { value: "retrying…", color: MUTED },
				});
			}
			break;
	}

	const ev = state.events[index];
	if (!ev) {
		return message("Calendar", "No upcoming events", {
			urgency: { enabled: true, value: 0, bar_fill_c: BAR_GREY, bar_bg_c: BAR_BG },
		});
	}

	const startMs = ev.start * 1000;
	const endMs = ev.end * 1000;
	const msUntil = startMs - now;
	const running = msUntil <= 0 && now < endMs;
	const dayOffset = Math.round((ev.dayStart - state.todayStart) / 86_400);
	const browsing = index > 0;

	// Paged away from the next event, force the calm palette: red must keep
	// meaning "your next thing is imminent", not "the thing you're browsing is".
	const colors = state.stale ? { text: DIM, fill: BAR_GREY } : browsing ? BAND_CALM : band(msUntil, running);

	const countdown = formatCountdown(msUntil, running, dayOffset);
	const clock = running
		? `→ ${clockLabel(ev.end, state.tz, false)}`
		: clockLabel(ev.start, state.tz, dayOffset >= 2);

	const signal = signalCanvas(msUntil, browsing, state.stale);

	return {
		canvas: signal,
		ctx: { value: `${titleFor(ev)}${state.stale ? " ⚠" : ""}`, color: signal.enabled ? "#f2d4d2" : MUTED },
		page: {
			value: browsing ? `${index + 1}/${state.events.length}` : "NEXT",
			color: MUTED,
		},
		evtitle: { value: titleWindow(ev.title, titlePhaseMs, timing).text, color: state.stale ? DIM : "#ffffff" },
		countdown: { value: countdown, color: signal.enabled ? "#ffffff" : colors.text },
		clock: { value: clock, color: signal.enabled ? "#f2d4d2" : state.stale ? DIM : "#c9ced6" },
		urgency: {
			enabled: true,
			value: Math.round(urgencyFill(msUntil, running, startMs, endMs, now)),
			bar_fill_c: signal.enabled ? SIGNAL_FILL : colors.fill,
			bar_bg_c: signal.enabled ? SIGNAL_BAR_BG : BAR_BG,
		},
	};
}

/**
 * How long until the rendered string could next change. Keeps a 1s tick cheap:
 * the payload diff suppresses most sends anyway, but there is no reason to wake
 * every second for a countdown reading "in 4 d".
 */
export function tickInterval(
	state: CalendarState,
	index: number,
	now: number,
	titlePhaseMs: number = now,
	timing: TitleTiming = DEFAULT_TITLE_TIMING,
): number {
	const ev = state.events[index];
	if (!ev) return 60_000;
	const msUntil = ev.start * 1000 - now;
	const running = msUntil <= 0 && now < ev.end * 1000;
	const countdown = running || msUntil <= 10 * 60_000
		? 1_000
		: msUntil <= 60 * 60_000
			? 15_000
			: msUntil <= 10 * 3600_000
				? 60_000
				: 300_000;
	// A scrolling title must not be held back by a slow countdown tick.
	const title = titleWindow(ev.title, titlePhaseMs, timing).nextChangeMs;
	// Nor must the backdrop stay lit past its window.
	// msUntil is negative once the event has started, so the remaining lit time
	// is SIGNAL_MS + msUntil.
	const signalEnds = msUntil <= 0 && msUntil > -SIGNAL_MS ? SIGNAL_MS + msUntil : Number.POSITIVE_INFINITY;
	return Math.max(40, Math.min(countdown, title, signalEnds));
}

/**
 * Only the cells that actually changed. Rewriting every key on each update made
 * the whole layout redraw, which the strip shows as a flicker.
 */
export function feedbackDelta(next: Feedback, prev: Feedback | null): Feedback {
	if (!prev) return next;
	const delta: Feedback = {};
	for (const [key, value] of Object.entries(next)) {
		if (JSON.stringify(value) !== JSON.stringify(prev[key])) delta[key] = value;
	}
	return delta;
}
