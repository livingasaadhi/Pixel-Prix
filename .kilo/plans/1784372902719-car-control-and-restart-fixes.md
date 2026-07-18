# Pixel Prix — Game Context Brief (for UI-building AI)

> Purpose: give a second AI agent enough accurate, verified context to build or
> refactor the **UI / UX** of Pixel Prix without re-deriving the game from scratch.
> Everything below reflects the actual codebase (Phaser 3 + vanilla JS ES modules +
> Vite + Supabase), not generic assumptions.

---

## 1. What the game is

**Pixel Prix** is a mobile-first, **2D top-down vector racing game** (open-wheel / F1-style).
The player picks a car and a circuit, races a fixed number of laps against the clock,
must hit invisible checkpoints in order, and gets a final adjusted time (raw time + steward
penalties). After finishing, they enter a driver name and post their time to a **global
leaderboard** (Supabase, with LocalStorage fallback when unconfigured).

- Rendering: **Phaser 3** (`phaser@^3.80`), `Phaser.AUTO` (Canvas/WebGL auto), `Scale.RESIZE`.
- Language/tooling: **Vanilla JavaScript (ES Modules)**, **Vite 5** build, no framework.
- Backend: **Supabase** (`@supabase/supabase-js@^2.45`) for the shared leaderboard;
  gracefully degrades to LocalStorage if credentials are missing.
- Visual style: **monochrome / high-contrast vector** aesthetic — black background,
  white/translucent UI, thin neon grid, checkered start/finish. Defined by CSS custom
  properties in `src/style.css` (see §7).
- Audio: **procedural Web Audio** (no asset files) in `src/utils/audio.js` — engine drone
  (sawtooth oscillator, gain-gated to acceleration only), boost whoosh, checkpoint chime,
  finish jingle.

---

## 2. Screens / flow (DOM overlay over the Phaser canvas)

The app is a single full-screen `#app` containing `#game-container` (Phaser canvas, `z-index:1`)
and `#ui-overlay` (DOM UI, `z-index:10`). All menus/HUD are DOM elements in `index.html`,
toggled by adding/removing the `.hidden` class. `RaceScene` (Phaser) runs underneath and
emits HUD data via `window` CustomEvents.

Screen state machine (see `src/main.js`, `showScreen()` / `setRaceMode()`):

1. **Main Menu** (`#screen-menu`): title "PIXEL PRIX", buttons: PLAY RACE, LEADERBOARDS,
   CONTROLS AND INFO.
2. **Select Car & Circuit** (`#screen-select`): carousel of cars (left/right arrows, live
   canvas preview + 4 stat bars) and circuits (left/right arrows, minimap canvas + difficulty/
   laps/length tags). Bottom **START RACE** button (sticky, always reachable).
3. **Race HUD** (`#screen-hud`): transparent overlay during the race. Top: LAP / TIME / SPEED /
   PENALTY chips. Center-top: steward/checkpoint notification. Bottom: boost-energy meter
   (centered) + touch controls (see §5).
4. **Game Over / Finish** (`#screen-gameover`): final/lap/penalty times, driver-name input +
   SUBMIT, RETRY / LEADERBOARD / MENU.
5. **Leaderboard** (`#screen-leaderboard`): track tabs, scrollable table (rank/driver/car/time/
   date), refresh.
6. **Controls & Info** (`#screen-settings`): control explanation + F1 stewards rules.

Navigation is driven by `main.js` DOM listeners; `RaceScene` only emits events and exposes
`setAccelerate/setSteerLeft/setSteerRight/setBrake/setBoost`.

---

## 3. Data models (data-driven; add content without touching scene code)

**Car** (`src/data/cars.js`, `CARS[]`):
```
{ id, name, description, color (hex), accentColor (hex),
  topSpeed, acceleration, handling, boostPower, drag }
```
6 cars shipped (Scuderia Furiosa, Blue Bull Racing, Silver Arrows, Papaya Express,
Green Emerald, Alpen Glow). `topSpeed` ~235–331; `handling` 3.4–5.0; `boostPower` 1.35–1.6;
`drag` ~0.982–0.988.

**Track** (`src/data/tracks.js`, `TRACKS[]`):
```
{ id, name, description, difficulty (EASY/MEDIUM/HARD), laps,
  roadWidth, worldWidth, worldHeight,
  startPos {x,y,rotation},
  points: [{x,y}, ...]   // closed spline control points
  checkpoints: [{id,x,y,label}, ...] }   // must be hit in order
```
6 tracks shipped (monaco-oval, serpent-bend, neon-ring, desert-drift, cyber-ring, g3-sweden).
`worldWidth/Height` is larger than the actual spline footprint — important for the camera
(see §6).

---

## 4. Core game / physics rules (so UI reflects real state)

- Lap counting via ordered checkpoint hits; `totalLaps` from `track.laps`.
- Speed model: `currentSpeed` (px/s) integrated from `acceleration`/`topSpeed`, scaled by
  `boostPower` while boosting, reduced on grass (`roadWidth` off-track = penalty zone).
- UI speed readout = `Math.round(|currentSpeed| * 0.8)` "KM/H"; negative = "REV".
- Steering: speed-dependent turn rate (tight at low speed, wider at high speed, floor 0.35);
  inverted while reversing.
- **Boost**: requires energy ≥ 75% to *start*, sustains down to 2%, regenerates ~12/s when
  not boosting. **Holding Boost implies acceleration automatically** (decoupled from the gas
  button). Boost meter (0–100%) is emitted every HUD frame.
- **Stewards penalties** (UI shows PENALTY chip + notifications):
  - Track-limits warnings after ~1.5s continuous off-road; 3rd offense = +5.0s.
  - Corner cutting (off-road >100 KM/H) = +10.0s unless yielded within 3s.
