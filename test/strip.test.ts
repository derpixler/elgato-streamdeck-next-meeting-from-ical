import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import { test } from "node:test";
import type { CalendarState, MergedEvent } from "../src/calendar/store.js";
import {
	buildFeedback,
	feedbackDelta,
	formatCountdown,
	textWidth,
	tickInterval,
	SIGNAL_MS,
	signalCanvas,
	titleTravel,
	titleWindow,
	urgencyFill,
} from "../src/render/strip.js";

const TZ = "Europe/Berlin";
/** 2026-10-16 09:00:00 Europe/Berlin */
const NOW = Date.UTC(2026, 9, 16, 7, 0, 0);
const TODAY_START = Math.round(Date.UTC(2026, 9, 15, 22, 0, 0) / 1000);

function ev(startOffsetSec: number, over: Partial<MergedEvent> = {}): MergedEvent {
	const start = Math.round(NOW / 1000) + startOffsetSec;
	return {
		id: `e${startOffsetSec}`,
		title: "Sprint Review",
		start,
		end: start + 1800,
		dayStart: TODAY_START,
		availability: 0,
		status: 1,
		calId: "c1",
		calName: "Global",
		location: "",
		urls: [],
		mergedCount: 1,
		...over,
	};
}

function state(events: MergedEvent[], over: Partial<CalendarState> = {}): CalendarState {
	return {
		kind: events.length ? "ready" : "empty",
		events,
		todayStart: TODAY_START,
		tz: TZ,
		stale: false,
		widened: false,
		lastProbeAt: NOW,
		...over,
	};
}

const val = (fb: Record<string, unknown>, key: string): string =>
	String((fb[key] as { value?: unknown }).value ?? "");
const col = (fb: Record<string, unknown>, key: string): string =>
	String((fb[key] as { color?: unknown }).color ?? "");

test("countdown formatting covers every magnitude", () => {
	assert.equal(formatCountdown(0, true, 0), "NOW");
	assert.equal(formatCountdown(598_000, false, 0), "9:58");
	assert.equal(formatCountdown(42 * 60_000, false, 0), "42 min");
	assert.equal(formatCountdown(3.34 * 3_600_000, false, 0), "3h 20m");
	assert.equal(formatCountdown(11.08 * 3_600_000, false, 0), "11h 5m");
	assert.equal(formatCountdown(20 * 3_600_000, false, 1), "tomorrow");
	assert.equal(formatCountdown(96 * 3_600_000, false, 4), "in 4 d");
});

test("countdown never exceeds the width of the left cell", () => {
	for (const ms of [0, 1_000, 59_000, 600_000, 3_599_000, 35_000_000, 400_000_000]) {
		for (const day of [0, 1, 3]) {
			assert.ok(formatCountdown(ms, false, day).length <= 9, `too wide: ${formatCountdown(ms, false, day)}`);
		}
	}
});

test("urgency curve is continuous, monotone and never empty-looking", () => {
	const at = (mins: number) => urgencyFill(mins * 60_000, false, 0, 0, NOW);
	assert.equal(Math.round(at(60)), 50, "half full at one hour");
	assert.equal(Math.round(at(15)), 75, "three quarters at a quarter hour");
	assert.equal(Math.round(at(240)), 3, "a visible nub at the horizon");
	assert.equal(Math.round(at(600)), 3, "clamped beyond the horizon");
	assert.equal(Math.round(at(0)), 100);

	let prev = -1;
	for (let m = 300; m >= 0; m--) {
		const v = at(m);
		assert.ok(v >= prev - 1e-9, `fill dipped at ${m} min`);
		prev = v;
	}
});

test("a running event switches the bar to elapsed progress", () => {
	const e = ev(-900); // started 15 min ago, 30 min long
	const fb = buildFeedback(state([e]), 0, NOW);
	assert.equal(val(fb, "countdown"), "NOW");
	assert.equal(val(fb, "clock"), "→ 09:15");
	assert.equal(Math.round(Number((fb.urgency as { value: number }).value)), 50);
});

test("colour escalates toward the event but stays calm while browsing", () => {
	const near = [ev(90), ev(7_200)];
	assert.equal(col(buildFeedback(state(near), 0, NOW), "countdown"), "#ff5555", "imminent is red");
	assert.equal(
		col(buildFeedback(state(near), 1, NOW), "countdown"),
		"#e6e9ef",
		"browsing must not borrow the urgent palette",
	);
	assert.equal(val(buildFeedback(state(near), 1, NOW), "page"), "2/2");
	assert.equal(val(buildFeedback(state(near), 0, NOW), "page"), "NEXT");
});

