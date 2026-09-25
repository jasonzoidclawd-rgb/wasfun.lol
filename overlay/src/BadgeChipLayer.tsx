import { TierBadgeLabel } from "./TierBadgeLabel";
import { tierClassName, type TierLetter } from "./model/tier";
import type { PositionedBadgeChip } from "./positionedBadgeChips";
import type { SemanticPublication } from "./badgeLayerDiagnostic";

/**
 * One per-slot badge chip: a real recommendation (`tier`) or an explicit slot
 * state — SCANNING (reroll/unreadable), UNMATCHED (Riot identity unresolved),
 * NO CHAMP DATA (complete champion dataset has no row), LOADING DATA (champion
 * dataset still loading), DATA ERROR (champion dataset fetch failed). This
 * overlay is champion-only: no global-sourced statistic ever reaches a chip.
 */
export interface SlotChip {
  regionIndex: number;
  key: string;
  state: "tier" | "scanning" | "unmatched" | "ocr-error" | "no-data" | "loading-data" | "data-error";
  tier: TierLetter | null;
  winRateText: string | null;
  isNew: boolean;
  statScope: "champion" | null;
  semanticPublication?: SemanticPublication;
}

function semanticAttributes(publication: SemanticPublication | undefined) {
  if (!publication) return {};
  return {
    "data-game-epoch": publication.gameEpoch,
    "data-round": publication.round,
    "data-offer-generation": publication.offerGeneration,
    "data-slot": publication.slot,
    "data-publication-generation": publication.publicationGeneration,
    "data-terminal-state": publication.terminalState,
    "data-no-data-verified": String(publication.noDataVerified),
    "data-failure-category": publication.failureCategory ?? "none",
  };
}

/**
 * Per-slot badge chips rendered OUTSIDE the card frames (above the derived card
 * frame, side-anchored as fallback). Each chip reflects its slot's own pipeline
 * state — never stale, never invented. See fixtureMode.ts.
 *
 * This maps the POSITIONED collection, one element per entry with no filtering
 * of its own, so the number of `.badge-chip` elements is exactly
 * `positionedChips.length` — the same number the `[badge-layer]` diagnostic
 * reports. Any drop decision belongs upstream in `positionBadgeChips`, so a
 * chip can never be counted as visible without being painted.
 */
export function BadgeChipLayer({
  positionedChips,
  isPreviewMode,
}: {
  positionedChips: readonly PositionedBadgeChip<SlotChip>[];
  isPreviewMode: boolean;
}) {
  return (
    <>
      {positionedChips.map(({ chip, key, position: pos }) => {
        if (chip.state !== "tier") {
          const label =
            chip.state === "scanning"
              ? "SCANNING"
              : chip.state === "ocr-error"
                ? "OCR ERROR"
                : chip.state === "no-data"
                  ? "NO CHAMP DATA"
                  : chip.state === "loading-data"
                    ? "LOADING DATA"
                    : chip.state === "data-error"
                      ? "DATA ERROR"
                      : "UNMATCHED";
          return (
            <div
              className={`badge-chip badge-chip-${chip.state}`}
              {...semanticAttributes(chip.semanticPublication)}
              key={key}
              style={{ left: pos.left, top: pos.top }}
            >
              <span className="badge-chip-state">{label}</span>
            </div>
          );
        }
        return (
          <div
            className={`badge-chip ${chip.tier ? tierClassName(chip.tier) : ""}${
              isPreviewMode ? " badge-preview" : ""
            }`}
            {...semanticAttributes(chip.semanticPublication)}
            key={key}
            style={{ left: pos.left, top: pos.top }}
          >
            {isPreviewMode && <span className="preview-watermark">PREVIEW</span>}
            {chip.isNew && <span className="badge-new">NEW</span>}
            {chip.tier && (
              <TierBadgeLabel
                tier={chip.tier}
                winRateText={chip.winRateText}
                statScope={chip.statScope}
              />
            )}
          </div>
        );
      })}
    </>
  );
}
