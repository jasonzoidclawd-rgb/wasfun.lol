/// <reference types="vite/client" />

interface ImportMetaEnv {
  /** Dev-only flag enabling the in-game tier-card fixture mode (see src/dev/tierFixture.ts). */
  readonly MAYHEM_OVERLAY_TIER_FIXTURE?: string;
  /** Dev-only flag enabling synthetic geometry PREVIEW mode — only when League is
   *  entirely absent, always watermarked (see src/dev/fixtureMode.ts). Independent
   *  of MAYHEM_OVERLAY_TIER_FIXTURE; the tier fixture alone never enables it. */
  readonly MAYHEM_OVERLAY_GEOMETRY_PREVIEW?: string;
  /** Dev-only flag forwarding the console diagnostic stream (identity/publication
   *  lifecycle) to terminal stderr for tee'd trace capture (see
   *  src/dev/publicationDiagnostics.ts). Off by default. */
  readonly MAYHEM_OVERLAY_TRACE?: string;
}

interface ImportMeta {
  readonly env: ImportMetaEnv;
}
