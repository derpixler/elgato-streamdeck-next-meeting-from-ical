// EventKit probe for the Next Meeting Stream Deck plugin.
//
// Run standalone:
//   CALX_MODE=query CALX_DAYS=7 osascript -l JavaScript scripts/calendar.js | jq
//
// Three JXA traps this file works around, each of which silently yields an
// empty-but-"working" plugin:
//   1. console.log() writes to STDERR in JXA, so the payload goes out through
//      NSFileHandle instead.
//   2. osascript appends the last expression's value to stdout, so the file
//      ends in `undefined;`.
//   3. ObjC integers serialise as strings ("67", "0"), so every one is Number()ed.
ObjC.import("EventKit");
ObjC.import("Foundation");

var ENV = $.NSProcessInfo.processInfo.environment;

function env(key, fallback) {
	var v = ENV.objectForKey(key);
	return v.isNil() ? fallback : String(ObjC.unwrap(v));
}

function emit(obj) {
	var s = JSON.stringify(obj);
	var data = $.NSString.alloc.initWithUTF8String(s).dataUsingEncoding($.NSUTF8StringEncoding);
	$.NSFileHandle.fileHandleWithStandardOutput.writeData(data);
}

// Every ObjC object may be nil, and unwrapping a nil throws.
function str(v) {
	try {
		if (v === undefined || v === null) return null;
		if (typeof v.isNil === "function" && v.isNil()) return null;
		var r = ObjC.unwrap(v);
		if (r === null || r === undefined) return null;
		return typeof r === "string" ? r : String(r);
	} catch (e) {
		return null;
	}
}

var URL_RE = new RegExp("https?://[^\\s<>\\x22\\x27)\\]]+", "gi");

function harvestUrls(blob) {
	var m = blob.match(URL_RE);
	if (!m) return [];
	var seen = {}, out = [];
	for (var i = 0; i < m.length; i++) {
		var u = m[i].replace(/[.,;:!?>]+$/, ""); // trailing punctuation and <url> wrappers
		if (u.length > 600) continue;
		if (!seen[u]) {
			seen[u] = 1;
			out.push(u);
		}
		if (out.length >= 10) break;
	}
	return out;
}

function main() {
	var mode = env("CALX_MODE", "query");
	var status = Number($.EKEventStore.authorizationStatusForEntityType(0));

	// --- status: never prompts, always instant ------------------------------
	if (mode === "status") {
		emit({ ok: true, mode: "status", status: status });
		return;
	}

	// --- request: WILL block on the TCC dialog ------------------------------
	if (mode === "request") {
		var done = false, granted = false, errMsg = null;
		var s0 = $.EKEventStore.alloc.init;
		s0.requestFullAccessToEventsWithCompletion(function (g, err) {
			granted = g === true || String(g) === "true";
			if (err && !err.isNil()) errMsg = str(err.localizedDescription);
			done = true;
		});
		// Without pumping the run loop the completion block never fires.
		var waited = 0, limit = Number(env("CALX_REQUEST_TIMEOUT", "300"));
		while (!done && waited < limit) {
			$.NSRunLoop.currentRunLoop.runUntilDate($.NSDate.dateWithTimeIntervalSinceNow(0.05));
			waited += 0.05;
		}
		emit({
			ok: done,
			mode: "request",
			granted: granted,
			timedOut: !done,
			error: errMsg,
			status: Number($.EKEventStore.authorizationStatusForEntityType(0)),
		});
		return;
	}

	// --- calendars: for the Property Inspector ------------------------------
	if (mode === "calendars") {
		if (status !== 3) {
			emit({ ok: false, mode: "calendars", status: status, reason: "not-authorized" });
			return;
		}
		var st1 = $.EKEventStore.alloc.init;
		var all = st1.calendarsForEntityType(0), N = Number(all.count), list = [];
		for (var c = 0; c < N; c++) {
			var k = all.objectAtIndex(c);
			list.push({
				id: str(k.calendarIdentifier),
				name: str(k.title),
				source: str(k.source.title),
				writable: k.allowsContentModifications === true,
			});
		}
		emit({ ok: true, mode: "calendars", status: status, calendars: list });
		return;
	}

	// --- query --------------------------------------------------------------
	if (status !== 3) {
		emit({ ok: false, mode: "query", status: status, reason: "not-authorized" });
		return;
	}

	var store = $.EKEventStore.alloc.init;
	var nscal = $.NSCalendar.currentCalendar;
	var todayStart = nscal.startOfDayForDate($.NSDate.date);

	// NOTE: $([]) behaves identically to $() (= ALL calendars), so an empty
	// selection must be rejected explicitly and never passed through.
	var cals = $();
	var wanted = env("CALX_CALENDARS", "");
	if (wanted !== "") {
		var want = {};
		wanted.split(",").forEach(function (id) {
			if (id) want[id] = 1;
		});
		var allC = store.calendarsForEntityType(0), NC = Number(allC.count), keep = [];
		for (var ci = 0; ci < NC; ci++) {
			var kc = allC.objectAtIndex(ci);
			if (want[str(kc.calendarIdentifier)]) keep.push(kc);
		}
		if (keep.length === 0) {
			emit({ ok: false, mode: "query", status: status, reason: "no-matching-calendars" });
			return;
		}
		cals = $(keep);
	}

	var MAX = Number(env("CALX_MAX", "40"));

	function collect(days) {
		var pred = store.predicateForEventsWithStartDateEndDateCalendars(
			$.NSDate.date,
			$.NSDate.dateWithTimeIntervalSinceNow(86400 * days),
			cals
		);
		var evs = store.eventsMatchingPredicate(pred).sortedArrayUsingSelector("compareStartDateWithEvent:");
		var n = Number(evs.count), out = [];
		for (var i = 0; i < n && out.length < MAX; i++) {
			var e = evs.objectAtIndex(i);
			if (e.isAllDay === true) continue; // no sensible countdown for all-day entries
			var st = Number(e.status);
			if (st === 3) continue; // EKEventStatusCanceled
			var sd = e.startDate, ed = e.endDate;
			if (sd.isNil() || ed.isNil()) continue;
			var loc = str(e.location) || "";
			var notes = str(e.notes) || "";
			var evUrl = e.URL.isNil() ? "" : str(e.URL.absoluteString) || "";
			out.push({
				id: str(e.eventIdentifier),
				title: (str(e.title) || "(no title)").slice(0, 120),
				start: Math.round(sd.timeIntervalSince1970),
				end: Math.round(ed.timeIntervalSince1970),
				dayStart: Math.round(nscal.startOfDayForDate(sd).timeIntervalSince1970),
				availability: Number(e.availability), // 0 busy, 1 free, 2 tentative, 3 unavailable
				status: st, // 0 none, 1 confirmed, 2 tentative
				calId: str(e.calendar.calendarIdentifier),
				calName: str(e.calendar.title),
				location: loc.slice(0, 200),
				urls: harvestUrls(evUrl + " \n " + loc + " \n " + notes),
			});
		}
		return out;
	}

	var days = Number(env("CALX_DAYS", "7"));
	var events = collect(days);
	var widened = false;
	if (events.length < 5 && days < 35) {
		events = collect(35);
		widened = true;
	}

	emit({
		ok: true,
		mode: "query",
		status: status,
		now: Math.round($.NSDate.date.timeIntervalSince1970),
		todayStart: Math.round(todayStart.timeIntervalSince1970),
		tz: str($.NSTimeZone.localTimeZone.name),
		widened: widened,
		events: events,
	});
}

main();
undefined;
