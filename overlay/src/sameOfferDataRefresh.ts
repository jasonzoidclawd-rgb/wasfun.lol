import type { OfferState } from "./offerLifecycle";
import type { IdentityRecord } from "./surfaceGeometry";

type RefreshedResolution<R> = {
  canonicalAugmentId: string;
  resolution: R;
};

type RefreshRecordMetadata = Pick<
  IdentityRecord<unknown>,
  | "resolvedAt"
  | "championGeneration"
  | "championRequestId"
  | "championPatch"
  | "foregroundEpoch"
  | "gameEpoch"
>;

export interface RefreshSameOfferDataInput<R> {
  identityRecords: Array<IdentityRecord<R> | null>;
  offer: OfferState<R>;
  resolveByCanonicalId: (
    canonicalAugmentId: string,
    regionIndex: number,
  ) => RefreshedResolution<R> | null;
  recordMetadata?: (
    record: IdentityRecord<R>,
    regionIndex: number,
  ) => Partial<RefreshRecordMetadata>;
}

export interface RefreshSameOfferDataResult<R> {
  changed: boolean;
  republish: boolean;
  identityRecords: Array<IdentityRecord<R> | null>;
  offer: OfferState<R>;
}

function derivedContentEqual(left: unknown, right: unknown): boolean {
  if (Object.is(left, right)) return true;
  if (left === null || right === null) return false;
  if (typeof left !== "object" || typeof right !== "object") return false;
  if (Array.isArray(left) || Array.isArray(right)) {
    return Array.isArray(left) &&
      Array.isArray(right) &&
      left.length === right.length &&
      left.every((value, index) => derivedContentEqual(value, right[index]));
  }
  const leftRecord = left as Record<string, unknown>;
  const rightRecord = right as Record<string, unknown>;
  const leftKeys = Object.keys(leftRecord);
  const rightKeys = Object.keys(rightRecord);
  return leftKeys.length === rightKeys.length &&
    leftKeys.every(
      (key) => Object.prototype.hasOwnProperty.call(rightRecord, key) &&
        derivedContentEqual(leftRecord[key], rightRecord[key]),
    );
}

/** Refresh derived slot data without changing same-offer identity ownership. */
export function refreshSameOfferData<R>(
  input: RefreshSameOfferDataInput<R>,
): RefreshSameOfferDataResult<R> {
  let changed = false;
  const identityRecords = input.identityRecords.map((record, regionIndex) => {
    const canonicalAugmentId = record?.augmentId ?? "";
    if (record?.resolution == null || canonicalAugmentId.length === 0) return record;
    const refreshed = input.resolveByCanonicalId(canonicalAugmentId, regionIndex);
    if (
      refreshed == null ||
      refreshed.canonicalAugmentId !== canonicalAugmentId ||
      derivedContentEqual(record.resolution, refreshed.resolution)
    ) {
      return record;
    }
    changed = true;
    return {
      ...record,
      ...input.recordMetadata?.(record, regionIndex),
      resolution: refreshed.resolution,
    };
  });

  if (!changed) {
    return {
      changed: false,
      republish: false,
      identityRecords: input.identityRecords,
      offer: input.offer,
    };
  }

  return {
    changed: true,
    republish: true,
    identityRecords,
    offer: {
      ...input.offer,
      slots: input.offer.slots.map((slot) => ({
        ...slot,
        resolution:
          identityRecords[slot.regionIndex]?.resolution ?? slot.resolution,
      })),
    },
  };
}