test("merged duplicates are surfaced in the context line", () => {
	const fb = buildFeedback(state([ev(600, { mergedCount: 8 })]), 0, NOW);
	assert.match(val(fb, "ctx"), /^×8 Global/);
});

test("a stale cache looks stale", () => {
	const fb = buildFeedback(state([ev(600)], { stale: true }), 0, NOW);
	assert.equal(col(fb, "evtitle"), "#9aa0a8");
	assert.match(val(fb, "ctx"), /⚠$/);
});

test("each permission and error state renders a readable message", () => {
	const cases: Array<[CalendarState["kind"], RegExp]> = [
		["booting", /Loading/],
		["needs-consent", /allow access/],
		["requesting", /Approve/],
		["denied", /denied/],
		["no-calendars", /No calendars selected/],
		["misconfigured", /Script missing/],
		["empty", /No upcoming events/],
	];
	for (const [kind, re] of cases) {
		const fb = buildFeedback(state([], { kind }), 0, NOW);
		assert.match(val(fb, "evtitle"), re, `state ${kind}`);
	}
	const errFb = buildFeedback(state([], { kind: "error" }), 0, NOW);
	assert.match(val(errFb, "evtitle"), /unavailable/);
});

test("an error with a warm cache keeps showing the cached event", () => {
	const fb = buildFeedback(state([ev(600)], { kind: "error", stale: true }), 0, NOW);
	assert.equal(val(fb, "evtitle"), "Sprint Review");
});

test("tick interval tracks the granularity actually on screen", () => {
	assert.equal(tickInterval(state([ev(120)]), 0, NOW), 1_000);
	assert.equal(tickInterval(state([ev(1_800)]), 0, NOW), 15_000);
	assert.equal(tickInterval(state([ev(4 * 3_600)]), 0, NOW), 60_000);
	assert.equal(tickInterval(state([ev(30 * 3_600)]), 0, NOW), 300_000);
	assert.equal(tickInterval(state([ev(-60)]), 0, NOW), 1_000, "running ticks every second");
});

test("weekday is only shown once the event is days away", () => {
	const todayFb = buildFeedback(state([ev(3_600)]), 0, NOW);
	assert.equal(val(todayFb, "clock"), "10:00");
	const later = ev(3 * 86_400, { dayStart: TODAY_START + 3 * 86_400 });
	assert.match(val(buildFeedback(state([later]), 0, NOW), "clock"), /^[A-Z][a-z]{2} \d{2}:\d{2}$/);
});

// --- long titles -----------------------------------------------------------

test("the width model tracks NSFont measurements within a few percent", () => {
	// Measured with NSFont.systemFontOfSize(18, weight: .semibold), the strip's font.
	const measured: Array<[string, number]> = [
		["Sprint Review", 115],
		["Prompt Engineering Sync", 212],
		["Weekly Sync - Support", 192],
		["Service API Clients Sync", 204],
		["Architecture Review with Platform", 285],
		["Release Planning 4 (Sprint 12)", 251],
		["WWWWWWWWWWWWWWWWWWWWWWWWW", 435],
		["iiiiiiiiiiiiiiiiiiiiiiiii", 111],
	];
	for (const [text, px] of measured) {
		const estimate = textWidth(text);
		const off = Math.abs(estimate - px) / px;
		assert.ok(
			off < 0.15,
			`"${text}": estimated ${Math.round(estimate)}px vs measured ${px}px (${Math.round(off * 100)}% off)`,
		);
	}
});

test("a title that fits is never scrolled", () => {
	assert.equal(titleTravel("Sprint Review"), 0);
	const w = titleWindow("Sprint Review", 0);
	assert.equal(w.text, "Sprint Review");
	assert.equal(w.nextChangeMs, Number.POSITIVE_INFINITY);
});

test("travel stops exactly where the end becomes visible", () => {
	for (const title of [
		"Architecture Review with Platform",
		"Release Planning 4 (Sprint 12)",
		"WWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWW",
		"a".repeat(120),
	]) {
		const offset = titleTravel(title);
		assert.ok(textWidth(title.slice(offset)) <= 192, `tail of "${title}" still overflows`);
		assert.ok(textWidth(title.slice(offset - 1)) > 192, `scrolls one character too far on "${title}"`);
	}
});

