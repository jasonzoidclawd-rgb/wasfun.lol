#!/usr/bin/env python3
"""Fixture tests for two-lane CDragon promotion and failure behavior."""

from __future__ import annotations

import json
import tempfile
import unittest
from pathlib import Path

import re
from urllib.error import HTTPError

from cdragon_patch_pipeline import (
    _latest_patch_label,
    build_branch_update,
    fetch_branch_entities,
    promote_branch,
    read_snapshot_lineage,
)
from cdragon_snapshot_diff import (
    SnapshotValidationError,
    build_snapshot,
    compare_snapshots,
    snapshot_filename,
)


def entity(entity_id: str, slug: str, **fields: object) -> dict:
    return {"id": entity_id, "slug": slug, "names": {"en": slug}, "fields": fields}


def snapshot(entity_type: str, branch: str, version: str, rows: list[dict]) -> dict:
    return build_snapshot(
        entity_type=entity_type,
        branch=branch,
        source_version=version,
        source_patch_label=("26.13" if branch == "latest" else f"pbe-cycle-{version}"),
        observed_at="2026-07-11T00:00:00Z",
        entities=rows,
    )


def entities(version_delta: int = 0) -> dict[str, list[dict]]:
    return {
        "augment": [entity("A", "augment", rarity="gold")],
        "champion": [entity("63", "brand", abilities={"Q": {"cooldown": [8 - version_delta]}})],
        "item": [entity("1001", "boots", cost=300 + version_delta * 50)],
    }


