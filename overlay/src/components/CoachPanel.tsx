import type {
  DecisionMode,
  DecisionResult,
} from "../contracts/decision";
import { localizedGrade } from "../model/presentation";
import { formatWinRate, tierClassName, tierForGrade } from "../model/tier";

interface CoachPanelProps {
  open: boolean;
  result: DecisionResult | null;
  mode: DecisionMode;
  onModeChange: (mode: DecisionMode) => void;
  winRateBySlug: Record<string, number | string | null>;
  /** Dev tier-fixture only: show raw win-rate precision instead of 1 decimal. */
  rawWinRate?: boolean;
}

function interaction(
  candidate: DecisionResult["candidates"][number],
  match: (reason: string) => boolean,
): string {
  return candidate.reasons.find(match) ?? "neutral";
}

export function CoachPanel({
  open,
  result,
  mode,
  onModeChange,
  winRateBySlug,
  rawWinRate = false,
}: CoachPanelProps) {
  if (!open) return null;

  return (
    <aside className="coach-panel">
      <header>
        <div>
          <strong>Oracle Coach</strong>
          <span>{result?.modelVersion ?? "Verified model unavailable"}</span>
        </div>
        <kbd>C</kbd>
      </header>
      <div className="coach-mode" role="group" aria-label="Decision mode">
        {(["competitive", "exploration"] as const).map((value) => (
          <button
            className={mode === value ? "active" : ""}
            key={value}
            onClick={() => onModeChange(value)}
          >
            {value}
          </button>
        ))}
      </div>
      <p className="coach-hint">Confirm a picked card with 1, 2, or 3.</p>
      {!result && <p>Open an augment screen to see ranked options.</p>}
      {result?.candidates.map((candidate, index) => {
        const tier = tierForGrade(candidate.grade);
        return (
        <section className="coach-candidate" key={candidate.augmentSlug}>
          <div className="coach-rank">
            <span>#{index + 1} {candidate.augmentSlug}</span>
            <strong className={`tier-chip ${tierClassName(tier)}`}>
              {tier}
            </strong>
          </div>
          <div className="coach-stats">
            <span className="coach-wr">
              {formatWinRate(winRateBySlug[candidate.augmentSlug], { raw: rawWinRate })}
            </span>
            <span>{localizedGrade(candidate.grade, navigator.language)}</span>
          </div>
          <span>{candidate.confidence} confidence</span>
          {candidate.warnings.length > 0 && (
            <strong className="coach-warning">{candidate.warnings.join(" · ")}</strong>
          )}
          <span>{candidate.reasons.join(" · ")}</span>
          <span>
            Skill: {interaction(candidate, (reason) =>
              reason.includes("ability") || reason.includes("mechanical"))}
          </span>
          <span>
            Items: {interaction(candidate, (reason) => reason.includes("items"))}
          </span>
          <span>
            Round: {interaction(candidate, (reason) => reason.startsWith("round:"))}
          </span>
        </section>
        );
      })}
    </aside>
  );
}
