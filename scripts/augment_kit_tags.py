#!/usr/bin/env python3
"""Augment scaling profiles for the kit-fit covariate (v3 phase 0).

The pooled model's covariate k_ca flags a champion taking an augment that pays
off a stat its kit doesn't use (an ability-power augment on a physical-damage
champion, or the reverse). That needs one hand-checked tag per augment:

    ad       pays off attacks, attack damage, attack speed or crit
    ap       pays off ability power
    tank     pays off health or resistances
    neutral  anything else (haste, movement, utility, hybrid, gold, snowball ...)

Each profile is first derived from the augment's CDragon text, then every live
augment was read by hand and the derivation confirmed or overridden (OVERRIDES
below, with the reason for each). The result is persisted in
`data/internal/augment-kit-tags.json`; after that only augments a patch adds
need a new tag. An augment with no reviewed tag counts as neutral (k = 0), so
an unchecked tag can never move a grade.

The champion side is Riot's own `tacticalInfo.damageType`, already persisted in
`data/internal/abilities.json` (physical / magic / mixed).

Usage:
    python3 scripts/augment_kit_tags.py            # refresh: keep reviewed tags, derive new ones as unreviewed
"""

from __future__ import annotations

import json
import re
from datetime import date

from data_paths import INTERNAL_DATA_DIR

TAGS_PATH = INTERNAL_DATA_DIR / "augment-kit-tags.json"
CATALOG_PATH = INTERNAL_DATA_DIR / "augments.json"
PROFILES = ("ad", "ap", "tank", "neutral")
LIVE = ("confirmed_live", "candidate_registry_present")

_AP = (r"<scaleap>", r"ability power", r"<magicdamage>", r"\bap\b")
_AD = (r"<scalead>", r"attack damage", r"<physicaldamage>", r"attack speed", r"critical strike",
       r"\bcrit", r"on-hit", r"\battacks?\b", r"lethality", r"armor pen")
_TANK = (r"<scalehealth>", r"\bmax(imum)? health", r"\barmor\b", r"magic resist", r"tenacity", r"bonus health")

# Hand review, 2026-09-24: every live augment's text read; these are the rows where
# the derivation was wrong. Keyed by augmentId.
OVERRIDES: dict[str, tuple[str, str]] = {
    "ARAM_Firebrand": ("ad", "burn is applied by Attacks"),
    "ARAM_MagicMissile": ("neutral", "fires on Ability damage; 'max Health' is the target's"),
    "ARAM_SpiritualPurification": ("neutral", "damage from the target's health, not yours"),
    "ARAM_ThreadtheNeedle": ("neutral", "armor AND magic penetration"),
    "ARAM_Upgrade_Sheen": ("neutral", "Spellblade items exist for both AD and AP"),
    "ARAM_WeeWooWeeWoo": ("neutral", "heal/shield support; 'low Health' is the ally's"),
    "Bonk": ("neutral", "empowers Attacks and Abilities"),
    "BurstingTeeth": ("neutral", "lethality AND magic penetration"),
    "CriticalMissile": ("ad", "triggers on Critical Strikes"),
    "SharkTempest": ("neutral", "snowball effect"),
    "Snowbomb": ("neutral", "snowball effect"),
    "ARAM_EndlessHunt": ("neutral", "Attacks or Abilities, max-health true damage"),
    "ARAM_Earthwake": ("neutral", "triggers on dash abilities; hybrid"),
    "ARAM_CircleofDeath": ("neutral", "damage scales with healing done, not AP"),
    "ARAM_DropBear": ("neutral", "on-death summon"),
    "ARAM_InfernoTriggered": ("neutral", "style meter, any damage"),
    "ARAM_EmpoweredByTheFaithful": ("neutral", "support: triggers on healing or shielding allies"),
    "ARAM_MysticPunch": ("ad", "on-hit (Attacks) refunds cooldowns"),
    "ARAM_OrbitalLaser_Active": ("neutral", "summoner spell, max-health true damage"),
    "ARAM_SlowCooker": ("tank", "burn scales with your max Health"),
    "ARAM_SpiritBomb": ("neutral", "support: healing and shielding allies"),
    "ARAM_SymphonyofWar": ("ad", "Lethal Tempo is an attack-speed keystone"),
    "ARAM_WindspeakersBlessing": ("neutral", "support: healing and shielding allies"),
    "BiggestSnowballEver": ("neutral", "snowball effect"),
    "FinalForm": ("neutral", "ultimate-triggered shield and omnivamp"),
    "GlassCannon": ("neutral", "max-health trade for true damage; any damage type"),
    "PoroCharge_Active": ("neutral", "quest reward summoner spell"),
    "Upgrade_MikaelsBlessing": ("neutral", "support item upgrade"),
    "ARAM_ADAPt": ("ap", "converts bonus AD into AP and amplifies AP"),
    "ARAM_escAPADe": ("ad", "converts AP into bonus AD and amplifies AD"),
    "ARAM_DiveBomber": ("neutral", "team death explosion"),
    "ARAM_Erosion": ("neutral", "shreds the enemy's armor and magic resist"),
    "ARAM_InfernalSoul": ("neutral", "Abilities or Attacks"),
    "ARAM_MindtoMatter": ("neutral", "pays off mana, not tanking"),
    "ARAM_Purist_Caster": ("ap", "converts attack speed into ability haste"),
    "DoubleDefense": ("neutral", "ability shield scaling with the target's missing Health"),
    "EscapePlan": ("neutral", "low-health escape shield"),
    "HextechSoul": ("neutral", "Ability or Attack"),
    "YouSpinMeRightRound": ("neutral", "summoner spell mobility"),
    "ARAM_Snowday": ("neutral", "Mark (snowball) effect"),
}


