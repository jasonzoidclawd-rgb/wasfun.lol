import type { Letter } from "@/lib/score/grade";

/**
 * A grade letter. Shape and text carry the grade, not only colour: solid for
 * well-measured, outlined for thin data, dashed for estimated from other
 * champions. The letter is always real text; the label says what it means.
 */
export function LetterChip({
  letter,
  estimated = false,
  thin = false,
  label,
  size = "md",
  kind = "option",
}: {
  letter: Letter;
  estimated?: boolean;
  thin?: boolean;
  label: string;
  size?: "md" | "lg";
  /**
   * "champion": graded from the champion's own win rate. The augment-statistics
   * kill switch leaves these on; every other letter comes from augment or item
   * statistics and goes with the switch (scripts/verify_kill_switch.py).
   */
  kind?: "option" | "champion";
}) {
  const open = estimated || thin;
  const cls = ["grade-chip", `is-${letter}`, open ? "is-open" : "", estimated ? "is-dashed" : "", size === "lg" ? "is-lg" : ""]
    .filter(Boolean)
    .join(" ");
  return (
    <span className={cls} role="img" aria-label={label} data-grade={letter} data-grade-kind={kind}>
      <span aria-hidden="true">{letter}</span>
    </span>
  );
}
