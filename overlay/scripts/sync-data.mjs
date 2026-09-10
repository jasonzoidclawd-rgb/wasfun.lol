import { mkdir, rm, writeFile } from "node:fs/promises";
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const overlayRoot = path.resolve(__dirname, "..");
const sourceRoot = path.resolve(overlayRoot, "..", "data", "internal");
const targetRoot = path.resolve(overlayRoot, "public", "data");
const abilityTargetRoot = path.join(targetRoot, "abilities");
const validAugmentSetLabels = new Set([
  "Archmage",
  "Dive Bomb",
  "Dive Bomb Fully Automated",
  "Firecracker",
  "Fully Automated",
  "Fully Automated Wee Woo Wee Woo",
  "High Roller",
  "Make it Rain",
  "Snowday",
  "Stackosaurus Rex",
  "Wee Woo Wee Woo",
]);

function readJson(filename) {
  return JSON.parse(readFileSync(path.join(sourceRoot, filename), "utf-8"));
}

function normalizeLookupKey(value) {
  return value
    .toLowerCase()
    .replace(/&amp;|&#38;|&/g, "and")
    .replace(/[^a-z0-9]+/g, "");
}

function buildAugmentSlugIndex(augments) {
  const index = new Map();
  const ambiguous = new Set();

  for (const augment of augments) {
    for (const value of [augment.slug, augment.name, augment.displayName].filter(Boolean)) {
      const key = normalizeLookupKey(value);
      if (ambiguous.has(key)) continue;
      if (index.has(key) && index.get(key) !== augment.slug) {
        ambiguous.add(key);
        index.delete(key);
      } else {
        index.set(key, augment.slug);
      }
    }
  }

  return index;
}

function normalizeAugmentSet(set, wikiSet) {
  const value = set ?? wikiSet;
  if (!value) return undefined;

  return validAugmentSetLabels.has(value) ? value : undefined;
}

function compactChampion(champion) {
  return {
    slug: champion.slug,
    champion_key: champion.champion_key,
    name: champion.name,
    name_zh_TW: champion.name_zh_TW,
    name_zh_CN: champion.name_zh_CN,
    name_ja: champion.name_ja,
    name_ko: champion.name_ko,
    win_rate: champion.win_rate,
    tags: champion.tags,
    kit_tags: champion.kit_tags,
    baseStats: champion.baseStats,
  };
}

function compactAugment(augment) {
  return {
    slug: augment.slug,
    name: augment.name,
    icon: augment.icon,
    name_zh_CN: augment.name_zh_CN,
    name_zh_TW: augment.name_zh_TW,
    name_ja: augment.name_ja,
    name_ko: augment.name_ko,
    rarity: augment.rarity,
    win_rate: augment.win_rate,
    type: augment.type,
    description: augment.description,
    wikiDescription: augment.wikiDescription,
    notes: augment.notes,
    set: normalizeAugmentSet(augment.set, augment.wikiSet),
    wikiSet: augment.wikiSet,
    kit_tags: augment.kit_tags,
    flags: augment.flags,
  };
}

function compactCombo(combo, augmentSlugByKey) {
  const augmentSlug = combo.augmentSlug ?? augmentSlugByKey.get(normalizeLookupKey(combo.augment));

  return {
    champion: combo.champion,
    augment: combo.augment,
    ...(augmentSlug ? { augmentSlug } : {}),
    tier: combo.tier,
  };
}

async function main() {
  const champions = readJson("champions.json").champions ?? [];
  const augments = readJson("augments.json").augments ?? [];
  const combos = readJson("combos.json").combos ?? [];
  const abilities = readJson("abilities.json").profiles ?? {};
  const poolRules = readJson("pool-rules.json");
  const augmentSlugByKey = buildAugmentSlugIndex(augments);

  await rm(targetRoot, { recursive: true, force: true });
  await mkdir(abilityTargetRoot, { recursive: true });

  await Promise.all([
    writeFile(
      path.join(targetRoot, "champions.json"),
      JSON.stringify({ champions: champions.map(compactChampion) }),
    ),
    writeFile(
      path.join(targetRoot, "augments.json"),
      JSON.stringify({ augments: augments.map(compactAugment) }),
    ),
    writeFile(
      path.join(targetRoot, "combos.json"),
      JSON.stringify({ combos: combos.map((combo) => compactCombo(combo, augmentSlugByKey)) }),
    ),
    writeFile(
      path.join(targetRoot, "pool-rules.json"),
      JSON.stringify(poolRules),
    ),
  ]);

  await Promise.all(
    Object.entries(abilities).map(([slug, profile]) =>
      writeFile(path.join(abilityTargetRoot, `${slug}.json`), JSON.stringify(profile)),
    ),
  );
}

await main();