def derive_profile(augment: dict) -> str:
    text = " ".join(
        (augment.get("effectText") or {}).get(k) or "" for k in ("desc", "tooltip")
    ).lower()
    if "adaptive" in text:
        return "neutral"
    ap = any(re.search(p, text) for p in _AP)
    ad = any(re.search(p, text) for p in _AD)
    tank = any(re.search(p, text) for p in _TANK)
    if ap and not ad:
        return "ap"
    if ad and not ap:
        return "ad"
    if tank and not ap and not ad:
        return "tank"
    return "neutral"


def kit_mismatch(profile: str | None, champion_damage_type: str | None) -> int:
    """k_ca: 1 when the augment pays off the stat the champion's kit doesn't deal."""
    if profile == "ap" and champion_damage_type == "physical":
        return 1
    if profile == "ad" and champion_damage_type == "magic":
        return 1
    return 0


def refresh(catalog: dict, existing: dict, today: str) -> dict:
    tags = dict(existing.get("tags", {}))
    for augment in catalog.get("augments", []):
        augment_id = augment.get("augmentId")
        status = (augment.get("availability") or {}).get("status")
        if not augment_id or status not in LIVE or augment_id in tags:
            continue
        derived = derive_profile(augment)
        tags[augment_id] = {"profile": derived, "derived": derived, "reviewed": False}
    return {
        "schemaVersion": 1,
        "profiles": list(PROFILES),
        "method": "derived from CDragon effect text, then read by hand and confirmed or overridden",
        "champSide": "data/internal/abilities.json profiles.*.damageType (Riot tacticalInfo)",
        "unreviewedPolicy": "an unreviewed tag counts as neutral (k = 0)",
        "review": existing.get("review", {}),
        "tags": dict(sorted(tags.items())),
    }


def initial_review(catalog: dict, today: str) -> dict:
    """The one-time hand review: derive every live augment, apply OVERRIDES, mark reviewed."""
    tags = {}
    for augment in catalog.get("augments", []):
        augment_id = augment.get("augmentId")
        if not augment_id or (augment.get("availability") or {}).get("status") not in LIVE:
            continue
        derived = derive_profile(augment)
        profile, note = OVERRIDES.get(augment_id, (derived, None))
        entry = {"profile": profile, "derived": derived, "reviewed": True}
        if note:
            entry["override"] = note
        tags[augment_id] = entry
    unknown = set(OVERRIDES) - set(tags)
    if unknown:
        raise ValueError(f"overrides for augments that are not live: {sorted(unknown)}")
    return {
        "review": {
            "reviewedAt": today,
            "reviewedBy": "v3 build agent: every live augment's CDragon text read against its derived tag",
            "reviewed": len(tags),
            "overridden": sum(1 for t in tags.values() if "override" in t),
        },
        "tags": tags,
    }


def main() -> None:
    catalog = json.loads(CATALOG_PATH.read_text(encoding="utf-8"))
    today = date.today().isoformat()
    existing = json.loads(TAGS_PATH.read_text(encoding="utf-8")) if TAGS_PATH.exists() else initial_review(catalog, today)
    doc = refresh(catalog, existing, today)
    TAGS_PATH.write_text(json.dumps(doc, indent=1, ensure_ascii=False) + "\n", encoding="utf-8")
    unreviewed = sum(1 for t in doc["tags"].values() if not t["reviewed"])
    print(f"augment kit tags: {len(doc['tags'])} tagged, {unreviewed} unreviewed, review {doc['review']}")


if __name__ == "__main__":
    main()
