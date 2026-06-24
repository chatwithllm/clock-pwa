# Stacked announcements (queue + right-side notifications)

**Date:** 2026-06-24
**Status:** Approved (design)

## Problem

`announce.json` holds a single announcement object; every send overwrites
the previous one, and the device shows exactly one centered modal at a
time. There is no way to display more than one announcement together. We
want: a single live announcement to keep the current centered look, and two
or more live announcements to behave like Apple notifications — a vertical
stack at the top-right, ordered by arrival.

## Approach

Turn `announce.json` into a **queue** (a JSON array of announcement
objects). Admin/helper sends append to the array; the device renders the
set of currently-live entries that target it. Display rules:

- **0 live** → nothing shown.
- **1 live** → the existing centered, dimmed, modal overlay with a Dismiss
  button (unchanged behavior).
- **2+ live** → no full-screen dim. The **newest** live entry is a bright,
  non-modal centered **card**; all older live entries form a **right-side
  vertical stack** (oldest at top, down to the second-newest at the
  bottom). Everything auto-dismisses on its own duration.

**Center invariant:** the center always shows the newest still-live entry.
When the centered entry expires while older entries are still live, the
next-newest live entry promotes from the right stack into the center.

## Data

`announce.json` (served from `/data`, no-cache, WebDAV PUT, auth on write —
unchanged route):

```json
[
  { "id": "1750000000-12", "text": "Dinner is ready!", "icon": "🍽️",
    "ts": 1750000000000, "duration": 20, "target": "all", "from": "" },
  { "id": "1750000005-13", "text": "Movie in 5", "icon": "🎬",
    "ts": 1750000005000, "duration": 30, "target": "Theater Room" }
]
```

- Array, newest-last by insertion. Each object is the existing announcement
  shape (`id`, `text`, `icon?`, `ts` ms, `duration` s, `target`, `from?`).
- Default shipped file: `[]`.
- **Back-compat:** if the parsed JSON is a bare object (legacy single
  announcement) rather than an array, the device wraps it as a
  one-element array. If `id`/`text` are empty (the old "cleared" sentinel),
  it is treated as an empty queue.

### Write semantics (append + trim)

On every send (admin page and `announce.sh`):
1. GET the current `announce.json` (tolerate 404/empty/non-array → start
   from `[]`).
2. Append the new entry.
3. **Trim**: drop entries whose `ts/1000 + duration` is already in the past
   (expired), then cap to the **last 20** entries.
4. PUT the resulting array.

**Clear / dismiss all** → PUT `[]`.

Single-admin use; the read-modify-write race is acceptable (documented).

## Device display rules (js/app.js)

Replace the single-id announcement logic with a **live-set renderer**.

- **Parse:** accept array or legacy object; coerce to array `Q`.
- **Live filter:** for each entry, keep it if it targets this device
  (`target` is `all` case-insensitively, or equals the device profile
  case-insensitively) AND `ageSec < duration`, where
  `ageSec = (now - ts)/1000`. Entries with empty `id`/`text` are skipped.
- **Sort:** by `ts` ascending (arrival order). Newest = last.
- **Dismissed-set:** an in-memory `Set` of ids the user manually dismissed;
  dismissed ids are excluded from the live set so they do not re-pop while
  still within their window. (Persist to `localStorage` under
  `clockpwa.announceDismissed` so a reload during the window doesn't
  re-pop; entries naturally age out.)
- **Render:**
  - `liveCount === 0` → hide center overlay and clear the stack.
  - `liveCount === 1` → center overlay in **modal** mode (dim backdrop,
    focus trap, Dismiss) showing that entry. Stack empty/hidden.
  - `liveCount >= 2` → center overlay in **card** mode (no dim, no focus
    trap) showing the newest live entry; the remaining live entries (all
    but the newest) render in the right stack, oldest at top.
