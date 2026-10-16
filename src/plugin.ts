import streamDeck from "@elgato/streamdeck";
import { fileURLToPath } from "node:url";
import { NextMeeting } from "./actions/next-meeting.js";
import { CalendarStore } from "./calendar/store.js";

streamDeck.logger.setLevel("debug");

// Resolve the JXA out of the plugin bundle, not out of cwd. rollup writes
// bin/plugin.js next to a package.json, so import.meta.url is valid here.
const scriptPath = fileURLToPath(new URL("../scripts/calendar.js", import.meta.url));

const store = new CalendarStore(scriptPath, streamDeck.logger);
store.start();

const nextMeeting = new NextMeeting(store);
streamDeck.actions.registerAction(nextMeeting);

// The authoritative wake signal: a timer that fired late or early renders
// correct values either way, but the cache still needs a forced probe.
streamDeck.system.onSystemDidWakeUp(() => {
	streamDeck.logger.info("system woke up — forcing a probe");
	void store.refresh("wake");
});

/**
 * Dev harness. One-way deep links need no registration, so every render state
 * is a one-command check on real hardware:
 *   open "streamdeck://plugins/message/com.derpixler.next-meeting/fixture=imminent"
 */
streamDeck.system.onDidReceiveDeepLink((ev) => {
	const [key, value] = ev.url.path.replace(/^\//, "").split("=");
	streamDeck.logger.info(`deep link: ${key}=${value}`);
	if (key === "clock" && value) {
		const m = /^([+-])(\d{2}):(\d{2}):(\d{2})$/.exec(value);
		if (m) {
			const sign = m[1] === "-" ? -1 : 1;
			const ms = (Number(m[2]) * 3600 + Number(m[3]) * 60 + Number(m[4])) * 1000;
			store.setClockOffset(sign * ms);
		} else if (value === "reset") {
			store.setClockOffset(0);
		}
		return;
	}
	if (key === "dump") {
		// What the dial is actually working with, including which events are
		// already running — the single most useful thing when the order on the
		// strip is not what was expected.
		const st = store.getState();
		const now = Date.now();
		streamDeck.logger.info(`state=${st.kind} tz=${st.tz} events=${st.events.length} (unfiltered union)`);
		for (const line of nextMeeting.describe()) streamDeck.logger.info(line);
		st.events.slice(0, 12).forEach((e, i) => {
			const startsIn = Math.round((e.start * 1000 - now) / 60_000);
			const running = e.start * 1000 <= now && now < e.end * 1000;
			const clock = new Intl.DateTimeFormat("en-GB", {
				hour: "2-digit",
				minute: "2-digit",
				hour12: false,
				timeZone: st.tz,
			}).format(new Date(e.start * 1000));
			streamDeck.logger.info(
				`  [${i}] ${clock} ${running ? "RUNNING" : `in ${startsIn}min`} ×${e.mergedCount} "${e.title}" (${e.calName})`,
			);
		});
		return;
	}
	if (key === "migrate") {
		void nextMeeting.adoptLegacySettings().then((msg) => streamDeck.logger.info(msg));
		return;
	}
	if (key === "fixture" && value) applyFixture(value);
	if (key === "scroll" && value) {
		// scroll=<stepMs> or scroll=<stepMs>,<holdMs>; tune on the hardware
		// without a rebuild, since how fast the strip can redraw is not
		// documented and cannot be judged from the build machine.
		const [stepMs, holdMs] = value.split(",").map(Number);
		const timing = nextMeeting.setTitleTiming({
			...(Number.isFinite(stepMs) && stepMs > 0 ? { stepMs } : {}),
			...(Number.isFinite(holdMs) && holdMs >= 0 ? { holdMs } : {}),
		});
		streamDeck.logger.info(`title scroll: step=${timing.stepMs}ms hold=${timing.holdMs}ms`);
	}
});

function applyFixture(name: string): void {
	const nowSec = Math.round(Date.now() / 1000);
	const todayStart = nowSec - (nowSec % 86_400);
	const fake = (offsetSec: number, title: string, mergedCount = 1) => ({
		id: `fixture-${offsetSec}`,
		title,
		start: nowSec + offsetSec,
		end: nowSec + offsetSec + 1800,
		dayStart: todayStart,
		availability: 0 as const,
		status: 1 as const,
		calId: "fixture",
		calName: "Fixture",
		location: "/TestRoom",
		urls: [],
		mergedCount,
	});

	switch (name) {
		case "imminent":
			store.injectState({
				kind: "ready",
				stale: false,
				tz: "Europe/Berlin",
				todayStart,
				lastProbeAt: Date.now(),
				events: [fake(270, "Sprint Review", 8), fake(7_200, "1:1 mit Team"), fake(90_000, "WebMontag")],
			});
			break;
		case "starting":
			store.injectState({
				kind: "ready",
				stale: false,
				tz: "Europe/Berlin",
				todayStart,
				lastProbeAt: Date.now(),
				events: [fake(-5, "Sprint Review", 8), fake(3_600, "1:1 mit Team")],
			});
			break;
		case "running":
			store.injectState({
				kind: "ready",
				stale: false,
				tz: "Europe/Berlin",
				todayStart,
				lastProbeAt: Date.now(),
				events: [fake(-600, "Ops Daily"), fake(5_400, "Refinement")],
			});
			break;
		case "empty":
			store.injectState({ kind: "empty", events: [], stale: false, widened: true });
			break;
		case "denied":
			store.injectState({ kind: "denied", events: [], stale: false });
			break;
		case "consent":
			store.injectState({ kind: "needs-consent", events: [], stale: false });
			break;
		case "probe-error":
			store.injectState({ kind: "error", events: [], stale: true, error: "fixture" });
			break;
		case "stale":
			store.injectState({
				kind: "ready",
				stale: true,
				tz: "Europe/Berlin",
				todayStart,
				lastProbeAt: Date.now() - 600_000,
				events: [fake(1_500, "Sprint Review", 8)],
			});
			break;
		case "live":
			void store.releaseFixture();
			break;
	}
}

await streamDeck.connect();
