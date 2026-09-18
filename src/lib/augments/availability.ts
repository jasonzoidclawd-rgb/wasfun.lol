/**
 * Which augments are currently offerable is a fact about the live game that
 * changes every patch, so it is read from the catalog and never written down
 * in the UI. A hand-maintained list drifts silently: the page once named three
 * augments as disabled while the catalog held ten, one of the three was live,
 * and one did not exist at all.
 *
 * `availability.status` is the single authority. `flags.lifecycle` is not — it
 * maps four distinct states onto "removed", which is what made a temporarily
 * disabled augment indistinguishable from one deleted patches ago.
 */

export interface AvailabilityRecord {
  availability?: { status?: string };
}

export const LIVE_STATUS = "confirmed_live";
export const DISABLED_STATUS = "disabled";

export function isConfirmedLive(augment: AvailabilityRecord): boolean {
  return augment.availability?.status === LIVE_STATUS;
}

export function isDisabled(augment: AvailabilityRecord): boolean {
  return augment.availability?.status === DISABLED_STATUS;
}

/**
 * Split the catalog into what can be offered now and what cannot. An augment
 * with no resolved status is in neither list: an unknown state is not evidence
 * that it is live, nor that it was withdrawn.
 */
export function partitionByAvailability<T extends AvailabilityRecord>(
  augments: T[],
): { current: T[]; notOffered: T[] } {
  const current: T[] = [];
  const notOffered: T[] = [];
  for (const augment of augments) {
    const status = augment.availability?.status;
    if (!status) continue;
    if (status === LIVE_STATUS) current.push(augment);
    else notOffered.push(augment);
  }
  return { current, notOffered };
}

/**
 * Disabled first: it is a fact about the CURRENT patch, unlike the historical
 * entries below it.
 */
export function notOfferedRank(augment: AvailabilityRecord): number {
  return isDisabled(augment) ? 0 : 1;
}