test("a long title holds, runs to the end, holds, and runs back", () => {
	const title = "Architecture Review with Platform";
	const timing = { holdMs: 2_500, stepMs: 180 };
	const at = (ms: number) => titleWindow(title, ms, timing).text;
	const travel = titleTravel(title) * timing.stepMs;

	assert.equal(at(0), title, "starts at the head");
	assert.equal(at(2_499), title, "held for the full hold");
	assert.notEqual(at(2_700), title, "then moves");
	assert.ok(at(2_500 + travel).endsWith("Platform"), "reaches the end");
	assert.equal(at(2_500 + travel + 1_000), at(2_500 + travel), "and holds there");
	assert.equal(at(2 * (2_500 + travel)), title, "a full cycle returns to the head");
});

test("the window is always a suffix and never scrolls past the end", () => {
	const title = "Architecture Review with Platform";
	const maxOffset = titleTravel(title);
	for (let ms = 0; ms < 30_000; ms += 37) {
		const { text } = titleWindow(title, ms);
		assert.ok(title.endsWith(text), "the window is a suffix of the title");
		assert.ok(text.length >= title.length - maxOffset, `scrolled too far at ${ms}ms`);
	}
});

test("the step rate is what drives how often the cell changes", () => {
	const title = "Architecture Review with Platform";
	const count = (stepMs: number) => {
		let changes = 0;
		let prev = titleWindow(title, 0, { holdMs: 2_500, stepMs }).text;
		for (let ms = 0; ms < 20_000; ms += 10) {
			const now = titleWindow(title, ms, { holdMs: 2_500, stepMs }).text;
			if (now !== prev) changes++;
			prev = now;
		}
		return changes;
	};
	assert.ok(count(180) < count(90), "a slower step changes the cell less often");
	assert.ok(count(1_000) < count(180));
});

test("nextChangeMs is lazy during the hold and frame-paced while moving", () => {
	const title = "Architecture Review with Platform";
	const timing = { holdMs: 2_500, stepMs: 180 };
	assert.ok(titleWindow(title, 0, timing).nextChangeMs > 2_000, "lazy during the hold");
	assert.ok(titleWindow(title, 2_700, timing).nextChangeMs <= 180, "paced to the step while moving");
});

test("the tick follows the title even when the countdown is slow", () => {
	const timing = { holdMs: 2_500, stepMs: 180 };
	const far = ev(30 * 3_600, { title: "Architecture Review with Platform" });
	assert.equal(tickInterval(state([far]), 0, NOW, 0, timing), 2_500, "waits out the hold, not 5 minutes");
	assert.ok(tickInterval(state([far]), 0, NOW, 2_700, timing) <= 180, "paced to the step once it moves");
	const short = ev(30 * 3_600, { title: "Sprint Review" });
	assert.equal(tickInterval(state([short]), 0, NOW, 0, timing), 300_000, "short titles keep the lazy tick");
});

test("a scrolling title changes exactly one layout cell per frame", () => {
	// This is what makes animation affordable: rewriting all six cells per frame
	// is what made the strip flicker.
	const far = ev(30 * 3_600, { title: "Architecture Review with Platform" });
	const timing = { holdMs: 2_500, stepMs: 180 };
	const st = state([far]);
	const a = buildFeedback(st, 0, NOW, 2_700, timing);
	const b = buildFeedback(st, 0, NOW, 2_700 + timing.stepMs, timing);
	assert.deepEqual(Object.keys(feedbackDelta(b, a)), ["evtitle"]);
});

test("only changed cells are sent, so the strip does not redraw wholesale", () => {
	const a = buildFeedback(state([ev(3_600)]), 0, NOW);
	const b = buildFeedback(state([ev(3_600)]), 0, NOW + 60_000);
	const delta = feedbackDelta(b, a);
	// A minute later only the countdown reads differently — the bar rounds to the
	// same percent, and the title, clock and context are untouched.
	assert.deepEqual(Object.keys(delta), ["countdown"]);
	assert.deepEqual(feedbackDelta(a, a), {}, "an unchanged render sends nothing");
	assert.deepEqual(feedbackDelta(a, null), a, "a forced render sends everything");
});

// --- the start signal -------------------------------------------------------

test("the backdrop lights up only in the window after the start", () => {
	assert.equal(signalCanvas(60_000, false, false).enabled, false, "not before the start");
	assert.equal(signalCanvas(1, false, false).enabled, false, "not one millisecond early");
	assert.equal(signalCanvas(0, false, false).enabled, true, "on at the start");
	assert.equal(signalCanvas(-SIGNAL_MS + 1, false, false).enabled, true, "still on just inside the window");
	assert.equal(signalCanvas(-SIGNAL_MS, false, false).enabled, false, "off once the window closes");
	assert.equal(signalCanvas(-10 * 60_000, false, false).enabled, false, "off well into the meeting");
});

