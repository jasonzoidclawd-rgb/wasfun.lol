# Pinned evidence — live verification of the R3/R4 collector render-loop fix

Session recorded 2026-08-27, two ARAM Mayhem games in one overlay process.

| Artifact | Source | Bytes | SHA-256 |
| --- | --- | --- | --- |
| `live-trace.timestamped.jsonl` | `/private/tmp/mayhem-session-20260827-180056/trace.timestamped.jsonl` | 10,417,227 | `ca87682d10077337bc44ef03d6f149cbc85acdd0fa20d9a37d1836a6f1aac962` |
| `live-manifest.json` | same session `manifest.json` | 67,040 | `c76f3af8a9845c2bff60ea92f36e48e9059f13801d4f411264c0e076bb958e6d` |

The trace hash is **identical** to the recorder's own `artifacts.trace.sha256`,
so the pinned copy is the exact bytes the recorder hashed at its frozen
boundary. Verify with `/usr/bin/shasum -a 256 -c pinned.sha256`.

## Deliberately NOT pinned

`screen.mp4` — 2,588,629,341 bytes, sha256
`50178ccea31cc254f2d48fb5d8ec10cdbf14fcc82861da40fef728e4b963eabf`. It stays in
the owner-only session directory `/private/tmp/mayhem-session-20260827-180056`.
It is a full-hour capture of the operator's display; it is too large to commit
and it is private. No frame from it was inspected or cited. The runtime and
round evidence in this report comes entirely from the trace.

## Provenance (from `live-manifest.json`)

- `status: complete`, `repositoryStable: true`
- `repositoryFingerprintStart == repositoryFingerprintFinal ==`
  `5cb151160eaed9e1a5060e85508c98efcc3893e79b12b2b9009a49d54bf24924`
- `traceContinuityVerified: true`, `drainCompleted: true`, `reopens: 0`,
  `maxSilenceMs: 1147` (limit 30,000), `terminalSilenceMs: 102`
- every boundary failure flag false: `boundaryMissing`, `boundaryRotated`,
  `boundaryTruncated`, `boundaryDiscontinuous`, `partialFinalLine`,
  `undecodableRecord`, `sourceReplaced`
- trace inode 69191205 bound to `overlayPid 43770` / `overlayPgid 43428`
- `credentialEnvironmentVerified: true`,
  `forbiddenCredentialNamesPresent: false`
- HEAD at capture: `c014a390db5e1aab7ff4f7a8116f4e185ab390ee`
