type PatchSummaryInput = {
  patch?: string | null;
  /** Resolved availability verdict for this entity, when it has one. */
  availabilityStatus?: string | null;
  /** Patch of an OBSERVED lifecycle transition. Absent when undated. */
  lifecyclePatch?: string | null;
  /** Which transition that patch refers to ("added" | "removed"). */
  lifecycleEvent?: string | null;
  /**
   * How the date was established. "snapshot_diff" means we observed the
   * transition between two adjacent snapshots, which dates the OBSERVATION,
   * not Riot's change. Only an authoritative Riot record may carry causal copy.
   */
  lifecycleProvenance?: string | null;
};

/**
 * Pre-localized copy from the route's message namespace. The helper decides
 * WHICH bounded lines may render; it never produces user-facing strings
 * itself, so all copy stays in messages/*.json.
 */
type PatchSummaryCopy = {
  title: string;
  body: (values: { patch: string }) => string;
  /**
   * Distinct wording per resolved availability status. Omit for entity kinds
   * without public availability (e.g. items).
   */
  availability?: (status: string) => string | undefined;
  /** Rendered only when a genuinely dated transition exists. */
  dated?: (values: {
    patch: string;
    event: string;
    provenance: string;
  }) => string | undefined;
};

type PatchSummary = {
  title: string;
  lines: string[];
};

function clean(value: string | null | undefined) {
  const trimmed = value?.trim();
  return trimmed ? trimmed : undefined;
}

/**
 * Returns null when no public patch value exists: freshness claims must trace
 * to published data, so without a patch the summary block is omitted entirely.
 *
 * Two rules keep this block honest, both of which it previously broke:
 *
 *   1. The STATE line comes from the resolved availability verdict, so a
 *      disabled augment is never described as removed.
 *   2. The DATED line renders only from an observed transition. It used to
 *      fall back to the page's patch when no date existed, which made every
 *      non-offerable augment assert "marked removed in patch <whatever clock
 *      this page happened to carry>" — a specific, checkable, false claim.
 */
export function buildPatchSummary(
  input: PatchSummaryInput,
  copy: PatchSummaryCopy,
): PatchSummary | null {
  const patch = clean(input.patch);
  if (!patch) return null;

  const lines = [copy.body({ patch })];

  const status = clean(input.availabilityStatus);
  const stateLine = status ? copy.availability?.(status) : undefined;
  if (stateLine) lines.push(stateLine);

  const lifecyclePatch = clean(input.lifecyclePatch);
  const lifecycleEvent = clean(input.lifecycleEvent);
  if (lifecyclePatch && lifecycleEvent) {
    // Unknown provenance is treated as the weaker claim, never the stronger.
    const provenance = clean(input.lifecycleProvenance) ?? "snapshot_diff";
    const datedLine = copy.dated?.({
      patch: lifecyclePatch,
      event: lifecycleEvent,
      provenance,
    });
    if (datedLine) lines.push(datedLine);
  }

  return {
    title: copy.title,
    lines,
  };
}
