import type { TierLetter } from "./model/tier";

// This overlay is champion-only: a badge statistic is always champion-specific.
// There is no "global" scope — a global-sourced statistic never reaches a badge.
export type BadgeStatScope = "champion" | null;

function accessibleWinRate(winRateText: string): string {
  return winRateText.endsWith("%")
    ? `${winRateText.slice(0, -1)} percent`
    : winRateText;
}

export function tierBadgeAccessibleLabel(input: {
  tier: TierLetter;
  winRateText: string | null;
  statScope: BadgeStatScope;
}): string {
  const provenance = input.statScope === "champion" ? "Champion-specific " : "";
  const winRate = input.winRateText === null
    ? ""
    : `, ${accessibleWinRate(input.winRateText)}`;
  return `${provenance}${input.tier} tier${winRate}`;
}

export function TierBadgeLabel(props: {
  tier: TierLetter;
  winRateText: string | null;
  statScope: BadgeStatScope;
}) {
  return (
    <span
      className="badge-label"
      role="group"
      aria-label={tierBadgeAccessibleLabel(props)}
    >
      <span
        className={`badge-tier${props.tier.length > 1 ? " badge-tier-two-char" : ""}`}
      >
        {props.tier}
      </span>
      {props.winRateText !== null && (
        <>
          <span className="badge-chip-sep">·</span>
          <span className="badge-wr">{props.winRateText}</span>
        </>
      )}
    </span>
  );
}
