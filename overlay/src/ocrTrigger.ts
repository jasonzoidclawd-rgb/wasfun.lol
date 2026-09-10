/**
 * OCR-triggering policy (identity track).
 *
 * OCR is expensive and must NOT run every geometry tick. Given the live geometry
 * observation and the current per-slot identity records, this decides exactly
 * which slots need a (re)read:
 *
 *   - a present slot with NO identity record yet (a freshly appeared offer, or a
 *     slot the confirmed-reroll path just cleared);
 *   - a present slot whose stored record predates the current SLOT GENERATION (a
 *     confirmed reroll — only that slot re-reads; untouched slots keep theirs);
 *   - a present slot still UNRESOLVED past the retry deadline (OCR missed it);
 *   - any slot named in `forceSlots` (dev force-refresh).
 *
 * The reroll rule used to be a raw per-frame `fingerprintChanged(record, live)` —
 * the same expression `identityForSlot` used to blank the chip, so every SCANNING
 * frame also queued a redundant OCR run. In the 2026-07-27 trace that produced 54
 * "reroll:N" triggers and 24 OCR runs for ONE offer whose cards never changed,
 * with a 50% discard rate; the discards were decided by whether a ~1-2 s native
 * read happened to land on the same phase of the card's animation square wave.
 * Slot generation is the confirmed-reroll path's own output, so a re-read is
 * requested exactly once per real replacement.
 *
 * When the surface is absent or occluded there is nothing to identify — no OCR.
 * All rules are pure so the policy is unit-tested without IPC or timers.
 */
import { type GeometryObservation, type IdentityRecord } from "./surfaceGeometry";

export interface OcrTriggerInput<R> {
  observation: GeometryObservation;
  /** Current identity record per region (index 0..2), null when never resolved. */
  identities: Array<IdentityRecord<R> | null>;
  /**
   * Confirmed-reroll counter per region. Advanced ONLY by
   * `advanceRerollConfirmation` after sustained agreement, so it moves on real
   * replacements and stays put through hover, animation and occlusion.
   */
  slotGenerations: number[];
  now: number;
  retryMs: number;
  /** Regions to force a re-read regardless of state (dev force-refresh). */
  forceSlots?: number[];
}

export interface OcrTriggerDecision {
  trigger: boolean;
  /** Region indices that need OCR this cycle (empty when trigger is false). */
  slots: number[];
  reason: string;
}

export function decideOcrTrigger<R>(input: OcrTriggerInput<R>): OcrTriggerDecision {
  const { observation, identities, slotGenerations, now, retryMs } = input;
  const force = new Set(input.forceSlots ?? []);
  if (!observation.present || observation.occluded) {
    return { trigger: false, slots: [], reason: observation.occluded ? "occluded" : "absent" };
  }

  const slots: number[] = [];
  const reasons: string[] = [];
  for (const card of observation.cards) {
    if (!card.present) continue;
    const i = card.regionIndex;
    if (force.has(i)) {
      slots.push(i);
      reasons.push(`force:${i}`);
      continue;
    }
    const record = identities[i] ?? null;
    if (record == null) {
      slots.push(i);
      reasons.push(`new:${i}`);
      continue;
    }
    if ((record.slotGeneration ?? 0) !== (slotGenerations[i] ?? 0)) {
      slots.push(i);
      reasons.push(`reroll:${i}`);
      continue;
    }
    const retryAt = record.retryAt ?? (record.resolvedAt + retryMs);
    if (record.resolution == null && now >= retryAt) {
      slots.push(i);
      reasons.push(`retry:${i}`);
    }
  }

  return {
    trigger: slots.length > 0,
    slots,
    reason: slots.length > 0 ? reasons.join(",") : "up-to-date",
  };
}
