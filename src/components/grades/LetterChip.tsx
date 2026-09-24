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
}: {
  letter: Letter;
  estimated?: boolean;
  thin?: boolean;
  label: string;
  size?: "md" | "lg";
}) {
  const open = estimated || thin;
  const cls = ["grade-chip", `is-${letter}`, open ? "is-open" : "", estimated ? "is-dashed" : "", size === "lg" ? "is-lg" : ""]
    .filter(Boolean)
    .join(" ");
  return (
    <span className={cls} role="img" aria-label={label} data-grade={letter}>
      <span aria-hidden="true">{letter}</span>
    </span>
  );
}
