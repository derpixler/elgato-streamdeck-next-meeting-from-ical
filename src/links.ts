import type { Config, RawEvent } from "./calendar/store.js";

export type MeetingLink = {
	url: string;
	/** Where the link came from, for logging and for the "no link" decision. */
	kind: "join" | "extra-host" | "location" | "notes" | "room";
};

/** Applied first — these are never a join link. */
const DENY: RegExp[] = [
	/^https?:\/\/aka\.ms\//i,
	/^https?:\/\/(support|learn)\.(google|microsoft)\.com\//i,
	/^https?:\/\/teams\.microsoft\.com\/meetingOptions/i,
	/^https?:\/\/[\w.-]*zoom\.us\/(download|signin|profile)/i,
	/^https?:\/\/tel\.meet\//i,
	/^https?:\/\/(calendar\.google\.com|github\.com)\//i,
	/\.(ics|pdf|png|jpe?g|docx?)(\?|$)/i,
];

/**
 * Tier 1 — confident join links, score 100. Order within the tier breaks ties,
 * so Teams /meet/ outranks Teams /l/meetup-join/.
 *
 * Self-hosted instances cannot be guessed from a URL — a company Jitsi at
 * meet.example.com looks like any other link. Those belong in the `extraHosts`
 * setting, which scores 80 and so outranks anything merely found in the notes.
 */
const JOIN: RegExp[] = [
	/^https?:\/\/[\w.-]*\.?zoom\.(us|com)\/(j|w|s|my)\//i,
	/^https?:\/\/teams\.microsoft\.com\/(meet|l\/meetup-join|dl\/launcher)\//i,
	/^https?:\/\/teams\.live\.com\/meet\//i,
	/^https?:\/\/meet\.google\.com\/[a-z]{3}-[a-z]{4}-[a-z]{3}/i,
	/^https?:\/\/[\w.-]+\.webex\.com\/(meet|join|[\w.-]+\/j\.php)/i,
	/^https?:\/\/meet\.opentalk\.eu\/.+/i,
	/^https?:\/\/(meet\.jit\.si|jitsi\.[\w.-]+)\/.+/i,
	/^https?:\/\/whereby\.com\/.+/i,
	/^https?:\/\/[\w.-]*\.?(gotomeeting|gotomeet)\.(com|me)\//i,
	/^https?:\/\/[\w.-]*\.?(bluejeans\.com|chime\.aws)\//i,
	/^https?:\/\/app\.livestorm\.co\/[^/]+\/.+/i,
];

/** A bare Jitsi room path with no host, e.g. "/DevDaily". */
const BARE_ROOM = /^\/[A-Za-z0-9_-]{2,}$/;

function hostOf(url: string): string {
	try {
		return new URL(url).hostname.toLowerCase();
	} catch {
		return "";
	}
}

/**
 * Scoring, not first-match: a single Teams invite's notes contain three
 * teams.microsoft.com URLs and /meetingOptions/ comes before the real one.
 */
export function pickMeetingLink(ev: Pick<RawEvent, "urls" | "location">, cfg: Config): MeetingLink | null {
	const extras = cfg.extraHosts.map((h) => h.trim().toLowerCase()).filter(Boolean);
	const inLocation = new Set(ev.location.match(/https?:\/\/[^\s<>"')\]]+/gi) ?? []);

	type Candidate = { url: string; kind: MeetingLink["kind"]; score: number; rank: number };
	let best: Candidate | null = null;

	for (const [position, url] of ev.urls.entries()) {
		if (DENY.some((re) => re.test(url))) continue;

		const joinRank = JOIN.findIndex((re) => re.test(url));
		let score: number;
		let kind: MeetingLink["kind"];
		if (joinRank >= 0) {
			score = 100;
			kind = "join";
		} else if (extras.includes(hostOf(url))) {
			score = 80;
			kind = "extra-host";
		} else if (inLocation.has(url)) {
			score = 40;
			kind = "location";
		} else {
			score = 10;
			kind = "notes";
		}

		// Tie-break: tier order first, then location over notes, then position.
		const rank = (joinRank >= 0 ? joinRank : 99) * 1000 + (inLocation.has(url) ? 0 : 100) + position;
		if (!best || score > best.score || (score === best.score && rank < best.rank)) {
			best = { url, kind, score, rank };
		}
	}

	if (best) return { url: best.url, kind: best.kind };

	// The bare-room rule: location is just "/DevDaily" and there is no URL
	// anywhere in the event. One setting turns those into one-press joins.
	const loc = ev.location.trim();
	if (cfg.roomBaseUrl && BARE_ROOM.test(loc)) {
		return { url: cfg.roomBaseUrl.replace(/\/+$/, "") + loc, kind: "room" };
	}

	return null;
}