class CDragonPatchPipelineTests(unittest.TestCase):
    def test_independent_latest_and_pbe_lineages_keep_provenance_isolated(self):
        latest = build_branch_update(
            branch="latest",
            source_version="16.13.2",
            source_patch_label="26.13",
            observed_at="2026-07-11T01:00:00Z",
            entities_by_type=entities(0),
            previous_snapshots={},
            latest_snapshots={},
            previous_archive=None,
        )
        pbe = build_branch_update(
            branch="pbe",
            source_version="16.14.1",
            source_patch_label="pbe-cycle-16.14.1",
            observed_at="2026-07-11T01:00:00Z",
            entities_by_type=entities(1),
            previous_snapshots={},
            latest_snapshots=latest["snapshots"],
            previous_archive=None,
        )

        self.assertEqual(set(latest["snapshots"]), {"augment", "champion", "item"})
        self.assertEqual(set(pbe["snapshots"]), {"augment", "champion", "item"})
        self.assertTrue(all(row["branch"] == "latest" for row in latest["snapshots"].values()))
        self.assertTrue(all(row["branch"] == "pbe" for row in pbe["snapshots"].values()))
        self.assertEqual(pbe["archive"]["branch"], "pbe")
        self.assertEqual(pbe["archive"]["status"], "fresh")
        self.assertTrue(all(event["branch"] == "pbe" for event in pbe["archive"]["events"]))
        self.assertTrue(all(event["comparison"]["base_branch"] == "latest" for event in pbe["archive"]["events"]))

    def test_live_hotfix_and_preview_to_live_landing_are_not_duplicated(self):
        latest_old = {kind: snapshot(kind, "latest", "16.13.1", rows) for kind, rows in entities(0).items()}
        latest_new = build_branch_update(
            branch="latest",
            source_version="16.13.2",
            source_patch_label="26.13",
            observed_at="2026-07-11T02:00:00Z",
            entities_by_type=entities(1),
            previous_snapshots=latest_old,
            latest_snapshots={},
            previous_archive=None,
        )
        self.assertTrue(any(event["is_hotfix"] for event in latest_new["archive"]["events"]))

        pbe_old = {kind: snapshot(kind, "pbe", "16.14.1", rows) for kind, rows in entities(0).items()}
        pbe = build_branch_update(
            branch="pbe",
            source_version="16.14.2",
            source_patch_label="pbe-cycle-16.14.2",
            observed_at="2026-07-11T01:00:00Z",
            entities_by_type=entities(1),
            previous_snapshots=pbe_old,
            latest_snapshots=latest_old,
            previous_archive=None,
        )
        landed = build_branch_update(
            branch="pbe",
            source_version="16.14.2",
            source_patch_label="pbe-cycle-16.14.2",
            observed_at="2026-07-12T01:00:00Z",
            entities_by_type=entities(1),
            previous_snapshots=pbe["snapshots"],
            latest_snapshots=latest_new["snapshots"],
            previous_archive=pbe["archive"],
        )

        self.assertEqual(len(landed["archive"]["events"]), len(pbe["archive"]["events"]))
        self.assertTrue(all(event["landed"] for event in landed["archive"]["events"]))

    def test_pbe_version_regression_starts_a_fresh_lineage_without_removals(self):
        previous = {kind: snapshot(kind, "pbe", "16.14.9", rows) for kind, rows in entities(1).items()}
        prior_archive = {
            "schema_version": 1,
            "branch": "pbe",
            "lane": "preview",
            "events": [{"entity_type": "item", "slug": "old", "lifecycle": "upcoming", "landed": False}],
        }
        update = build_branch_update(
            branch="pbe",
            source_version="16.14.1",
            source_patch_label="pbe-cycle-16.14.1",
            observed_at="2026-07-11T01:00:00Z",
            entities_by_type=entities(0),
            previous_snapshots=previous,
            latest_snapshots={},
            previous_archive=prior_archive,
        )

        self.assertTrue(update["reset"])
        self.assertEqual(update["new_events"], [])
        self.assertEqual(update["archive"]["events"][0]["lifecycle"], "aged_out")

    def test_current_pbe_without_a_latest_baseline_is_not_mislabeled_as_no_changes(self):
        update = build_branch_update(
            branch="pbe",
            source_version="16.14.1",
            source_patch_label="pbe-cycle-16.14.1",
            observed_at="2026-07-11T01:00:00Z",
            entities_by_type=entities(1),
            previous_snapshots={},
            latest_snapshots={},
            previous_archive=None,
        )

        self.assertEqual(update["archive"]["status"], "not_yet_confirmed")
        self.assertEqual(update["archive"]["events"], [])

    def test_stale_latest_baseline_keeps_pbe_unconfirmed(self):
        latest = build_branch_update(
            branch="latest",
            source_version="16.13.2",
            source_patch_label="26.13",
            observed_at="2026-07-11T01:00:00Z",
            entities_by_type=entities(0),
            previous_snapshots={},
            latest_snapshots={},
            previous_archive=None,
        )
        pbe = build_branch_update(
            branch="pbe",
            source_version="16.14.1",
            source_patch_label="pbe-cycle-16.14.1",
            observed_at="2026-07-11T02:00:00Z",
            entities_by_type=entities(1),
            previous_snapshots={},
            latest_snapshots=latest["snapshots"],
            previous_archive=None,
            latest_baseline_confirmed=False,
        )

        self.assertEqual(pbe["archive"]["status"], "not_yet_confirmed")
        self.assertEqual(pbe["archive"]["events"], [])

    def test_lineage_reader_rejects_malformed_snapshot_without_falling_back_to_another_lane(self):
        with tempfile.TemporaryDirectory() as tmpdir:
            internal = Path(tmpdir)
            (internal / snapshot_filename("item", "pbe")).write_text("{bad", encoding="utf-8")
            (internal / snapshot_filename("item", "latest")).write_text(
                json.dumps(snapshot("item", "latest", "16.13.1", [entity("1", "boots")])),
                encoding="utf-8",
            )

            with self.assertRaisesRegex(ValueError, "malformed"):
                read_snapshot_lineage(internal, "pbe")

    def test_failed_pbe_acquisition_does_not_promote_or_mutate_live_lineage(self):
        with tempfile.TemporaryDirectory() as tmpdir:
            internal = Path(tmpdir)
            latest = snapshot("item", "latest", "16.13.1", [entity("1", "boots")])
            latest_path = internal / snapshot_filename("item", "latest")
            latest_path.write_text(json.dumps(latest), encoding="utf-8")
            before = latest_path.read_bytes()

            def unavailable(_url: str):
                raise OSError("fixture PBE source unavailable")

            with self.assertRaisesRegex(OSError, "source unavailable"):
                promote_branch("pbe", internal_dir=internal, fetch_json=unavailable)

            self.assertEqual(latest_path.read_bytes(), before)
            self.assertFalse((internal / snapshot_filename("item", "pbe")).exists())


if __name__ == "__main__":
    unittest.main()


# ── CDragon source-shape regression (2026-09 Jade_* variants) ────────────────
# Riot began shipping derived champion records inside champion-summary.json.
# They have no character bin, so the pre-fix pipeline 404'd and aborted the
# whole lane, which stopped all publishing for 59 days.

BIN_PAYLOAD = {
    "Characters/Annie": {
        "__type": "CharacterRecord",
        "baseHPModifiable": {"baseValue": 570},
        "baseDamageModifiable": {"baseValue": 57},
        "baseArmorModifiable": {"baseValue": 24},
    }
}


def _summary_row(champ_id, alias, name):
    return {"id": champ_id, "name": name, "alias": alias, "roles": ["mage"]}


