# Mobile Layout — Second-Clock Overlap Fix + Responsive Pass

**Date:** 2026-06-29
**Status:** Approved (design)

## Summary

In landscape, the secondary-clock badge (`#secondClock`) — a `position:fixed`
top-right overlay — sits on top of the hero clock's rightmost digits, because the
hero clock scales to ~full stage width while nothing reserves space for the badge.
Fix: when a second clock is shown, reserve a top strip in landscape so the hero
clock sits just below the badge. Then a bounded responsive audit across phone
(portrait/landscape), tablet, and TV viewports, fixing clear breakage.

## Root cause (verified)

Reproduced headless at 1180×560 landscape with `?second=india&clockstyle=block`:
the block clock `12:00:48` fills the stage edge-to-edge (`preserveAspectRatio:
xMidYMid meet`), and `.second-clock` (`position:fixed; top:14px; right:14px;
z-index:5`) overlays the top-right — directly over the seconds digits. The badge
is a fixed overlay **outside** the `.app` grid and the stage's fit-to-container
sizing, so the clock has no awareness of it. Portrait is fine: the clock sits
lower (grid row order `weather / stage / chrome`), below the badge.

## Constraints

- **The clock must never break.** Changes are additive (one CSS class + landscape
  CSS); no renderer logic changes. A failure degrades to today's behavior.
- **Dependency-free** vanilla JS/CSS; no framework, no build step.
- **Follow the existing grid-driven responsive approach** (`.app` grid +
  `@media(orientation:…)` + `.force-portrait`/`.force-landscape`). No unrelated
  restructuring.
- **Style-agnostic:** the fix must hold for all clock styles (classic flip, block
  matrix, analog), since all fit the stage container.
- The clock only shrinks **when a second clock is shown** — full size otherwise.

---

## Component 1 — Overlap fix (reserve a top strip)

**`js/app.js` — `updateSecondClock`:** toggle a `has-second` class on the `#app`
element reflecting badge visibility. Where the function currently sets
`el.hidden = true` (off / unsupported zone) also remove the class; where it sets
`el.hidden = false` (a zone is active) also add it. Every path that hides the
badge must clear the class (so a stale class can't reserve space with no badge).
Wrapped in the existing try/catch.

```js
// inside updateSecondClock, after computing visibility:
const appEl = document.getElementById('app');
if (appEl) appEl.classList.toggle('has-second', !el.hidden);
```

**`css/styles.css`:** reserve top space on the stage in landscape only, when a
second clock is present, so the hero clock drops below the badge:

```css
@media (orientation:landscape){
  .app.has-second .stage{
    padding-top: calc(env(safe-area-inset-top, 0px) + 88px);
  }
}
.app.force-landscape.has-second .stage{
  padding-top: calc(env(safe-area-inset-top, 0px) + 88px);
}
```

`88px` ≈ badge top-inset (14) + badge height (~70) + a small gap, so the digit
tops clear the badge's bottom edge. The stage's `ResizeObserver` (flip) and SVG
`meet` fit (block/analog) re-flow into the reduced height automatically — no JS
sizing change. Portrait rules are untouched.

Edge cases:
- `force-portrait` while the device is physically landscape: portrait grid order
  puts the clock below the badge, so no reservation needed (the landscape
  selectors don't match `force-portrait`). Confirm in the audit.
- Very short landscape (e.g. 844×390 phone): 88px is a large fraction of height;
  verify the clock stays legible. If too cramped, fall back to a `clamp()`-based
  reserve (e.g. `clamp(64px, 16vh, 96px)`) — decide during verification.

## Component 2 — Responsive audit pass

Capture headless Chrome screenshots (serve with `python3 -m http.server <free
port>`; **avoid 8090 — taken by another container**) at these viewports, each with
`?second=india&clockstyle=block&display=dynamic&debug=1` and an `&orient=` where
forcing is needed:

- Phone portrait — 390×844
- Phone landscape — 844×390
- Tablet — 1024×768
- TV — 1920×1080

Verify:
- The overlap fix: badge no longer covers any digit, in landscape, for **both**
  block and classic-flip styles (capture before/after for the headline case).
- No new overlaps/clipping introduced; weather footer, chrome controls band, date,
  and the second-clock badge all render cleanly and legibly at each size.

Fix anything clearly broken (overlap, clipped text, element off-screen). **List
anything debatable** (subjective sizing/spacing) for the user to decide rather
than changing it unilaterally.

**Out of scope (note only):** the landscape sun-arc is tiny and its "X H OF
LIGHT" label is ambiguous — a separate follow-up unless the user folds it in.

---

## Testing

Pure CSS/layout change — no unit tests. Verification is visual: the four-viewport
headless screenshot set above, with before/after for the overlap, confirming the
badge clears the clock and nothing else regressed. The Node and Python suites must
still pass unchanged (no logic touched).

## Non-goals (YAGNI)

- No change to the badge's design/content or portrait placement.
- No grid restructure (the reserve-strip approach was chosen over making the badge
  a grid cell precisely to avoid that).
- No JS clock-sizing changes — the existing fit-to-container logic handles it.
- No sun-arc redesign (noted as a separate follow-up).

## Risks & mitigations

- **Stale `has-second` reserving space with no badge** → every badge-hide path
  clears the class; verify the `off`/unsupported-zone cases.
- **88px too tall on short landscape phones** → verify at 844×390; switch to a
  `clamp()` reserve if cramped.
- **Other clock styles** → the reserve is on the stage container, not style-
  specific; verify flip + analog in the audit.

## Affected files

- `js/app.js` — `updateSecondClock` toggles `#app.has-second`.
- `css/styles.css` — landscape `.app.has-second .stage` top reserve.
- (Audit may add small additional CSS fixes for any other clear breakage found.)
