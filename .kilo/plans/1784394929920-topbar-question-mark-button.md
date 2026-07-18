# Plan: Remove hamburger menu, make settings button a circular question-mark button

## Context
The top app bar (`#top-app-bar`) currently has two buttons: a hamburger **menu** icon (`#btn-open-settings`, opens the Settings screen) on the left, and a **settings** gear icon (`#top-settings-icon`, also opens Settings) on the right. The user wants the hamburger removed and the settings button replaced with a **circular** button showing a **question-mark** icon. Functionality (opening the Controls & Info / Settings screen) must be preserved.

## Affected files
- `index.html` (top app bar markup, lines ~38-50)
- `src/main.js` (button bindings, lines ~653-664)
- `src/style.css` (`.icon-btn` / circular styling, lines ~244-261)

## Changes

### 1. index.html — top app bar
- Delete the left hamburger button block:
  ```html
  <button class="icon-btn" id="btn-open-settings" aria-label="Menu">
    <span class="material-symbols-outlined">menu</span>
  </button>
  ```
  (keeps `<div class="top-app-bar-actions">` wrapper on the left, now empty — see step 3).
- Update the right settings button to a circular question-mark button:
  ```html
  <button class="icon-btn-circle" aria-label="Controls & info" id="top-settings-icon">
    <span class="material-symbols-outlined">help</span>
  </button>
  ```
  Note: `help` is the Material Symbols question-mark glyph. Swap `icon-btn` → `icon-btn-circle` so it renders as a bordered circle. Update `aria-label` to "Controls & info" / "Help".

### 2. src/main.js — remove dead binding
- Remove the binding `bindClickOrTouch('btn-open-settings', openSettings);` (line ~658).
- Keep `bindClickOrTouch('top-settings-icon', openSettings);` — unchanged (still opens Settings).
- Keep `btn-open-settings-menu` and `nav-tab-profile` bindings (alternative ways to open Settings — unaffected).

### 3. src/style.css — keep left actions area clean
- The left `top-app-bar-actions` div becomes empty after removing the hamburger. Options:
  - **Recommended:** remove the now-empty left `<div class="top-app-bar-actions">` from index.html so the brand sits flush left (brand is centered via flex/`justify-content`, verify `.top-app-bar` uses `justify-content: space-between` so removing the left node is safe).
  - If `.top-app-bar` relies on three flex children for centering, keep the empty `<div>` as a spacer. Verify during implementation; prefer deletion if brand stays centered.
- `.icon-btn-circle` already exists (44px, `border-radius: var(--radius-circle)`, 1px border) — no CSS change needed for the circular look. Confirm `help` glyph renders at a readable size (`.icon-btn-circle` sets `font-size: 20px`).

## Risks / verification
- **Centering:** confirm removing the left actions node does not break `.top-app-bar` brand centering (CSS uses `space-between`). If it does, keep an empty spacer div.
- **No orphan JS:** after removing `btn-open-settings`, ensure no other reference remains (grep `btn-open-settings`).
- **Settings still reachable:** verify Settings/Controls screen still opens via the question-mark button, the menu-screen "CONTROLS & INFO" button (`btn-open-settings-menu`), and profile tab.
- **Mobile:** confirm top bar looks correct on narrow viewports (the bar is hidden during an active race anyway via `setRaceMode`).

## Validation
1. `npm run build` succeeds.
2. Manual: open app → top bar shows brand + circular `?` button (no hamburger). Tap `?` → Settings/Controls screen opens. No console errors. Hamburger gone on desktop and mobile.
