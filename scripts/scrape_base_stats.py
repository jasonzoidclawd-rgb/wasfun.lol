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

    # Build lookup: lowercase name/key → {"id": canonical Riot id, "stats": {...}}
    #
    # Data Dragon is the champion IDENTITY authority for this catalog, not just
    # a stats source. Every champion gets its canonical numeric Riot id stamped
    # here so downstream consumers never have to infer identity from a
    # presentation URL — which is exactly what broke the roster gate when the
    # statistics provider moved its icons to `/icons/<slug>/64.png`, where the
    # trailing number is a pixel size.
    dd_by_name: dict[str, dict] = {}
    for key, info in champ_data.items():
        name = info["name"]
        raw_stats = info["stats"]
        mapped = {}
        for dd_key, our_key in STAT_MAP.items():
            if dd_key in raw_stats:
                mapped[our_key] = raw_stats[dd_key]
        # Fix adGrowth from fallback if broken
        if ad_growth_broken:
            fallback = ad_growth_data.get(name.lower(), ad_growth_data.get(key.lower(), 0))
            mapped["adGrowth"] = fallback
        # asGrowth is given as percent (e.g. 2.0 = 2%), keep as-is for clarity
        entry = {
            "id": str(info.get("key") or ""),
            "stats": mapped,
            # Riot role tags (Fighter/Tank/Mage/...). The statistics provider
            # used to supply these via a `data-tags` attribute; its tier-list
            # markup changed and the structured fallback carries no tags, so
            # 172/173 champions silently lost their roles and the kit-tag
            # classifier stopped seeing e.g. Garen as a tank. Data Dragon is the
            # canonical source for roles — take them from here.
            "tags": [str(tag).lower() for tag in info.get("tags", [])],
        }
        dd_by_name[name.lower()] = entry
        # Also index by key (e.g. "MonkeyKing" for Wukong)
        dd_by_name[key.lower()] = entry
        # And by canonical slug, so slug-matched champions resolve identically.
        dd_by_name[canonical_slug(info.get("id") or key)] = entry

    # 3. Load existing champions.json
    existing = json.loads(OUT.read_text("utf-8"))
    champions = existing["champions"]

    matched = 0
    unmatched = []
    for champ in champions:
        name = champ["name"].lower()
        slug = champ.get("slug", "").lower().replace("-", "").replace("'", "").replace(".", "").replace(" ", "")

        entry = dd_by_name.get(name)
        if not entry:
            # Try slug-based matching (e.g. "drmundo" → "dr. mundo")
            entry = dd_by_name.get(slug) or dd_by_name.get(champ.get("slug", ""))
        if not entry:
            # Try removing spaces/punctuation from DDragon keys
            for dd_name, dd_entry in dd_by_name.items():
                clean = dd_name.replace("'", "").replace(".", "").replace(" ", "").replace("-", "")
                if clean == slug:
                    entry = dd_entry
                    break

        if entry:
            champ["baseStats"] = entry["stats"]
            if entry["tags"] and not champ.get("tags"):
                champ["tags"] = entry["tags"]
            # Canonical identity, stamped explicitly. Downstream gates read this
            # field and never parse an image URL.
            if entry["id"]:
                champ["id"] = entry["id"]
                # Keep the icon on Riot-derived infrastructure keyed by that same
                # canonical id, so presentation cannot drift away from identity
                # when a third party reorganizes its CDN.
                champ["icon"] = CDRAGON_ICON_TEMPLATE.format(champion_id=entry["id"])
            matched += 1
        else:
            unmatched.append(champ["name"])

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
        entry = dd_by_name.get(info["name"].lower()) or dd_by_name.get(key.lower()) or {}
        stats = entry.get("stats", {})
        champion_id = str(info.get("key") or "")
        champions.append({
            "id": champion_id,
            "slug": slug,
            "name": info["name"],
            "tier": None,
            "rank": None,
            "win_rate": None,
            "pick_rate": None,
            "tags": entry.get("tags", []),
            "icon": CDRAGON_ICON_TEMPLATE.format(champion_id=champion_id),
            "baseStats": stats,
        })
        existing_slugs.add(slug)
        added.append(slug)

    if added:
        print(f"Added {len(added)} Data Dragon roster champion(s) without arammayhem stats: {added}")

    tagged = sum(1 for champ in champions if champ.get("tags"))
    identified = sum(1 for champ in champions if champ.get("id"))
    print(f"Matched: {matched}/{len(champions)}")
    print(f"Canonical ids stamped: {identified}/{len(champions)}")
    print(f"Role tags present:     {tagged}/{len(champions)}")
    if unmatched:
        print(f"Unmatched: {unmatched}")

    # 4. Write back
    OUT.write_text(json.dumps(existing, indent=2, ensure_ascii=False) + "\n", encoding="utf-8")
    print(f"Wrote {OUT}")


if __name__ == "__main__":
    main()
