import { readMetaFile, readPipelineStatusFile } from "./read-public-file";

/**
 * ARAM Mayhem has two independent clocks and conflating them is the defect this
 * module exists to prevent.
 *
 *   structural — what the game currently does. Authority: Riot's patch notes,
 *                mirrored by the CommunityDragon catalog lane.
 *   statistics — what has been observed and aggregated. Authority: our
 *                statistics provider, which routinely lags the live game.
 *
 * A statistics snapshot labelled 26.17 does not make 26.17 the current patch.
 * Rendering "Patch 26.17 is live" off the statistics clock is how the site
 * spent 59 days asserting a patch that was four releases old.
 */
export type PatchClocks = {
  /** Current game rules/mechanics patch, or null when unproven. */
  structuralPatch: string | null;
  /** Patch the observed statistics were aggregated for. */
  statisticsPatch: string | null;
  statisticsObservedAt: string | null;
  /** True only when both clocks are known AND equal. */
  aligned: boolean;
  /** True when structural truth cannot be proven current. */
  structuralUnproven: boolean;
  degraded: boolean;
  degradedLanes: string[];
};

type PipelineStatus = {
  overall?: string;
  degraded_lanes?: string[];
  structural?: { patch?: string | null };
  statistics?: { patch?: string | null; observed_at?: string | null };
};

function asPatch(value: unknown): string | null {
  return typeof value === "string" && value.trim() ? value.trim() : null;
}

export async function readPatchClocks(): Promise<PatchClocks> {
  type Meta = { patch?: string; scraped_at?: string };
  const meta: Meta = await readMetaFile<Meta>().catch((): Meta => ({}));

  // pipeline-status.json only exists once the pipeline has run with lane
  // reporting. Its absence must degrade honestly, never fabricate alignment.
  const status = await readPipelineStatusFile<PipelineStatus>().catch(() => null);

  const statisticsPatch = asPatch(status?.statistics?.patch) ?? asPatch(meta.patch);
  const structuralPatch = asPatch(status?.structural?.patch);
  const degradedLanes = Array.isArray(status?.degraded_lanes) ? status!.degraded_lanes! : [];

  return {
    structuralPatch,
    statisticsPatch,
    statisticsObservedAt:
      asPatch(status?.statistics?.observed_at) ?? asPatch(meta.scraped_at),
    aligned: Boolean(structuralPatch && statisticsPatch && structuralPatch === statisticsPatch),
    structuralUnproven: structuralPatch === null,
    // Anything that is not an explicit "ok" is degraded: "running" means a
    // refresh is mid-flight, "failed" means it aborted before its required
    // gates, and a missing file means we cannot prove anything at all.
    degraded:
      status === null || status.overall !== "ok" || degradedLanes.length > 0,
    degradedLanes,
  };
}
