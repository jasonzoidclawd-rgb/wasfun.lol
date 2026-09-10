import { abilityAugmentFit } from "./ability-augment-fit";
import { computeOracleScore, type ComboTier, type ScoredAugment } from "./oracle-score";
import {
  probabilityOfTarget,
  scoreToTier,
  type ChampionPoolBreakdown,
  type PoolAugment,
} from "./probability";
import type { AbilityProfile } from "./types";

export type OverlayAugmentLookup = Map<string, PoolAugment>;

export interface AugmentMatchDiagnostic {
  augment: PoolAugment | null;
  normalizedText: string;
  bestCandidate: string | null;
  confidence: number | null;
  rejectionReason: string | null;
}

function levenshtein(a: string, b: string): number {
  const m = a.length;
  const n = b.length;
  const dp: number[][] = Array.from({ length: m + 1 }, () => Array(n + 1).fill(0));

  for (let i = 0; i <= m; i++) dp[i][0] = i;
  for (let j = 0; j <= n; j++) dp[0][j] = j;

  for (let i = 1; i <= m; i++) {
    for (let j = 1; j <= n; j++) {
      dp[i][j] = a[i - 1] === b[j - 1]
        ? dp[i - 1][j - 1]
        : 1 + Math.min(dp[i - 1][j], dp[i][j - 1], dp[i - 1][j - 1]);
    }
  }

  return dp[m][n];
}

function isHanText(value: string): boolean {
  return /^\p{Script=Han}+$/u.test(value);
}

function hanOnly(value: string): string {
  return value.match(/\p{Script=Han}/gu)?.join("") ?? "";
}

function matchCjkTextWindow(
  cleaned: string,
  lookup: OverlayAugmentLookup,
): PoolAugment | null {
  const cleanedHan = hanOnly(cleaned);
  if (cleanedHan.length < 3) return null;

  let bestMatch: PoolAugment | null = null;
  let bestDistance = Infinity;
  let ambiguous = false;

  for (const [name, augment] of lookup) {
    if (name.length < 4 || !isHanText(name)) continue;

    let distance = Infinity;
    const minWindowLength = Math.max(1, name.length - 1);
    const maxWindowLength = Math.min(cleanedHan.length, name.length + 1);

    for (let windowLength = minWindowLength; windowLength <= maxWindowLength; windowLength++) {
      for (let start = 0; start <= cleanedHan.length - windowLength; start++) {
        distance = Math.min(
          distance,
          levenshtein(cleanedHan.slice(start, start + windowLength), name),
        );
      }
    }

    if (distance > 1) continue;

    if (distance < bestDistance) {
      bestMatch = augment;
      bestDistance = distance;
      ambiguous = false;
    } else if (distance === bestDistance && bestMatch?.slug !== augment.slug) {
      ambiguous = true;
    }
  }

  return ambiguous ? null : bestMatch;
}

