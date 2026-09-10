# Windows human-validation checklist (0.5.0)

**This must be completed on real Windows hardware before claiming Windows
support.** Nothing in this checklist may be performed by automation.

> **Compliance — hard rule.** Do NOT automate mouse, keyboard, champion select,
> rerolls, purchases or gameplay. Do NOT enter public or private matchmaking to
> run these checks by automation. Use a real, human-played Custom game or a
> human-played match only. The overlay is external, read-only screen capture and
> window detection — keep it that way during validation.

Record for each item: Pass / Fail / N-A, plus notes. File failures as issues.

## Environment matrix

Run the controlled-game checks below in as many of these as available:

- [ ] Windows 10 (if supported in your environment)
- [ ] Windows 11
- Display scaling:
  - [ ] 100%
  - [ ] 125%
  - [ ] 150%
  - [ ] 175%
  - [ ] 200%
- Monitor placement:
  - [ ] Primary monitor
  - [ ] Secondary monitor
  - [ ] Negative-coordinate monitor (display left of / above primary)
- League window mode:
  - [ ] Windowed
  - [ ] Borderless
  - [ ] Resolution change mid-session
- Lifecycle:
  - [ ] Alt+Tab away and back
  - [ ] Minimize and restore
  - [ ] Reconnect to an in-progress game
  - [ ] Game-process restart

## Overlay window behavior

- [ ] Overlay is transparent; only badges/UI draw, no window chrome.
- [ ] Overlay is **click-through** — clicks reach League, not the overlay.
- [ ] Overlay never steals focus / never activates (no focus flash, no taskbar
      flash, not in Alt+Tab).
- [ ] Overlay is above League while League is foreground.
- [ ] Overlay is **not** above unrelated apps after Alt+Tab (drops topmost).
- [ ] Overlay follows League window move / resize / resolution change.
- [ ] Overlay hides its content when League is not the valid foreground owner.

## Controlled-game checks (human-played)

- [ ] Initial augment offer renders.
- [ ] Champion detected correctly.
- [ ] Complete champion-data result shown (champion-specific tier/percentage).
- [ ] **Zoe + Dropkick (2006) → `B · 42.6%`** (never `S · 58.0%`).
- [ ] Zoe + Blade Waltz (1006) → `C · 39.9%`.
- [ ] Zoe + Scoped Weapons (1056) → `B · 44.0%`.
- [ ] One-slot reroll updates only that slot.
- [ ] Two-slot reroll updates exactly those slots.
- [ ] All-slot change updates all three atomically.
- [ ] Tooltip hover does not create a false reroll.
- [ ] Cursor over an unresolved title crop → `SCANNING` then `MOVE CURSOR`;
      other slots keep working; badge returns when cursor leaves.
- [ ] Resolved slots keep their badge while the cursor moves.
- [ ] Death-screen offer handled.
- [ ] Shop / modal suppresses the overlay content.
- [ ] Scoreboard (Tab) suppresses appropriately.
- [ ] Offer close clears chips (explicit empty frame, no stale badges).
- [ ] Late/stale OCR result is rejected (no wrong badge over a changed card).
- [ ] Capture-session restart recovers automatically (no manual toggle).
- [ ] League window movement re-aligns the overlay.
- [ ] Monitor movement (drag League to another monitor) re-aligns.
- [ ] DPI change (move between differently-scaled monitors) re-aligns.
- [ ] Game reconnect re-acquires capture and resumes.

## Champion-only data invariants

- [ ] No badge ever shows a global-sourced value.
- [ ] Missing augment in a complete dataset → `NO CHAMP DATA`.
- [ ] Data still loading / partial → `LOADING DATA` (never premature
      `NO CHAMP DATA`).
- [ ] Fetch failure → `DATA ERROR`.
- [ ] Champion change discards the previous champion's dataset.

## Privacy / security

- [ ] No raw frames or screenshots written to disk.
- [ ] No raw OCR text in production logs.
- [ ] No player names / account identifiers in any output.
- [ ] Production build exposes no development diagnostics.

## Packaging

- [ ] NSIS `-setup.exe` installs and launches.
- [ ] MSI installs and launches (if built).
- [ ] Artifact names include product + `0.5.0` + arch.
- [ ] SmartScreen warns (expected: unsigned) — documented, not a blocker.
- [ ] Uninstall removes the app cleanly.

## Sign-off

- Validator: ______________________
- Date: ______________________
- Windows version(s): ______________________
- Result: ☐ Passed  ☐ Failed (see issues)
