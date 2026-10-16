import assert from "node:assert/strict";
import { test } from "node:test";
import { DEFAULT_CONFIG, shapeEvents, type Config, type RawEvent } from "../src/calendar/store.js";

const NOW = Date.UTC(2026, 9, 16, 9, 0, 0);
const nowSec = Math.round(NOW / 1000);

function raw(startOffsetSec: number, over: Partial<RawEvent> = {}): RawEvent {
	const start = nowSec + startOffsetSec;
	return {
		id: `${startOffsetSec}-${over.calName ?? "Cal"}-${over.title ?? "Sprint Review"}`,
		title: "Sprint Review",
		start,
		end: start + 1800,
		dayStart: nowSec - (nowSec % 86_400),
		availability: 0,
		status: 1,
		calId: "c1",
		calName: "Cal",
		location: "",
		urls: [],
		...over,
	};
}

const cfg = (over: Partial<Config> = {}): Config => ({ ...DEFAULT_CONFIG, ...over });

test("events come back in chronological order", () => {
	const out = shapeEvents([raw(7_200, { title: "Later" }), raw(600, { title: "Sooner" })], cfg(), NOW);
	assert.deepEqual(
		out.map((e) => e.title),
		["Sooner", "Later"],
	);
});

test("the same meeting on many calendars collapses to one, counted", () => {
	const copies = ["Alice", "Bob", "Carol", "Dave"].map((calName) => raw(600, { calName }));
	copies.push(raw(600, { calName: "Dave2", title: "SprintReview" })); // same meeting, no space
	const out = shapeEvents(copies, cfg({ dedupe: true }), NOW);
	assert.equal(out.length, 1, "five copies become one entry");
	assert.equal(out[0]!.mergedCount, 5);
});

test("a different meeting at the same time is not collapsed into it", () => {
	const out = shapeEvents([raw(600), raw(600, { title: "Ops Daily", calName: "Global" })], cfg(), NOW);
	assert.equal(out.length, 2);
});

test("dedupe off keeps every copy", () => {
	const copies = ["A", "B", "C"].map((calName) => raw(600, { calName }));
	assert.equal(shapeEvents(copies, cfg({ dedupe: false }), NOW).length, 3);
});

test("events marked Free are dropped only while that filter is on", () => {
	const events = [raw(600), raw(1_200, { availability: 1, title: "Wirklich im Office" })];
	assert.equal(shapeEvents(events, cfg({ hideFree: true }), NOW).length, 1);
	assert.equal(shapeEvents(events, cfg({ hideFree: false }), NOW).length, 2);
});

test("showRunning decides whether a meeting in progress stays in the list", () => {
	const events = [raw(-600, { title: "Ops Daily" }), raw(1_800, { title: "Sprint Review" })];

	const shown = shapeEvents(events, cfg({ showRunning: true }), NOW);
	assert.equal(shown.length, 2);
	assert.equal(shown[0]!.title, "Ops Daily", "a running event sorts first, so the dial leads with it");

	const hidden = shapeEvents(events, cfg({ showRunning: false }), NOW);
	assert.equal(hidden.length, 1);
	assert.equal(hidden[0]!.title, "Sprint Review", "otherwise the dial counts down to what has not started");
});

test("hiding running events drops one exactly at its start, not before", () => {
	const justBefore = shapeEvents([raw(1)], cfg({ showRunning: false }), NOW);
	assert.equal(justBefore.length, 1, "a second before the start it is still upcoming");
	const atStart = shapeEvents([raw(0)], cfg({ showRunning: false }), NOW);
	assert.equal(atStart.length, 0, "at the start it is running and drops out");
});

test("an already finished event is never resurrected by the running filter", () => {
	// The probe window begins at now, so a finished event should not be present
	// at all; if one slips through, hiding running events must still drop it.
	const done = raw(-7_200);
	assert.equal(shapeEvents([done], cfg({ showRunning: false }), NOW).length, 0);
});

test("each dial sees only its own calendars, not the shared union", () => {
	// One probe serves every dial by querying the union of their selections, so
	// the per-dial narrowing has to happen here. Without it a second dial
	// silently showed the first dial's meetings.
	const union = [
		raw(600, { calId: "work", title: "Sprint Review" }),
		raw(1_200, { calId: "private", title: "Zahnarzt" }),
		raw(1_800, { calId: "colleague", title: "Ops Daily" }),
	];

	const work = shapeEvents(union, cfg({ calendarIds: ["work"] }), NOW);
	assert.deepEqual(
		work.map((e) => e.title),
		["Sprint Review"],
	);

	const personal = shapeEvents(union, cfg({ calendarIds: ["private"] }), NOW);
	assert.deepEqual(
		personal.map((e) => e.title),
		["Zahnarzt"],
	);

	const both = shapeEvents(union, cfg({ calendarIds: ["work", "colleague"] }), NOW);
	assert.equal(both.length, 2);

	const unconfigured = shapeEvents(union, cfg({ calendarIds: [] }), NOW);
	assert.equal(unconfigured.length, 3, "an empty selection still means every calendar");
});

test("duplicates only collapse within the calendars a dial actually selected", () => {
	const union = [
		raw(600, { calId: "work", calName: "Work" }),
		raw(600, { calId: "colleague", calName: "Colleague" }),
	];
	assert.equal(shapeEvents(union, cfg({ calendarIds: ["work"] }), NOW)[0]!.mergedCount, 1);
	assert.equal(shapeEvents(union, cfg({ calendarIds: ["work", "colleague"] }), NOW)[0]!.mergedCount, 2);
});
