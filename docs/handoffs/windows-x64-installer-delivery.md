# Windows x64 installer delivery

Date: 2026-07-27
Packaging base: `3d5b5268316837661e2891a4a0d1360ac95041be`
Branch: `feat/overlay-tier-card-windows-parity`

## Source boundary

The canonical shared-behavior worktree remained read-only at
`49dd04b97155a13e82d84e5af0a5db9156e9a4f1`. It had no committed hover/R4
change after the Windows parity branch was created. These existing untracked
Claude-owned paths were not read, copied, staged, cleaned, or modified:

- `docs/handoffs/codex-overlay-current-state.md`
- `docs/prompts/`
- `overlay/src/geometrySingleFlight.test.ts`
- `overlay/src/hoverIdentityStability.test.ts`

No Claude commit is available to port in this packaging iteration.

## Reproducible Windows path

The private delivery workflow is
`.github/workflows/windows-overlay-delivery.yml`. It is
`workflow_dispatch`-only, read-only, short-retention, and does not create a
release. It runs:

1. `overlay/scripts/setup-windows-build.ps1`
2. `overlay/scripts/build-windows-release.ps1`
3. root and overlay lockfile installs, tests, ESLint, TypeScript and builds
4. Rust formatting separation, tests, check and Clippy
5. Tauri x64 NSIS and MSI packaging
6. production and deterministic-name audits
7. `dumpbin` PE architecture/subsystem/import inspection
8. build-host install, launch, same-version upgrade, reinstall and uninstall
9. hashes, manifests, dependency licenses and preliminary ZIP generation

The preliminary ZIP deliberately cannot be promoted to the requested final
name. On a disposable clean Windows x64 VM with no build tools and WebView2
initially absent, run the included:

```powershell
.\complete-windows-clean-validation.ps1 `
  -PreliminaryZip .\mayhem-windows-overlay-x64-<commit>-PRELIMINARY.zip `
  -OutputDirectory .\final
```

That command validates hashes, invokes the clean-host installer validation,
requires four screenshots, adds the evidence, and creates the final
`mayhem-windows-overlay-x64-<commit>.zip`.

## Runtime strategy

- WebView2: Tauri 2.10 `offlineInstaller`, which embeds Microsoft's official
  x64 Evergreen standalone installer. This avoids install-time network
  dependence and adds roughly 127 MB.
- Visual C++ runtime: Rust `+crt-static` for
  `x86_64-pc-windows-msvc`. The PE audit fails on `VCRUNTIME`, `MSVCP`, or
  `CONCRT` imports rather than assuming static linkage worked.
- OCR: Windows-provided `Windows.Media.Ocr`, available from Windows 10 build
  10240. At least one compatible Windows OCR language pack must be installed;
  the app already reports the missing-language condition safely. Language
  packs cannot be bundled with the application.
- Renderer/data: Tauri embeds `overlay/dist`; `sync-data.mjs` populates the
  production champion, augment, combo, pool-rule, ability and matching data
  before packaging.
- Signing: the build inspects the current-user code-signing certificate store.
  It signs and timestamps when exactly one valid certificate is available (or
  `MAYHEM_WINDOWS_CERT_THUMBPRINT` selects one). Otherwise it records an
  unsigned private build and the expected SmartScreen warning.

References:

- Tauri WebView2 installation modes:
  <https://v2.tauri.app/distribute/windows-installer/>
- Microsoft WebView2 distribution and runtime detection:
  <https://learn.microsoft.com/en-us/microsoft-edge/webview2/concepts/distribution>
- Windows OCR available recognizer languages:
  <https://learn.microsoft.com/en-us/uwp/api/windows.media.ocr.ocrengine.availablerecognizerlanguages>

## Status (2026-09-25)

The GitHub-hosted Windows path works end to end. Delivery run
[36160962400](https://github.com/jasonzoidclawd-rgb/wasfun.lol/actions/runs/36160962400)
(PR #65, head `ef27ecd`) passed every stage and uploaded
`mayhem-windows-overlay-x64-*-preliminary` (~890 MB, 7-day retention).
The workflow also runs on pull requests that touch the delivery pipeline.

Fixed on the way there, in pipeline order:

1. PR checkouts are detached: the branch name now falls back to
   `GITHUB_HEAD_REF` / `GITHUB_REF_NAME`, and PR runs build the head
   commit, not GitHub's ephemeral merge commit.
2. `.gitattributes` keeps `overlay/src/**/*.ts(x)` LF on Windows, so the
   source-scanning tests match.
3. `examples/geometry_dispatch_bench.rs` is rustfmt-clean (the fmt gate
   only allows the pre-existing debt list).
4. License inventory: Windows PowerShell 5.1's `ConvertFrom-Json` rejects
   lockfile v3's empty root key, so `project-npm-lock.mjs` flattens it.
5. Manifest version probes run in the owning directory and tolerate
   stderr (`npx tauri` from the repo root resolved the wrong package).
6. Binary collection: no comma-joined `Get-Item` calls inside `@( )`.
7. ZIP: files older than 1980 (crates unpack with 1973 mtimes) are
   clamped to 1980-01-02 before `Compress-Archive`.

## Remaining before final delivery

The bundle is deliberately PRELIMINARY. A GitHub-hosted build runner is
not a clean end-user machine: run `complete-windows-clean-validation.ps1`
on a disposable Windows 10/11 x64 VM with WebView2 initially absent, which
adds the four screenshots and produces the final ZIP. League/OCR/capture
behavior still needs controlled validation on real Windows hardware. No
signing certificate is configured, so installers are unsigned
(SmartScreen warning expected).