def _detail(champ_id, alias, name, *, derived=False):
    detail = {
        "id": champ_id,
        "name": name,
        "alias": alias,
        "title": "t",
        "passive": {"name": "p"},
        "spells": [],
    }
    if derived:
        detail["relatedPrimeContentId"] = "prime-content-id"
        detail["relatedPrimeItemId"] = 1
    return detail


def make_cdragon_fetcher(prime_count=40, variant_count=10, missing_bins=()):
    """Fake CDragon exposing prime champions plus Jade_* derived variants."""
    primes = [(i, f"Champ{i}", f"Champ {i}") for i in range(1, prime_count + 1)]
    variants = [(60000 + i, f"Jade_Champ{i}", f"Champ {i}") for i in range(1, variant_count + 1)]
    summary = [_summary_row(*p) for p in primes] + [_summary_row(*v) for v in variants]
    details = {str(cid): _detail(cid, a, n) for cid, a, n in primes}
    details.update({str(cid): _detail(cid, a, n, derived=True) for cid, a, n in variants})
    requested: list[str] = []

    def fetch(url: str):
        requested.append(url)
        if url.endswith("/content-metadata.json"):
            return {"version": "16.18.8159717+branch.releases-16-18.content.release"}
        if url.endswith("/cherry-augments.json"):
            return {"augments": []}
        if url.endswith("lol.stringtable.json"):
            return {"entries": {}}
        if url.endswith("/champion-summary.json"):
            return summary
        if url.endswith("/items.json"):
            return []
        match = re.search(r"/champions/(\d+)\.json$", url)
        if match:
            return details[match.group(1)]
        match = re.search(r"/characters/([a-z0-9]+)/[a-z0-9]+\.bin\.json$", url)
        if match:
            if match.group(1) in missing_bins:
                raise HTTPError(url, 404, "Not Found", {}, None)
            return BIN_PAYLOAD
        raise AssertionError(f"unexpected URL: {url}")

    return fetch, requested


class CDragonSourceShapeTests(unittest.TestCase):
    def test_derived_jade_variants_never_abort_the_lane(self):
        fetch, _ = make_cdragon_fetcher(prime_count=40, variant_count=10)
        _version, entities, _sources = fetch_branch_entities("latest", fetch_json=fetch)
        ids = {row["id"] for row in entities["champion"]}
        self.assertEqual(len(entities["champion"]), 40)
        self.assertFalse(
            [i for i in ids if int(i) >= 60000],
            "derived variants must never enter the champion catalog",
        )

    def test_derived_variants_do_not_trigger_bin_fetches(self):
        fetch, requested = make_cdragon_fetcher(prime_count=5, variant_count=5)
        fetch_branch_entities("latest", fetch_json=fetch)
        variant_bins = [u for u in requested if "/characters/jade" in u]
        self.assertEqual(variant_bins, [], "must not request bins for derived variants")

    def test_systemic_bin_collapse_still_fails_the_lane(self):
        # 20 of 40 missing, all previously known: carrying that much forward
        # would serve a stale roster under a new patch label.
        missing = {f"champ{i}" for i in range(1, 21)}
        known = {str(i): {"health": 500} for i in range(1, 41)}
        fetch, _ = make_cdragon_fetcher(prime_count=40, missing_bins=missing)
        with self.assertRaises(SnapshotValidationError) as ctx:
            fetch_branch_entities("latest", fetch_json=fetch, known_base_stats=known)
        self.assertIn("acquisition collapse", str(ctx.exception))

    def test_non_404_errors_still_abort(self):
        fetch, _ = make_cdragon_fetcher(prime_count=5)

        def failing(url: str):
            if ".bin.json" in url:
                raise HTTPError(url, 500, "Server Error", {}, None)
            return fetch(url)

        with self.assertRaises(HTTPError):
            fetch_branch_entities("latest", fetch_json=failing)

    def test_structural_label_comes_from_riot_not_statistics_source(self):
        with tempfile.TemporaryDirectory() as tmp:
            internal = Path(tmp)
            # statistics source lags a patch behind the live game
            (internal / "meta.json").write_text(json.dumps({"patch": "26.17"}))
            (internal / "patch-metadata.json").write_text(json.dumps({"patch": "26.18"}))
            self.assertEqual(
                _latest_patch_label(internal, "16.18.8159717"),
                "26.18",
                "structural snapshots must carry Riot's patch, not the stats provider's",
            )

    def test_structural_label_falls_back_to_source_version(self):
        with tempfile.TemporaryDirectory() as tmp:
            self.assertEqual(
                _latest_patch_label(Path(tmp), "16.18.8159717"),
                "16.18.8159717",
            )


