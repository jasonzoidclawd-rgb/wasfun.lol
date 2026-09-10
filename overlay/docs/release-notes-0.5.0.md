# Mayhem Oracle overlay — 0.5.0

## Highlights

- **Champion-only complete ARAMGG statistics.** Every resolved augment badge is
  derived from the current champion's own complete augment record
  (`/data/champion-augments/{championId}.json`). The badge answers only "how
  does this augment perform for the champion being played?" — never a global
  average.
- **Global fallback removed.** The overlay no longer substitutes a global
  augment statistic when a champion-specific record is missing. Absence and
  loading are explicit states, never a silent global value.
- **Explicit champion-data states.** `LOADING DATA`, `NO CHAMP DATA` and
  `DATA ERROR` replace any global-sourced number. A complete dataset that lacks
  the augment shows `NO CHAMP DATA`; a still-loading/partial dataset keeps
  `LOADING DATA`; a fetch failure shows `DATA ERROR`.
- **Compact scoring badges** unchanged: `grade · percentage` (e.g. `S · 54.1%`),
  no visible `CHAMP`/`GLOBAL` provenance prefix (provenance stays internal and
  diagnostic-only).
- **Windows implementation** with feature parity to macOS (see below).
- Improved offer/reroll state handling, geometry negative-continuity, per-slot
  reroll isolation and OCR-lifecycle fixes carried forward from prior rounds.

## Windows implementation (new in 0.5.0)

The overlay already shared its window discovery, monitor enumeration and screen
capture across platforms through `xcap` (external, read-only). 0.5.0 adds the
Windows-native overlay-window behavior that previously existed only on macOS:

- Transparent, **click-through** (`WS_EX_TRANSPARENT`), **non-activating**
  (`WS_EX_NOACTIVATE`), **tool-window** (`WS_EX_TOOLWINDOW`), layered overlay
  window.
- Correctly **topmost only while League is the foreground owner** — it does not
  float over unrelated applications after Alt+Tab.
- A Windows `set_click_through` equivalent.
- **Per-Monitor DPI Awareness V2** set at process start, so window/capture
  geometry is correct across 100–200% display scaling and mixed-DPI monitors.
- The window repositions/resizes with the League client rectangle (already
  present) and follows foreground z-order via a re-assert loop mirroring macOS.

Champion-only data, OCR, geometry, reroll, tooltip, offer-state and ownership
behavior are identical on Windows — they run on the shared, platform-agnostic
pipeline.

## Packaging

- Windows installers: **NSIS** (`-setup.exe`) and **MSI** (WiX).
- WebView2 via download bootstrapper (no bundled runtime).
- Artifact names carry product, version and architecture, e.g.
  `Mayhem Oracle_0.5.0_x64-setup.exe`, `Mayhem Oracle_0.5.0_x64_en-US.msi`.

## Known limitations

- **Unsigned builds.** Local and CI Windows artifacts are **unsigned
  development / release-candidate** builds. No code-signing certificate is
  configured; Windows SmartScreen will warn on first run. Do not treat these as
  production-signed releases.
- **Windows physical validation is REQUIRED and not yet performed.** See
  [Windows physical-validation status](#windows-physical-validation-status).
- MSI (WiX) packaging is built in CI; verify it on the target Windows
  environment before distribution.

## Windows physical-validation status

**Status: Windows compile-gated; native compilation and packaging via Windows
CI. NOT physically validated.**

- All shared/pure logic (version consistency, champion-only selection, window
  selection, DPI/coordinate conversions, overlay style flags, topmost policy,
  capture-failure classification) is covered by tests that run on macOS and in
  CI.
- The Windows-only Win32 code (`overlay_window::windows_impl`, foreground
  detection) is compiled and unit-tested by the `windows-overlay` GitHub Actions
  job on `windows-latest`. It has **not** been run against a live League client
  on a physical Windows machine.
- Cross-compilation from the macOS development host is **not possible** (a
  transitive C dependency requires the MSVC/Windows SDK toolchain), so native
  Windows compilation happens only in CI.

Before claiming Windows support, complete
[`windows-validation-checklist.md`](./windows-validation-checklist.md) on real
hardware.
