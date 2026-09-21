# Matrix calendar takeover and landscape alert dock — implementation handoff

Status: implemented on `feat/ha-dashboards` and included in PR #12.

This note describes the behavior added in September 2026 so a future agent can
continue without reconstructing the design decisions from chat history.

## Completed behavior

### Landscape Home Assistant alert dock

- Landscape displays reserve a stable bottom row of 12 square status positions.
- Positions never move: inactive entries remain faint and active entries add an
  amber warning or red critical border, corner light, and animated glow.
- The slots are `water_leak`, `window`, `security`, `temperature`, `motion`,
  `power`, `door`, `smoke`, `co`, `freeze`, `pickup`, and `other`.
- `pickup` uses a school-bag icon and is intended for kids pickup/drop-off
  reminders delivered through the existing alert API.
- Portrait mode retains the original active-only corner alert rails.
- The dock fades while the normal control chrome is visible.

The alert model remains in `js/alertview.js`; landscape presentation is CSS and
markup in `index.html` and `css/styles.css`.

### Matrix calendar event takeover

- The app watches a native Home Assistant calendar entity through the existing
  HA WebSocket entity cache. The default is `calendar.matrix`.
- The entity is configurable under **Settings → Priority calendar entity** and
  through `?calendar=calendar.entity_name`.
- A takeover appears only while the entity state is `on` and its standard
  `message` attribute is non-empty.
- Messages with 40 or fewer characters are centered and static. Longer messages
  use the continuous marquee.
- The normal clock stays alive and animates to the upper-right.
- If the optional secondary clock is enabled, it temporarily moves to the
  lower-left of the event panel at a similar visual scale. When the event ends
  or is dismissed, its original top-right position and styling return.
- The first touch/input reveals **Dismiss** and shrinks the headline to create
  control space. After five seconds without input, the button hides and the
  headline returns to its larger idle treatment.
- Dismissal is local to the current display and event. A new event key appears
  normally; an entity changing to `off` clears the dismissal state.
- Weather and the landscape alert dock remain visible throughout.

The pure calendar projection logic is in `js/calendar-banner.js`. Runtime state,
HA entity lookup, dismissal, and the development mock live in `js/app.js`.

## Layout decisions that should be preserved

- The event headline owns the center of the panel. Corner clocks must not overlap
  it, even on shallow landscape displays.
- The Matrix source badge remains compact in the upper-left.
- The primary and secondary clocks form a diagonal composition during an event:
  primary upper-right, secondary lower-left.
- On shallow landscape screens, static headline size is capped by width so a
  trailing word such as `PM` does not become an orphaned second line.
- When Matrix mode ends, do not leave event-specific clock positioning behind;
  all normal clock layout must restore automatically through removal of the
  `has-matrix-event` class.
- Reduced-motion mode disables the attention pulse, headline transitions, and
  scrolling animation fallback behavior as defined in `css/styles.css`.

## Development and visual testing

Use the same entity shape as Home Assistant without connecting to HA:

```text
/?debug=1&mockCalendar=1
```

Add a secondary clock when checking the two-clock layout:

```text
/?debug=1&mockCalendar=1&second=london
```

The development mock message is `Kids pickup at 2:30 PM`. Mocking is gated by
both query parameters and does not run on a normal kiosk URL.

The final layouts were checked at 1012×475 and 1024×400 as well as the standard
1280×720 preview. Validation covered:

1. Idle event treatment.
2. First-touch transition and Dismiss appearance.
3. Primary and secondary clock placement.
4. Dismissal restoring the full primary clock and original secondary badge.
5. Five-second inactivity restoring the large headline.

Run the automated suite with:

```sh
npm test
```

At handoff, 85 tests pass. Calendar behavior is covered by
`test/calendar-banner.test.js`; alert slot behavior is covered by
`test/alertview.test.js`; settings persistence is covered by
`test/settings-ha.test.js`.

## Offline/PWA details

`js/calendar-banner.js` is part of the service-worker shell cache. The cache was
bumped to `clockpwa-shell-v25` / `clockpwa-runtime-v25` when this feature was
added. Future module additions must also be added to `SHELL_FILES` and should
advance the cache version so installed displays receive the new shell.

## Safe continuation points

- Replace the development mock text only in `seedMatrixCalendarMock()`; production
  text must continue to come from the HA calendar entity.
- Keep calendar rendering based on the native entity instead of introducing a
  template sensor or extra HA automation.
- If adding priority levels or new calendar presentation modes, extend the pure
  view model and its tests first, then map the result to DOM/CSS in `js/app.js`.
- If changing clock placement, test with secondary clock both enabled and off,
  at a shallow landscape size, and after dismissal.
- Do not commit a populated root `alerts.json`; production alerts come from the
  alert sidecar. Use a local untracked file only for visual mock data.

## Primary files

- `index.html` — Matrix banner markup, Dismiss button, and landscape alert slots.
- `css/styles.css` — event takeover, clock placement, headline sizing, alert dock.
- `js/calendar-banner.js` — pure active-event projection and static/scroll choice.
- `js/app.js` — HA integration, mock event, dismissal lifecycle, DOM rendering.
- `js/settings.js` — `haCalendarEntity` default, URL override, and persistence.
- `js/alertview.js` — stable alert-slot projection and pickup type.
- `sw.js` — offline shell entry and cache version.
- `README.md` — operator-facing configuration and behavior.
