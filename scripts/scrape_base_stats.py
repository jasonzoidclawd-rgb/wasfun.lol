"""
Mayhem Oracle — Champion Base Stats Scraper
============================================
Fetches champion base stats + per-level growth from Riot Data Dragon,
then merges them into data/internal/champions.json.

Usage:
    python scripts/scrape_base_stats.py

Source: https://ddragon.leagueoflegends.com/cdn/{version}/data/en_US/champion.json
"""

from __future__ import annotations
import json
import re
from pathlib import Path
from urllib.request import urlopen, Request

from champion_slug_aliases import canonical_champion_slug
from data_paths import INTERNAL_DATA_DIR

HEADERS = {"User-Agent": "Mozilla/5.0 (Mayhem-Oracle-Scraper/1.0)"}
OUT = INTERNAL_DATA_DIR / "champions.json"
CDRAGON_ICON_TEMPLATE = (
    "https://raw.communitydragon.org/latest/plugins/"
    "rcp-be-lol-game-data/global/default/v1/champion-icons/{champion_id}.png"
)

# DDragon broke attackdamageperlevel in v16.5.1 (returns 0 for all champions).
# Use v16.4.1 for AD growth, latest version for everything else.
AD_GROWTH_FALLBACK_VERSION = "16.4.1"

# DDragon stat keys → our field names
STAT_MAP = {
    "hp":                  "baseHP",
    "hpperlevel":          "hpGrowth",
    "armor":               "baseArmor",
    "armorperlevel":       "armorGrowth",
    "spellblock":          "baseMR",
    "spellblockperlevel":  "mrGrowth",
    "attackdamage":        "baseAD",
    "attackdamageperlevel":"adGrowth",
    "attackspeed":         "baseAS",
    "attackspeedperlevel": "asGrowth",
    "attackrange":         "attackRange",
    "movespeed":           "moveSpeed",
    "mp":                  "baseMP",
    "mpperlevel":          "mpGrowth",
    "hpregen":             "baseHPRegen",
    "hpregenperlevel":     "hpRegenGrowth",
}


def canonical_slug(ddragon_id: str) -> str:
    """Convert a Data Dragon champion key into the site's canonical slug."""
    slug = re.sub(r"[^a-z0-9]+", "-", ddragon_id.lower()).strip("-")
    return canonical_champion_slug(slug)


def fetch_json(url: str):
    req = Request(url, headers=HEADERS)
    with urlopen(req, timeout=15) as resp:
        return json.loads(resp.read())


def enrich_champion_rows(champions, champ_data, ad_growth_data=None):
    """Attach Riot numeric champion keys and base stats by canonical identity."""
    ad_growth_data = ad_growth_data or {}
    by_slug = {}
    for key, info in champ_data.items():
        champion_key = str(info.get("key") or "")
        if not champion_key.isdigit():
            continue
        raw_stats = info.get("stats") or {}
        mapped = {
            our_key: raw_stats[dd_key]
            for dd_key, our_key in STAT_MAP.items()
            if dd_key in raw_stats
        }
        fallback = ad_growth_data.get(
            str(info.get("name") or "").lower(),
            ad_growth_data.get(key.lower()),
        )
        if fallback is not None:
            mapped["adGrowth"] = fallback
        by_slug[canonical_slug(str(info.get("id") or key))] = (champion_key, mapped)

    matched = 0
    unmatched = []
    for champion in champions:
        resolved = by_slug.get(canonical_champion_slug(str(champion.get("slug") or "")))
        if resolved is None:
            unmatched.append(champion.get("name") or champion.get("slug") or "unknown")
            continue
        champion["champion_key"], champion["baseStats"] = resolved
        matched += 1
    return matched, unmatched


def main():
    # 1. Get latest DDragon version
    versions = fetch_json("https://ddragon.leagueoflegends.com/api/versions.json")
    version = versions[0]
    print(f"DDragon version: {version}")

    # 2. Fetch all champion stats (latest version)
    url = f"https://ddragon.leagueoflegends.com/cdn/{version}/data/en_US/champion.json"
    ddragon = fetch_json(url)
    champ_data = ddragon["data"]
    print(f"DDragon champions: {len(champ_data)}")

    # 2b. Check if adGrowth is broken (all zeros) — use fallback version if so
    ad_growth_broken = all(
        info["stats"].get("attackdamageperlevel", 0) == 0
        for info in champ_data.values()
    )
    ad_growth_data: dict[str, float] = {}
    if ad_growth_broken:
        print(f"  ⚠ adGrowth is 0 for all champions in {version}, using fallback {AD_GROWTH_FALLBACK_VERSION}")
        fb_url = f"https://ddragon.leagueoflegends.com/cdn/{AD_GROWTH_FALLBACK_VERSION}/data/en_US/champion.json"
        fb_data = fetch_json(fb_url)["data"]
        for key, info in fb_data.items():
            ad_growth_data[info["name"].lower()] = info["stats"].get("attackdamageperlevel", 0)
            ad_growth_data[key.lower()] = info["stats"].get("attackdamageperlevel", 0)

    # 3. Load existing champions.json
    existing = json.loads(OUT.read_text("utf-8"))
    champions = existing["champions"]

    # Data Dragon is the authoritative active roster. arammayhem may lag a
    # newly released champion's statistical feed, but a missing stat row must
    # never remove the champion identity from the generated catalog. Keep the
    # existing schema and make every third-party statistical field explicit.
    existing_slugs = {champ.get("slug") for champ in champions}
    added = []
    for key, info in champ_data.items():
        slug = canonical_slug(info.get("id") or key)
        if not slug or slug in existing_slugs:
            continue
        champion_id = str(info.get("key") or "")
        champions.append({
            "slug": slug,
            "name": info["name"],
            "tier": None,
            "rank": None,
            "win_rate": None,
            "pick_rate": None,
            "tags": [str(tag).lower() for tag in info.get("tags", [])],
            "icon": CDRAGON_ICON_TEMPLATE.format(champion_id=champion_id),
            "champion_key": champion_id,
            "baseStats": {},
        })
        existing_slugs.add(slug)
        added.append(slug)

    if added:
        print(f"Added {len(added)} Data Dragon roster champion(s) without arammayhem stats: {added}")

    matched, unmatched = enrich_champion_rows(champions, champ_data, ad_growth_data)

    print(f"Matched: {matched}/{len(champions)}")
    if unmatched:
        print(f"Unmatched: {unmatched}")

    # 4. Write back
    OUT.write_text(json.dumps(existing, indent=2, ensure_ascii=False) + "\n", encoding="utf-8")
    print(f"Wrote {OUT}")


if __name__ == "__main__":
    main()