test("the backdrop stays dark while browsing or stale", () => {
	assert.equal(signalCanvas(-1_000, true, false).enabled, false, "browsing is not 'happening now'");
	assert.equal(signalCanvas(-1_000, false, true).enabled, false, "a stale cache must not claim a start");
});

test("the lit backdrop matches the layout and cannot cover the bar", () => {
	// A pixmap is painted over a bar item whatever its zOrder, so the backdrop
	// must stop above the bar by geometry rather than by layering. Checked
	// against the real layout so the two cannot drift apart.
	const layout = JSON.parse(
		readFileSync(new URL("../../com.derpixler.next-meeting.sdPlugin/layouts/next-meeting.json", import.meta.url), "utf8"),
	) as { items: Array<{ key: string; rect: [number, number, number, number] }> };

	const canvas = layout.items.find((i) => i.key === "canvas")!;
	const bar = layout.items.find((i) => i.key === "urgency")!;
	const canvasBottom = canvas.rect[1] + canvas.rect[3];
	assert.ok(canvasBottom <= bar.rect[1], `backdrop reaches y=${canvasBottom}, bar starts at y=${bar.rect[1]}`);

	// The image lives in the layout and must actually exist: a pixmap value the
	// device cannot load fails the whole feedback update, which freezes every
	// cell on the strip rather than just dropping the backdrop.
	const withValue = canvas as unknown as { value: string };
	assert.ok(withValue.value, "the backdrop must reference an image");
	assert.ok(
		existsSync(new URL(`../../com.derpixler.next-meeting.sdPlugin/${withValue.value}`, import.meta.url)),
		`missing backdrop image: ${withValue.value}`,
	);
	// At runtime only `enabled` is sent, never an image value.
	assert.deepEqual(signalCanvas(-1_000, false, false), { enabled: true });
	assert.deepEqual(signalCanvas(60_000, false, false), { enabled: false });
});

test("a starting event lights the canvas and lifts the text off it", () => {
	const starting = ev(0);
	const fb = buildFeedback(state([starting]), 0, NOW);
	assert.equal((fb.canvas as { enabled: boolean }).enabled, true);
	assert.equal(col(fb, "countdown"), "#ffffff", "white reads on the signal colour");
	assert.equal(val(fb, "countdown"), "NOW");
});

test("every message state switches the canvas off", () => {
	for (const kind of ["booting", "needs-consent", "denied", "empty", "misconfigured"] as const) {
		const fb = buildFeedback(state([], { kind }), 0, NOW);
		assert.equal((fb.canvas as { enabled: boolean }).enabled, false, `state ${kind} left the canvas lit`);
	}
});

test("the tick clears the signal exactly when its window closes", () => {
	const justStarted = ev(-30); // 30s ago
	const delay = tickInterval(state([justStarted]), 0, NOW);
	assert.ok(delay <= 1_000, "the running countdown already ticks every second");
	// With a slow countdown the signal would still bound the tick.
	const near = ev(-119);
	assert.ok(tickInterval(state([near]), 0, NOW) <= SIGNAL_MS - 119_000 + 1_000);
});

test("hours carry instead of rendering sixty minutes", () => {
	// 3.999h used to render as "3h 60m".
	assert.equal(formatCountdown(4 * 3_600_000 - 1_000, false, 0), "4h 0m");
	assert.equal(formatCountdown(3.5 * 3_600_000, false, 0), "3h 30m");
	assert.equal(formatCountdown(9.995 * 3_600_000, false, 0), "10h 0m");
	for (let ms = 60 * 60_000; ms < 10 * 3_600_000; ms += 7_000) {
		assert.doesNotMatch(formatCountdown(ms, false, 0), /\b60m$/, `${ms}ms rendered sixty minutes`);
	}
});

test("the bar carries the signal colour instead of being covered by it", () => {
	const fb = buildFeedback(state([ev(-30)]), 0, NOW);
	const bar = fb.urgency as { enabled: boolean; value: number; bar_fill_c: string };
	assert.equal(bar.enabled, true, "the bar stays visible during the signal");
	assert.equal(bar.bar_fill_c, "#b3261e", "and takes the signal colour");
	assert.ok(bar.value > 0, "while still showing elapsed progress");
});