- Engine sound is **only audible while accelerating** (gas or boost); silent when coasting/
  braking/reversing.

---

## 5. Controls (current, verified)

Desktop (keyboard, `RaceScene.js` + `event.code` fallback so a/A both work):
- Steer: `A`/`Left`, `D`/`Right` · Brake/Reverse: `S`/`Down` · Gas: `W`/`Up`
- Boost: `Space` or `Shift` (also `Z`/`C`)

Mobile touch (DOM buttons in `#screen-hud`, bound in `main.js` `setupTouchControls`):
- **Left thumb**: steer ◀ / ▶ (bottom-left).
- **Right thumb**: BRAKE (reverse), GAS (accelerate), BOOST (bottom-right grid; boost is the
  distinct white-bordered button). Boost auto-accelerates.
- Buttons are circular, semi-transparent, edge-anchored to safe areas, ≥48px hit target,
  with `:active`/`.active` scale+invert feedback.

---

## 6. Camera (verified current behavior — keep when rebuilding HUD)

- `RaceScene.frameCamera()` computes the **track spline bounding box** (+ road padding) and
  sets `cameras.main.setBounds(...)` to THAT box (not the oversized world rectangle), so the
  view fills with track and there is no empty gridded margin.
- Zoom = `clamp(cover-fit, 0.5, 0.8)` (cover-fit = max(vw/trackW, vh/trackH)). Re-framed on
  `scale` resize.
- Follow: `startFollow(player, true, 0.18, 0.18)` + `setFollowOffset(0,0)` → car and immediate
  track stay centered with minimal lag.
- Implication for UI: the HUD must overlay a **dynamic, zoom-variable** camera; never assume a
  fixed world-to-screen scale. HUD is DOM, positioned with `env(safe-area-inset-*)` so it never
  overlaps the playfield.

---

## 7. Design system (from `src/style.css` `:root`)

- Palette: `--bg-dark #08080a`, `--bg-card rgba(18,18,22,.95)`, `--primary-white #f5f5f7`,
  `--text-main #f5f5f7`, `--text-muted #8e8e93`, accent silver `#aeaeb2`.
- Radii: `--radius-card 12px`, `--radius-btn 6px`, `--radius-chip 6px`.
- Font: Inter (Google Fonts), system fallback.
- Buttons: `.btn` / `.btn-primary` (white, high-emphasis) / `.btn-secondary` / `.btn-tertiary`
  / `.btn-outline`; mobile min tap size 48px.
- Breakpoints used: base (desktop), `@media (max-width:1100px)` (tablet/phone, includes the
  canonical mobile HUD), `@media (max-width:640px)` and orientation variants. Uses `100dvh`
  for full-screen containers and `env(safe-area-inset-*)` for notches/home indicators.
- **Mobile UI rules already enforced**: 48px min touch targets, thumb-zone placement
  (steer bottom-left, brake/boost/gas bottom-right), sticky/reachable primary CTAs, scrollable
  screens, lightweight transform-based press feedback, landscape orientation lock attempt on
  race start (`screen.orientation.lock('landscape')`, best-effort).

---

## 8. Leaderboard / backend context

- `src/supabase.js`: `submitScore({playerName, carId, trackId, timeMs})`,
  `fetchTopScores(trackId)` (top 10 by `time_ms` asc), `subscribeToScores(trackId, cb)`
  (realtime), `getBackendStatus()`.
- Table `scores`: columns `player_name`, `car_id`, `track_id`, `time_ms`. Migration in
  `supabase/migrations/001_create_scores_table.sql`.
- If Supabase unconfigured, the UI should still function (leaderboard shows "unavailable");
  do not hard-fail the UI on backend errors.

---

## 9. Files the UI agent will touch (and must preserve)

- `index.html` — all screen DOM + HUD markup (the structure the CSS/JS depend on).
- `src/style.css` — entire design system + responsive/mobile rules.
- `src/main.js` — screen navigation, touch-control binding, leaderboard tabs, score submit.
- `src/scenes/RaceScene.js` — emits `pixel-prix:hud` (speed/isReverse/lap/totalLaps/timeMs/
  penaltyMs/boostEnergy) and `pixel-prix:finish` (raw/penalty/total/bestLap/carId/trackId);
  exposes `setAccelerate/setSteerLeft/setSteerRight/setBrake/setBoost`.
- Do **not** change physics/scene logic unless asked; keep the DOM IDs/classes and the two
  CustomEvents stable so `RaceScene` keeps driving the HUD.

---

## 10. Open questions for the UI agent (clarify with user before building)

1. Is this a **full UI redesign** or **polish/fixes** on the existing monochrome system?
2. Target primarily **phone (portrait + landscape)**, tablet, desktop, or all? (Current code
   optimizes mobile, locks race to landscape.)
3. Any brand/theme change (colors, logo "FORMULA 2D" / "PIXEL PRIX") or keep monochrome?
4. Leaderboard: keep the current per-track tabbed table, or add filters/global ranking?
5. Accessibility bar (minimum contrast, larger text, reduced-motion)?

---

## 11. Validation checklist for any UI change

- Build: `npm run build` (Vite) succeeds; `npm run dev` runs.
- Start Race reachable on 320px–430px phones (portrait + landscape) without scrolling away.
- All 5 touch controls fully on-screen, equal bottom margin, ≥48px, none clipped.
- HUD does not obscure the playfield; uses safe-area insets.
- Car stays centered; track fills view; no empty gridded margins.
- Leaderboard/score submit still work with and without Supabase configured.
- Deploy: GitHub Actions → GitHub Pages must go green.
