# Next Meeting — Stream Deck + dial

Shows the next event from the local macOS Calendar on a Stream Deck + dial, with
the time left until it starts. Rotate to browse the upcoming events, press to
join the meeting.

Reads **EventKit** directly — the same API Calendar.app uses — so there are no
feed URLs to configure and recurring events, time zones and all-day flags arrive
already resolved, in about 100 ms. macOS only, Stream Deck + (or any device with
a dial).

```
┌──────────────────────────┐
│ ×8 Global (Martin)  NEXT │   calendar · ×N when duplicates were collapsed
│ Sprint Review            │   event title
│ 12 min             10:30 │   countdown · start time
│ ████████████░░░░░░░░░░░░ │   urgency
└──────────────────────────┘
```

## Why not an ICS feed

Every off-the-shelf calendar plugin wants an authenticated `.ics` URL per
calendar. On a work machine that easily means dozens of calendars across several
accounts, which does not scale, and a CalDAV server will happily hand you its
login page instead of an `.ics` if the URL is slightly wrong. This plugin reads
**EventKit** instead — the same API Calendar.app uses — so recurring events, time
zones and all-day flags arrive already resolved, in about 100 ms, with nothing to
configure per calendar.

The probe is `scripts/calendar.js`, run through `osascript -l JavaScript` as a
short-lived child process. See `docs/` notes inline in that file for the three
JXA traps it works around.

## Calendar permission

The permission prompt is attributed to the **parent app**, so macOS asks
*"Elgato Stream Deck would like to access your calendars"* and the grant is
stored against `com.elgato.StreamDeck`. Stream Deck already ships the required
`NSCalendarsUsageDescription`, so nothing needs patching.

The plugin does **not** ask at startup. There is exactly one prompt per app, and
a dismissed dialog can only be recovered with `tccutil`. Instead the dial shows
*"Press to allow access"* and the press triggers the request, so the prompt
never arrives unexplained. If access was denied, the press opens
System Settings → Privacy & Security → Calendars.

## Calendars

An empty selection means *all* calendars. Where colleagues' calendars are shared
with you, that is useless: a recurring team meeting appears once per attendee, so
the "next eight events" can be eight copies of the same meeting, and other
people's private appointments show up too. On first run the plugin therefore
selects your own calendars (writable, and not a delegated `Name (Name)` share).
Refine the selection in the property inspector, grouped by source, with all/none
per source — a shared account's calendars can be dropped as a block and the two
or three that matter added back.

Duplicates are collapsed across calendars, and the context line shows `×8` when
eight copies became one entry. Meetings that are genuinely the same but carry
different titles cannot be collapsed, and nothing could do that reliably.

All-day entries are always ignored — birthdays and holidays have no meaningful
countdown.

## Development

```sh
npm install
npm run build                       # rollup → bin/plugin.js
npm test                            # unit tests for the pure modules
npm run preview                     # print what the dial would show, right now
npm run validate                    # layout bounds + overlap rules
npx streamdeck link com.derpixler.next-meeting.sdPlugin
npx streamdeck restart com.derpixler.next-meeting
npm run watch                       # rebuild + restart on change
```

Probe the calendar directly, which is the fastest debugging loop:

```sh
P=com.derpixler.next-meeting.sdPlugin/scripts/calendar.js
CALX_MODE=status osascript -l JavaScript $P
CALX_MODE=query CALX_DAYS=7 osascript -l JavaScript $P | jq '.events[:5]'
CALX_MODE=calendars osascript -l JavaScript $P | jq -r '.calendars[] | "\(.source) | \(.name)"' | sort
```

Test render states on the hardware without waiting for a real meeting:

```sh
open "streamdeck://plugins/message/com.derpixler.next-meeting/fixture=imminent"
open "streamdeck://plugins/message/com.derpixler.next-meeting/fixture=starting"
open "streamdeck://plugins/message/com.derpixler.next-meeting/fixture=running"
open "streamdeck://plugins/message/com.derpixler.next-meeting/fixture=empty"
open "streamdeck://plugins/message/com.derpixler.next-meeting/fixture=stale"
open "streamdeck://plugins/message/com.derpixler.next-meeting/fixture=live"   # back to real data
open "streamdeck://plugins/message/com.derpixler.next-meeting/clock=+00:04:30"
open "streamdeck://plugins/message/com.derpixler.next-meeting/clock=reset"
```

`migrate` copies settings saved before the move to per-dial settings onto every
visible dial — a one-off, and it overwrites what those dials currently have:

```sh
open "streamdeck://plugins/message/com.derpixler.next-meeting/migrate"
```

`dump` logs what each dial is actually working with — the event order, which ones
are already running, and how many calendars are selected. It is the quickest
answer to "why is *that* on the strip?":

```sh
open "streamdeck://plugins/message/com.derpixler.next-meeting/dump"
```

A fixture freezes the calendar probe, so it stays on screen until you send
`fixture=live`.

Logs: `com.derpixler.next-meeting.sdPlugin/logs/`.

## Colour, the start signal and the sound

The **bar and the countdown colour together**, by how long is left:

| left | countdown | bar |
|---|---|---|
| > 60 min | `#e6e9ef` | blue `#4a90d9` |
| 15–60 min | `#ffd45e` | amber `#e8b23a` |
| 2–15 min | `#ff8c42` | orange |
| 0–2 min | `#ff5555` | red |
| running | `#5ad17a` | green, and the bar switches to elapsed progress |

While browsing away from the next event the palette is forced back to calm blue:
red has to keep meaning "your next thing is imminent", not "the thing you happen
to be looking at is imminent".