export function normalizeAugmentNameForLookup(value: string): string {
  return value
    .normalize("NFKC")
    .toLowerCase()
    .replace(/[’‘`]/g, "'")
    .replace(/[\s:：'".,!！?？-]/g, "");
}

function addName(
  lookup: OverlayAugmentLookup,
  name: string | undefined,
  augment: PoolAugment,
) {
  if (!name) return;
  const key = normalizeAugmentNameForLookup(name);
  if (key) lookup.set(key, augment);
}

function poolAugmentsBySlug(poolData: ChampionPoolBreakdown | null): Map<string, PoolAugment> {
  const map = new Map<string, PoolAugment>();
  if (!poolData) return map;

  for (const augment of [
    ...poolData.silver.augments,
    ...poolData.gold.augments,
    ...poolData.prismatic.augments,
  ]) {
    map.set(augment.slug, augment);
  }

  return map;
}

function rarityCounts(augments: ScoredAugment[]): Record<ScoredAugment["rarity"], number> {
  return augments.reduce(
    (accumulator, augment) => {
      accumulator[augment.rarity] += 1;
      return accumulator;
    },
    { silver: 0, gold: 0, prismatic: 0 },
  );
}

function fallbackScoredAugment(args: {
  augment: ScoredAugment;
  championWinRate?: number | null;
  comboTier?: ComboTier;
  abilityProfile?: AbilityProfile;
  rarityTotal: number;
}): PoolAugment {
  const { augment, championWinRate, comboTier, abilityProfile, rarityTotal } = args;
  const result = computeOracleScore({
    augment,
    championWinRate: championWinRate ?? undefined,
    comboTier,
    abilityProfile,
    isSystemBreaker: augment.flags?.system_breaker === true,
    abilityAugmentFit: abilityAugmentFit(
      { slug: augment.slug, type: augment.type, wikiDescription: augment.wikiDescription },
      abilityProfile,
    ),
  });

  return {
    slug: augment.slug,
    name: augment.name,
    name_zh_TW: augment.name_zh_TW,
    lifecycle: augment.flags?.lifecycle,
    win_rate: augment.win_rate ?? 50,
    score: result.total,
    tier: scoreToTier(result.total),
    rarity: augment.rarity,
    probability: probabilityOfTarget(rarityTotal, 1, 3),
    probabilityWithReroll: probabilityOfTarget(rarityTotal, 1, 6),
  };
}

export function buildOverlayAugmentLookup(args: {
  allAugments: ScoredAugment[];
  poolData: ChampionPoolBreakdown | null;
  championWinRate?: number | null;
  comboTiers?: Map<string, ComboTier>;
  abilityProfile?: AbilityProfile;
}): OverlayAugmentLookup {
  const lookup: OverlayAugmentLookup = new Map();
  const poolBySlug = poolAugmentsBySlug(args.poolData);
  const counts = rarityCounts(args.allAugments);

  // The OCR lookup deliberately includes augments the catalog marks as
  // removed / not confirmed live: a card OCR'd from a real offer screen is
  // direct evidence the augment IS offerable (catalog lifecycle can lag the
  // live game — e.g. 疾速追擊 / pursuit-of-haste on 26.13). Lifecycle
  // exclusion still applies to pool PREDICTION in the pool orchestrator.
  // Non-live entries are added FIRST so a live augment always wins a
  // normalized-name collision.
  const isNonLive = (augment: ScoredAugment): boolean => {
    const availabilityStatus = augment.availability?.status;
    return availabilityStatus
      ? availabilityStatus !== "confirmed_live"
      : augment.flags?.lifecycle === "removed";
  };
  const ordered = [
    ...args.allAugments.filter(isNonLive),
    ...args.allAugments.filter((augment) => !isNonLive(augment)),
  ];

  for (const augment of ordered) {
    const scored = poolBySlug.get(augment.slug) ?? fallbackScoredAugment({
      augment,
      championWinRate: args.championWinRate,
      comboTier: args.comboTiers?.get(augment.slug),
      abilityProfile: args.abilityProfile,
      rarityTotal: counts[augment.rarity],
    });

    addName(lookup, augment.name, scored);
    addName(lookup, augment.name_zh_TW, scored);
    addName(lookup, augment.name_zh_CN, scored);
    addName(lookup, augment.name_ja, scored);
    addName(lookup, augment.name_ko, scored);
  }

  return lookup;
}

export function matchAugmentName(
  ocrText: string,
  lookup: OverlayAugmentLookup,
): PoolAugment | null {
  if (!ocrText) return null;
  const cleaned = normalizeAugmentNameForLookup(ocrText);
  if (!cleaned) return null;

  const exact = lookup.get(cleaned);
  if (exact) return exact;

  for (const [name, augment] of lookup) {
    if (cleaned.length >= 2 && name.length >= 2 && (cleaned.includes(name) || name.includes(cleaned))) {
      return augment;
    }
  }

  const cjkTitleMatch = matchCjkTextWindow(cleaned, lookup);
  if (cjkTitleMatch) return cjkTitleMatch;

  let bestMatch: PoolAugment | null = null;
  let bestDist = Infinity;
  for (const [name, augment] of lookup) {
    const dist = levenshtein(cleaned, name);
    const threshold = Math.ceil(Math.min(cleaned.length, name.length) * 0.3);
    if (dist <= threshold && dist < bestDist) {
      bestDist = dist;
      bestMatch = augment;
    }
  }

  return bestMatch;
}

export function diagnoseAugmentMatch(
  ocrText: string,
  lookup: OverlayAugmentLookup,
): AugmentMatchDiagnostic {
  const normalizedText = normalizeAugmentNameForLookup(ocrText);
  if (!normalizedText) {
    return {
      augment: null,
      normalizedText,
      bestCandidate: null,
      confidence: null,
      rejectionReason: "empty-after-normalization",
    };
  }

  const augment = matchAugmentName(ocrText, lookup);
  if (augment) {
    const exact = lookup.get(normalizedText);
    if (exact?.slug === augment.slug) {
      return {
        augment,
        normalizedText,
        bestCandidate: augment.slug,
        confidence: 1,
        rejectionReason: null,
      };
    }

    const substring = [...lookup.entries()].find(
      ([name, candidate]) =>
        candidate.slug === augment.slug &&
        normalizedText.length >= 2 &&
        name.length >= 2 &&
        (normalizedText.includes(name) || name.includes(normalizedText)),
    );
    return {
      augment,
      normalizedText,
      bestCandidate: augment.slug,
      confidence: substring ? 0.95 : 0.8,
      rejectionReason: null,
    };
  }

  let bestCandidate: PoolAugment | null = null;
  let bestDistance = Infinity;
  let bestThreshold = 0;
  for (const [name, candidate] of lookup) {
    const distance = levenshtein(normalizedText, name);
    const threshold = Math.ceil(Math.min(normalizedText.length, name.length) * 0.3);
    if (distance < bestDistance) {
      bestCandidate = candidate;
      bestDistance = distance;
      bestThreshold = threshold;
    }
  }

  if (!bestCandidate) {
    return {
      augment: null,
      normalizedText,
      bestCandidate: null,
      confidence: null,
      rejectionReason: "catalog-empty",
    };
  }

  const confidence = Math.max(
    0,
    1 - bestDistance / Math.max(normalizedText.length, bestCandidate.name.length),
  );
  return {
    augment: null,
    normalizedText,
    bestCandidate: bestCandidate.slug,
    confidence,
    rejectionReason: `distance-${bestDistance}-exceeds-threshold-${bestThreshold}`,
  };
}