- **Right-stack cap:** the stack renders the live entries *older* than the
  centered newest, ordered oldest-at-top down to second-newest at the
  bottom. Render at most **4** toasts. When more than 4 older entries are
  live, hide the oldest and render the **4 most-recent** older entries
  (second-newest at the bottom), with a "**+N more**" chip at the **top**
  of the stack standing in for the `N = olderLiveCount - 4` hidden oldest
  entries. (Rationale: oldest items are least relevant, so they collapse
  into the chip; nothing is silently dropped — the count is shown.)
- **Timers:** drive re-render from the existing announce poll tick AND a
  short per-render `setTimeout` scheduled for the soonest upcoming
  expiry, so expiries reflow promptly without waiting for the next 15s
  poll. Re-render is idempotent (compute live set → diff → update DOM).
- **Promotion** falls out of the rules: when the centered newest expires,
  the next re-render's newest-live is the previous second-newest, which now
  renders in the center automatically.

### Interaction / TV remote

- **Modal mode (1 live):** unchanged — D-pad scope set to the overlay,
  focus the Dismiss button; dismiss records the id in the dismissed-set.
- **Card/stack mode (2+ live):** non-modal, no focus trap (D-pad keeps its
  normal scope). The center card shows a small ✕ dismiss control; toasts
  rely on auto-expire (no per-toast focus to keep remote nav simple). The
  ✕ records the id in the dismissed-set and re-renders.

## Components

| File | Change |
|------|--------|
| `announce.json` | Default becomes `[]`. |
| `index.html` | Add right-stack container `#announceStack`; keep `#announce` center overlay; add a ✕ control usable in card mode. |
| `css/styles.css` | `.announce-stack` (fixed top-right, flex column, gap); `.toast` card styling; a `.announce--card` non-modal variant of the center overlay (no dim); slide-in / reflow transitions gated on `prefers-reduced-motion` and the app's reduce-motion flag. |
| `js/app.js` | Rework `pollAnnounce` + `showAnnouncement` + `dismissAnnounce` into a live-set renderer with active/dismissed tracking and per-expiry timer. |
| `admin.html` | `send` and `clear` become GET-append-PUT (array) / PUT `[]`. |
| `announce.sh` | GET-modify-PUT the array in plain `sh` (no jq in alpine): fetch current via the in-container file, build the new array string, write it. |
| `sw.js` | No change (announce.json already network-first; shape-agnostic). |

## Error handling

- `announce.json` missing/404/corrupt/non-array → device treats queue as
  empty (try/catch), keeps showing nothing; never throws.
- Legacy single-object file → wrapped to one-element array.
- Admin/helper GET of current array fails → start from `[]` and PUT (a
  send should still succeed; worst case it drops not-yet-expired older
  entries, acceptable and logged in the admin status line).
- Reduce-motion → no slide/reflow animation, instant show/hide.

## Testing

Manual (curl + browser, matching prior pattern). No automated framework.

Server/curl:
- GET `announce.json` open (200), default `[]`.
- PUT array with auth → 204; without auth → 401 (route unchanged).
- `announce.sh "msg"` twice → file is a 2-element array, both present.
- Expired entries (old `ts`) get trimmed on the next send.

Browser (Playwright, against a no-auth throwaway container on a spare port,
since admin PUT needs auth — same technique used for the profiles feature):
- 1 live → centered dimmed modal + Dismiss (regression check).
- Send a 2nd within the first's window → dim drops; newest centered card +
  1 right toast (the older one), oldest-at-top ordering.
- Send 3–5 → right stack grows, cap at 4 with "+N more" when older-live > 4.
- Let the centered newest expire → next-newest promotes to center.
- Manually ✕ the center card → that id does not re-pop on next poll while
  still in window; an older one promotes to center.
- Target a toast to a specific profile → only the matching device shows it.
- Clear all → everything disappears.
- Reduce-motion on → no animation.

## Out of scope (YAGNI)

- Per-toast manual dismiss via remote in stack mode (auto-expire only).
- Sound/vibration.
- Notification history/log view.
- Grouping/collapsing by sender.