**At the start** the whole backdrop turns signal red for two minutes
(`SIGNAL_MS`), and the countdown switches to white so it still reads. It is
solid, not blinking — a strobing 200×100 canvas is exactly the redraw pattern
the strip shows as flicker, and "it has started" needs no motion to be noticed.
The backdrop stays dark while browsing or while the cache is stale, since
neither is a real "happening now".

The backdrop is a `pixmap` spanning `[0, 0, 200, 76]` at `zOrder` 0, with the
text cells at `zOrder` 1 above it, and it stops short of the bar at y=78 so the
two can never overlap.

**A pixmap value must be a file the device can load.** A raw inline `<svg>`
string is rejected — the device log says

```
Layout component failed: ... element 'canvas' cannot set value:
invalid image or file not found
```

and, critically, a rejected value fails the **whole** feedback update, so every
other cell freezes too. That looks like "the progress bar stopped working" and
then like "the whole thing is broken", with nothing in the plugin's own log.
`imgs/signal.png` is therefore a real file referenced from the layout, and the
plugin only ever toggles `enabled` — no image value is sent at runtime. A test
asserts the referenced file exists and that `signalCanvas()` returns nothing but
`enabled`.

**When a dial misbehaves with no plugin-side error, read the device log:**

```sh
grep -iE 'layout|feedback' ~/Library/Logs/ElgatoStreamDeck/StreamDeck.log | tail
```

Items may overlap when their `zOrder` differs — only overlaps at the *same*
`zOrder` silently kill the whole layout, and `npm run validate` enforces that.

Self-hosted platforms cannot be guessed from a URL, so put their hosts in
**"Extra meeting hosts"** — they then score above anything merely found in the
notes. If your invitations carry only a bare room path such as `/DevDaily` in the
location field, set **"Meeting room base URL"** and pressing the dial joins it.

**The sound** is one system sound at the start of the next event, chosen in the
property inspector (default `Ping`, with a Play button to audition). It fires
once per event, and only for an event whose start the plugin actually witnessed
— otherwise every restart during a meeting would replay it.

## Settings are per dial

Every dial carries its own settings in its action instance: calendars, duplicate
collapsing, the Free filter, whether a running meeting is shown, the sound and
the browse timeout. Two dials can therefore be set up for different purposes —
one for work calendars, one for private ones.

They were global at first, on the reasoning that the calendar selection is a
property of the data source. That was wrong: a second dial silently mirrored the
first however it was configured.

**One probe still serves every dial.** The store queries the *union* of all
dials' calendar selections and keeps the raw result; each dial then narrows that
to its own calendars with `shapeEvents()`. Without that narrowing a dial sees the
other dials' meetings — which is exactly the bug the per-dial change first
introduced, and what two of the store tests now pin down.

## A meeting in progress

By default an event that is happening right now stays at the top of the list and
reads `NOW`, with the bar switching to elapsed progress. Turn
**"Show an event that is happening right now"** off and the dial always counts
down to the next event that has not started yet.

The filter is applied by time, not only at probe time: the store wakes a second
after the displayed event starts and again after it ends (`#armBoundary`), so an
event drops out the moment it starts rather than whenever the next probe
happens to run. Toggling the setting re-filters the cached events immediately
instead of waiting for a probe.

If a meeting you expect is missing, the cause is usually the calendar selection
rather than this filter — `dump` shows both.

## Browsing

Rotating pins the shown event **by id**, not by index, so an incoming refresh
cannot swap the event out from under you. After a while the display returns to
the next event on its own; that is **20 seconds** by default and configurable in
the property inspector, including *never*. The original 5 seconds was far too
short — the display snapped back while you were still reading.

## Long titles

A title too wide for the 192px cell scrolls: it holds at the head, runs to the
end, holds, and runs back. At the default 180ms per character step with a 2.5s
hold, each direction starts about every five seconds.

**A scrolling title changes exactly one layout cell per frame.** That is what
makes the animation affordable — an earlier version rewrote all six cells on
every frame, which redraws the whole layout and the strip shows as a flicker.
`feedbackDelta()` now sends only the cells that differ, so a scroll frame
carries `evtitle` alone and a ticking countdown carries `countdown` alone. A
test pins that property, because it is easy to break by accident.

How much the strip can actually take per second is undocumented, so the rate is
tunable at runtime — no rebuild, no restart:

```sh
open "streamdeck://plugins/message/com.derpixler.next-meeting/scroll=180"      # step only
open "streamdeck://plugins/message/com.derpixler.next-meeting/scroll=120,2000" # step,hold
open "streamdeck://plugins/message/com.derpixler.next-meeting/scroll=300,3000" # calmer
```

Every dial re-anchors on change, so the effect is visible immediately. Once a
value feels right, make it the default in `DEFAULT_TITLE_TIMING`
(`src/render/strip.ts`).

How far to scroll depends on rendered width, and character counts are useless
here: 192px fits 11 of "W" but 25 of "i". `textWidth()` therefore estimates from
per-character advance widths calibrated against NSFont measurements of the real
strip font (18px, weight 600), accurate to a few percent — a test pins it to
those measurements. `titleTravel()` stops exactly where the end becomes visible,
so the tail is never half-shown and the title never scrolls into empty space.

The scroll phase is anchored per dial and reset when the shown event changes, so
a title always starts at its beginning after you rotate.

## Layout gotchas

A custom encoder layout renders on a 200×100 canvas. Two mistakes make the
**entire** layout silently blank: an item outside those bounds, and two items
overlapping at the same `zOrder`. `npm run validate` catches both. Also, an item
keyed `title` or `icon` lets the property inspector override its font and
colour, so this layout uses neither name.

## License

MIT
