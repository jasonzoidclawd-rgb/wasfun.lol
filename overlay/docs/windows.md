# Windows build, runtime & architecture notes

Companion to the [0.5.0 release notes](./release-notes-0.5.0.md) and the
[human validation checklist](./windows-validation-checklist.md).

## Platform architecture

The overlay is one shared pipeline with narrow platform boundaries — it is **not**
duplicated per OS.

| Layer | Where | Windows specifics |
|-------|-------|-------------------|
| Window discovery | `xcap::Window::all` → `window_locator::select_league_window` | Cross-platform. Rejects launcher/minimized/too-small/own-overlay windows. |
| Monitor enumeration | `xcap::Monitor::all` → `calibration` | Cross-platform physical-pixel rects + scale factor. |
| Screen capture | `xcap` `capture_image` | Cross-platform, external, read-only. No injection. |
| Foreground detection | `foreground::classify_foreground` (pure) + `windows_foreground_metadata` | `GetForegroundWindow` / `QueryFullProcessImageNameW` / `GetWindowThreadProcessId`. |
| Overlay window styling | `overlay_window` | `WS_EX_TRANSPARENT/NOACTIVATE/TOOLWINDOW/LAYERED`, `SetWindowPos` topmost. |
| DPI awareness | `overlay_window::set_process_dpi_aware_v2` | `SetProcessDpiAwarenessContext(PER_MONITOR_AWARE_V2)`. |
| Coordinate math | `calibration` (pure) | Same functions on both platforms; tested at 100–200% + negative origins. |
| Champion data / OCR / geometry / reroll / publication | shared TS + Rust | Identical on Windows. |

The only non-portable Rust lives behind `#[cfg(target_os = "windows")]`
(`overlay_window::windows_impl`, the Windows branch of `set_click_through`, the
Windows setup block and `windows_foreground_metadata`). Pure policy (style-flag
computation, topmost policy, window selection, DPI conversions) is unit-tested on
every host.

## Capture backend rationale

Capture uses **`xcap`**, the same external, read-only screen/window capture the
macOS path uses. It requires no process injection, no League memory access and
no game hooks — it composites from the desktop only. A dedicated Windows
Graphics Capture backend was deliberately **not** introduced: `xcap` already
satisfies the read-only capture contract and is exercised by the existing tested
pipeline, so replacing it would add an unverifiable parallel capture surface for
no functional gain. If a future concrete defect proves `xcap` cannot capture a
specific League window mode on Windows, revisit with a cropped, per-window WGC
backend behind a `cfg` gate.

A wholesale capture failure is a **flagged, crop-less outcome**
(`capture_failure_diagnostics`) — every card region reports
`capture_succeeded = false` and no crops are produced (`crop_count == 0`). It is
never interpreted as a valid "the game shows zero cards" observation; card
presence is owned by the separate geometry track.

## DPI behavior

The process declares **Per-Monitor DPI Awareness V2** at startup
(`SetProcessDpiAwarenessContext`), before any window/monitor geometry is read.
This keeps `xcap`'s physical-pixel rects and the overlay window in the same
coordinate space across mixed-DPI monitors and 100 / 125 / 150 / 175 / 200 %
scaling. `calibration::capture_rect_for_monitor` and
`calibration::physical_to_logical_rect` do the physical↔logical conversions and
are unit-tested for each scale, for secondary monitors, and for negative-origin
monitors (a display placed left of / above the primary).

If you prefer a manifest-based declaration instead of the runtime call, embed an
application manifest with
`<dpiAwareness>PerMonitorV2</dpiAwareness>`; the runtime call is a harmless
no-op when the OS already set awareness.

## Overlay window behavior

The single overlay window is created from `tauri.conf.json` (transparent,
decorations off, always-on-top, skip-taskbar) and then styled natively:

- `WS_EX_LAYERED` — per-pixel transparency.
- `WS_EX_TRANSPARENT` — mouse input passes through to the game (click-through).
- `WS_EX_NOACTIVATE` — the overlay never takes focus or steals activation.
- `WS_EX_TOOLWINDOW` — kept out of Alt+Tab / taskbar navigation.
- `SetWindowPos(HWND_TOPMOST | HWND_NOTOPMOST, …, SWP_NOACTIVATE)` — topmost
  **only while League is the foreground owner**; dropped otherwise so the
  overlay never floats over unrelated applications.

Styles and z-order are re-asserted on a ~1.5 s loop (WebView2 can reset extended
styles), mirroring the macOS level re-assert loop. The window is never created
or destroyed at runtime — only restyled/repositioned.

## Build prerequisites (Windows)

- Windows 10 (supported) or Windows 11.
- Rust stable (`rustup default stable`).
- Node.js 22.
- **WebView2 Runtime** (present on Windows 11; installed via bootstrapper by the
  installer on Windows 10).
- **NSIS** for the `-setup.exe` (`choco install nsis`). WiX for MSI is fetched by
  Tauri automatically.
- MSVC build tools (Visual Studio C++ workload) for linking.

## Build commands (Windows)

```powershell
# from repo root
npm ci
cd overlay
npm ci
npm test                         # includes version-consistency guard
npm run build                    # tsc + vite renderer build
cd src-tauri
cargo test                       # native Windows unit/integration tests
cargo clippy --all-targets
cd ..
npm run package:windows          # NSIS + MSI installers
npm run audit:windows-artifact       # forbidden-content / privacy audit
npm run audit:windows-artifact-names # deterministic artifact-name audit
```

Installers are written to
`overlay/src-tauri/target/release/bundle/{nsis,msi}/`.

## Unsigned build warning

These artifacts are **unsigned development / release-candidate** builds. No
code-signing certificate is configured and none is fabricated. Windows
SmartScreen will warn ("Windows protected your PC") on first launch. Do not
represent these as production-signed releases.

## Troubleshooting

| Symptom | Likely cause / fix |
|---------|--------------------|
| **League window not found** | Game not in a real match, window minimized, or below 640×480. Only the game window ("… (TM) Client") is selected — the launcher/LeagueClientUx is intentionally rejected. |
| **Black / empty capture** | GPU/driver capture restriction or exclusive-fullscreen mode. Use borderless windowed. Capture is read-only; a failure shows as flagged diagnostics, not an empty offer. |
| **Stale capture** | Capture session stalled; the re-assert loop and OCR watchdog recover. Alt+Tab to League to force re-acquire. |
| **Wrong scale / offset overlay** | DPI awareness not applied. Confirm `SetProcessDpiAwarenessContext` runs (dev log) or embed a PerMonitorV2 manifest. Verify the monitor scale in the calibration diagnostic. |
| **Overlay offset from cards** | Mixed-DPI monitor move; the calibration re-runs on `get_overlay_calibration`. Move League fully onto one monitor and re-check. |
| **WebView2 missing** | Install the Evergreen WebView2 Runtime (or run the installer, which bootstraps it). |
| **`DATA ERROR` badge** | Champion-augment fetch failed (network/CDN). It never falls back to a global value; retry once connectivity returns. |
| **`NO CHAMP DATA` badge** | The champion's complete dataset genuinely has no row for that augment. This is correct, not an error. |

## Compliance

External, read-only window detection and screen capture only. No process
injection, no League memory reading, no input automation, no matchmaking or
gameplay automation. See the repository `AGENTS.md` overlay-compliance section.
