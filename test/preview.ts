/**
 * Dev preview: runs the real probe outside Stream Deck and prints what a dial
 * would show, so the whole pipeline can be checked without the hardware.
 *
 *   npm run preview            — a freshly placed dial (own calendars)
 *   npm run preview -- 5       — show the first 5 pages
 *   npm run preview -- 5 all   — every calendar, as an unconfigured dial sees it
 */
import { fileURLToPath } from "node:url";
import { CalendarStore, DEFAULT_CONFIG, shapeEvents, type Config } from "../src/calendar/store.js";
import { pickMeetingLink } from "../src/links.js";
import { buildFeedback } from "../src/render/strip.js";

const noop = () => {};
const logger = {
	error: (...a: unknown[]) => console.error("  [err]", ...a),
	warn: noop,
	info: (...a: unknown[]) => console.log("  [info]", ...a),
	debug: (...a: unknown[]) => console.log("  [dbg]", ...a),
	trace: noop,
	setLevel: () => logger,
	createScope: () => logger,
} as unknown as ConstructorParameters<typeof CalendarStore>[1];

const script = fileURLToPath(
	new URL("../../com.derpixler.next-meeting.sdPlugin/scripts/calendar.js", import.meta.url),
);
const pages = Number(process.argv[2] ?? 3);
const everything = process.argv[3] === "all";

const store = new CalendarStore(script, logger);
store.start();

// Mirror what a freshly placed dial does: own calendars only, unless asked for all.
const calendars = await store.listCalendars();
const own = calendars.filter((c) => c.writable && !/\(/.test(c.name));
const cfg: Config = {
	...DEFAULT_CONFIG,
	configured: true,
	calendarIds: everything ? [] : own.map((c) => c.id),
};

const t0 = Date.now();
store.setSelection("preview", cfg.calendarIds);
await store.refresh("start");
const state = store.getState();
const events = shapeEvents(state.events, cfg, Date.now());
const view = { ...state, events };

console.log(
	`\nprobe: ${Date.now() - t0}ms · kind=${state.kind} · tz=${state.tz} · ` +
		`calendars=${cfg.calendarIds.length || `all ${calendars.length}`} · ` +
		`events=${events.length} (of ${state.events.length} unfiltered)\n`,
);

const cell = (fb: Record<string, unknown>, key: string): string =>
	String((fb[key] as { value?: unknown })?.value ?? "");

for (let i = 0; i < Math.min(pages, Math.max(1, events.length)); i++) {
	const fb = buildFeedback(view, i, Date.now()) as Record<string, unknown>;
	const bar = Number((fb.urgency as { value?: number })?.value ?? 0);
	const filled = Math.round((bar / 100) * 24);
	console.log("┌──────────────────────────┐");
	console.log(`│ ${cell(fb, "ctx").padEnd(17).slice(0, 17)}${cell(fb, "page").padStart(7)} │`);
	console.log(`│ ${cell(fb, "evtitle").padEnd(24).slice(0, 24)} │`);
	console.log(`│ ${cell(fb, "countdown").padEnd(15).slice(0, 15)}${cell(fb, "clock").padStart(9)} │`);
	console.log(`│ ${"█".repeat(filled)}${"░".repeat(24 - filled)} │`);
	console.log(`└──────────────────────────┘  ${bar}% · ${String((fb.countdown as { color?: string })?.color)}`);
	const ev = events[i];
	if (ev) {
		const link = pickMeetingLink(ev, cfg);
		console.log(`   press → ${link ? `${link.kind}: ${link.url}` : "no link, opens Calendar.app"}`);
		if (ev.mergedCount > 1) console.log(`   (collapsed ${ev.mergedCount} copies across calendars)`);
	}
	console.log();
}
process.exit(0);