# ── Semantic continuity (2026-09 review finding) ────────────────────────────
# A ratio floor let transient 404s drop base stats, and the snapshot diff then
# published that absence as a balance change. Absence of a current observation
# is not evidence that a stat changed.

def snapshot_of(rows, version):
    return build_snapshot(
        entity_type="champion", branch="latest", source_version=version,
        source_patch_label="26.18", observed_at="2026-09-11T00:00:00Z",
        entities=rows,
    )


def base_stats_map(rows):
    out = {}
    for row in rows:
        base = (row.get("fields") or {}).get("base_stats")
        if base:
            out[str(row["id"])] = base
    return out


class ChampionBinContinuityTests(unittest.TestCase):
    def _healthy(self, prime_count=40, variant_count=10):
        fetch, _ = make_cdragon_fetcher(prime_count=prime_count, variant_count=variant_count)
        _v, entities, _s = fetch_branch_entities("latest", fetch_json=fetch)
        return entities["champion"]

    def _degraded(self, missing, known, prime_count=40, variant_count=10, report=None):
        fetch, _ = make_cdragon_fetcher(
            prime_count=prime_count, variant_count=variant_count, missing_bins=missing
        )
        _v, entities, _s = fetch_branch_entities(
            "latest", fetch_json=fetch, known_base_stats=known, report=report
        )
        return entities["champion"]

    def _events(self, before, after):
        return compare_snapshots(
            snapshot_of(before, "16.18.1"),
            snapshot_of(after, "16.18.2"),
            detected_at="2026-09-11T00:00:00Z",
        )

    def test_one_missing_existing_bin_emits_no_fake_change(self):
        healthy = self._healthy()
        known = base_stats_map(healthy)
        degraded = self._degraded({"champ7"}, known)
        self.assertEqual(self._events(healthy, degraded), [])

    def test_two_missing_existing_bins_emit_no_fake_change(self):
        healthy = self._healthy()
        known = base_stats_map(healthy)
        degraded = self._degraded({"champ7", "champ8"}, known)
        self.assertEqual(self._events(healthy, degraded), [])

    def test_eight_missing_existing_bins_fail_rather_than_fabricate(self):
        """8/40 = 20%, above the systemic ceiling — must fail, never fabricate."""
        healthy = self._healthy()
        known = base_stats_map(healthy)
        with self.assertRaises(SnapshotValidationError) as ctx:
            self._degraded({f"champ{i}" for i in range(1, 9)}, known)
        self.assertIn("acquisition collapse", str(ctx.exception))

    def test_missing_bins_within_ceiling_are_reported_as_retained(self):
        healthy = self._healthy()
        known = base_stats_map(healthy)
        report = {}
        self._degraded({"champ7"}, known, report=report)
        acquisition = report["champion_acquisition"]
        self.assertEqual(acquisition["base_stats_retained"], ["7"])
        self.assertEqual(acquisition["bootstrapped_without_base_stats"], [])

    def test_new_champion_without_bin_bootstraps_without_base_stats(self):
        """Nothing to carry forward; an addition is not a change."""
        report = {}
        rows = self._degraded({"champ40"}, known={}, report=report)
        self.assertEqual(len(rows), 40)
        newcomer = next(r for r in rows if r["id"] == "40")
        self.assertNotIn("base_stats", newcomer["fields"])
        self.assertEqual(report["champion_acquisition"]["bootstrapped_without_base_stats"], ["40"])
        self.assertEqual(report["champion_acquisition"]["base_stats_retained"], [])

    def test_derived_variant_missing_bin_is_not_a_continuity_event(self):
        report = {}
        rows = self._degraded(set(), known={}, variant_count=10, report=report)
        self.assertEqual(len(rows), 40)
        self.assertEqual(len(report["champion_acquisition"]["derived_variants_skipped"]), 10)
        self.assertEqual(report["champion_acquisition"]["base_stats_retained"], [])

    def test_malformed_bin_payload_still_fails_closed(self):
        fetch, _ = make_cdragon_fetcher(prime_count=5)

        def malformed(url):
            if ".bin.json" in url:
                return ["not", "a", "record"]
            return fetch(url)

        with self.assertRaises(SnapshotValidationError):
            fetch_branch_entities("latest", fetch_json=malformed)

    def test_global_bin_path_failure_fails_the_lane(self):
        healthy = self._healthy()
        known = base_stats_map(healthy)
        with self.assertRaises(SnapshotValidationError) as ctx:
            self._degraded({f"champ{i}" for i in range(1, 41)}, known)
        self.assertIn("acquisition collapse", str(ctx.exception))
