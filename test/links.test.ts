import assert from "node:assert/strict";
import { test } from "node:test";
import { DEFAULT_CONFIG, type Config } from "../src/calendar/store.js";
import { pickMeetingLink } from "../src/links.js";

const cfg = (over: Partial<Config> = {}): Config => ({ ...DEFAULT_CONFIG, ...over });

test("a real Teams invite yields the join link, not meeting options", () => {
	const urls = [
		"https://teams.microsoft.com/meet/370513034882643?p=IY58UsKkJ27DqovoNo",
		"https://aka.ms/JoinTeamsMeeting?omkt=en-GB",
		"https://teams.microsoft.com/l/meetup-join/19%3ameeting_abc",
		"https://teams.microsoft.com/meetingOptions/?organizerId=1",
	];
	const link = pickMeetingLink({ urls, location: "" }, cfg());
	assert.equal(link?.url, urls[0]);
	assert.equal(link?.kind, "join");
});

test("meeting options and help links are never chosen on their own", () => {
	const link = pickMeetingLink(
		{ urls: ["https://teams.microsoft.com/meetingOptions/?x=1", "https://aka.ms/JoinTeamsMeeting"], location: "" },
		cfg(),
	);
	assert.equal(link, null);
});

test("a self-hosted instance is recognised once its host is configured", () => {
	const ev = { urls: ["https://meet.example.com/DevDaily"], location: "" };
	assert.equal(pickMeetingLink(ev, cfg())?.kind, "notes", "unknown hosts only score as a notes link");
	assert.equal(pickMeetingLink(ev, cfg({ extraHosts: ["meet.example.com"] }))?.kind, "extra-host");
});

test("a bare room path becomes a join link via the room base URL", () => {
	const ev = { urls: [] as string[], location: "/DevDaily" };
	assert.equal(pickMeetingLink(ev, cfg()), null, "no base URL, no guess");
	const link = pickMeetingLink(ev, cfg({ roomBaseUrl: "https://meet.example.com/" }));
	assert.equal(link?.url, "https://meet.example.com/DevDaily");
	assert.equal(link?.kind, "room");
});

test("prose in the location field is not mistaken for a room", () => {
	const link = pickMeetingLink(
		{ urls: [], location: "Raum 3, zweiter Stock\nBitte pünktlich sein" },
		cfg({ roomBaseUrl: "https://meet.example.com" }),
	);
	assert.equal(link, null);
});

test("extra hosts outrank an unknown link found in the notes", () => {
	const link = pickMeetingLink(
		{ urls: ["https://wiki.example.com/page", "https://vc.example.org/room/7"], location: "" },
		cfg({ extraHosts: ["vc.example.org"] }),
	);
	assert.equal(link?.url, "https://vc.example.org/room/7");
	assert.equal(link?.kind, "extra-host");
});

test("a link in the location beats an unknown one in the notes", () => {
	const link = pickMeetingLink(
		{ urls: ["https://notes.example.com/a", "https://room.example.com/b"], location: "https://room.example.com/b" },
		cfg(),
	);
	assert.equal(link?.url, "https://room.example.com/b");
	assert.equal(link?.kind, "location");
});

test("attachments and calendar links are rejected", () => {
	for (const url of [
		"https://example.com/invite.ics",
		"https://calendar.google.com/event?eid=1",
		"https://github.com/elgatosf/streamdeck",
		"https://zoom.us/download",
	]) {
		assert.equal(pickMeetingLink({ urls: [url], location: "" }, cfg()), null, url);
	}
});

test("Google Meet needs its real code shape", () => {
	assert.ok(pickMeetingLink({ urls: ["https://meet.google.com/abc-defg-hij"], location: "" }, cfg()));
	assert.equal(pickMeetingLink({ urls: ["https://meet.google.com/landing"], location: "" }, cfg())?.kind, "notes");
});
