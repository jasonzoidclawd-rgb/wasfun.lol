#!/usr/bin/env python3
"""Presentation projections consume CDragon events, never prose structure."""

from __future__ import annotations

import json
import unittest

from patch_event_projection import build_patch_notes_projection, build_preview_projection


ADJACENT = {
    "base_branch": "latest",
    "base_version": "16.12.7900000+branch.releases-16-12.content.release",
    "target_branch": "latest",
    "target_version": "16.13.7915903+branch.releases-16-13.content.release",
}
# The first run after the 2026-07/09 outage: five patches in one diff.
CROSS_GAP = {
    "base_branch": "latest",
    "base_version": "16.13.7915903+branch.releases-16-13.content.release",
    "target_branch": "latest",
    "target_version": "16.18.8159717+branch.releases-16-18.content.release",
}


def event(**overrides: object) -> dict:
    base = {
        "entity_type": "champion",
        "canonical_id": "63",
        "slug": "brand",
        "names": {"en": "Brand", "zh-TW": "布蘭德"},
        "branch": "latest",
        "lane": "live",
        "change_kind": "numeric",
        "fields_changed": ["abilities.Q.cooldown"],
        "before": {"abilities.Q.cooldown": [8, 7, 6]},
        "after": {"abilities.Q.cooldown": [7, 6, 5]},
        "detected_at": "2026-07-11T01:00:00Z",
        "source_patch_label": "26.13",
        "landed": False,
        "is_hotfix": True,
        "comparison": ADJACENT,
    }
    base.update(overrides)
    return base


class PatchEventProjectionTests(unittest.TestCase):
    def test_live_projection_uses_snapshot_events_and_metadata_only(self):
        patch_events = {
            "current_open_cycle": "26.13",
            "observed_at": "2026-07-11T01:00:00Z",
            "events": [event()],
        }
        metadata = {
            "patches": [
                {
                    "version": "26.13",
                    "articleTitle": "Patch 26.13 Notes",
                    "publishedAt": "2026-06-25T12:00:00Z",
                    "sourceUrl": "https://riot.example/26-13",
                    "authors": ["Riot Fixture"],
                    "intro": "Metadata only.",
                },
                {
                    "version": "26.12",
                    "articleTitle": "Patch 26.12 Notes",
                    "publishedAt": "2026-06-11T12:00:00Z",
                    "sourceUrl": "https://riot.example/26-12",
                    "authors": [],
                    "intro": "",
                },
            ],
        }

        projection = build_patch_notes_projection(
            patch_events,
            metadata,
            known={"champion": {"brand"}, "item": set(), "augment": set()},
        )
        current, historical = projection["patches"]

        self.assertEqual(projection["source"], "CommunityDragon snapshot diffs")
        self.assertEqual(current["version"], "26.13")
        self.assertEqual(current["sections"][0]["id"], "champions")
        change = current["sections"][0]["changes"][0]
        self.assertEqual(change["kind"], "changed")
        self.assertEqual(change["targets"][0]["href"], "/champions/brand")
        self.assertEqual(change["text"]["en"], "abilities.Q.cooldown: [8, 7, 6] → [7, 6, 5]")
        self.assertEqual(historical["version"], "26.12")
        self.assertEqual(historical["sections"], [])
        self.assertNotIn("comparison", json.dumps(projection))

    def test_projection_keeps_only_current_open_live_cycle(self):
        projection = build_patch_notes_projection(
            {
                "current_open_cycle": "26.13",
                "observed_at": "2026-07-11T01:00:00Z",
                "events": [event(source_patch_label="26.12"), event(source_patch_label="26.13")],
            },
            {"patches": []},
        )

        self.assertEqual(len(projection["patches"]), 1)
        self.assertEqual(len(projection["patches"][0]["sections"][0]["changes"]), 1)

    def test_projection_sanitizes_cdragon_markup_from_change_text(self):
        projection = build_patch_notes_projection(
            {
                "current_open_cycle": "26.13",
                "events": [event(
                    fields_changed=["description"],
                    before={"description": "<mainText>Old @Value@</mainText>"},
                    after={"description": "<mainText>New<br>%i:cooldown%</mainText>"},
                )],
            },
            {"patches": []},
        )

        change = projection["patches"][0]["sections"][0]["changes"][0]
        self.assertEqual(change["text"]["en"], "description: Old → New")

    def test_live_projection_marks_a_source_reconciled_preview_as_landed(self):
        live = event()
        projection = build_patch_notes_projection(
            {"current_open_cycle": "26.13", "events": [live]},
            {"patches": []},
            pbe_archive={
                "events": [
                    {
                        **event(branch="pbe", lane="preview"),
                        "lifecycle": "landed",
                        "landed": True,
                    },
                ],
            },
        )

        change = projection["patches"][0]["sections"][0]["changes"][0]
        self.assertTrue(change["landedFromPbe"])

    def test_cross_gap_event_is_not_dated_to_the_current_patch_by_its_label(self):
        """A 16.13 -> 16.18 diff carries label 26.18 but proves no 26.18 change.

        Regression: all 275 events of the first post-outage comparison were
        projected as "Patch 26.18" changes, dating five patches of accumulated
        change to one. The lifecycle path already refused to date them.
        """
        patch_events = {
            "current_open_cycle": "26.18",
            "observed_at": "2026-09-10T18:21:25Z",
            "status": "fresh",
            "events": [
                event(slug="brand", source_patch_label="26.18", comparison=CROSS_GAP),
                event(slug="garen", canonical_id="86", source_patch_label="26.18",
                      comparison=CROSS_GAP, change_kind="added"),
                event(slug="teemo", canonical_id="17", source_patch_label="26.18",
                      comparison=None),
            ],
        }
        metadata = {"patches": [{
            "version": "26.18",
            "articleTitle": "Patch 26.18 Notes",
            "publishedAt": "2026-09-09T18:00:00Z",
            "sourceUrl": "https://riot.example/26-18",
            "authors": [],
            "intro": "",
        }]}

        projection = build_patch_notes_projection(patch_events, metadata)
        current = projection["patches"][0]

        self.assertEqual(current["version"], "26.18")
        self.assertEqual(current["sections"], [])
        self.assertEqual(current["summary"]["totalChanges"], 0)
        # Status, freshness and the Riot source link are untouched.
        self.assertEqual(projection["status"], "fresh")
        self.assertEqual(projection["scraped_at"], "2026-09-10T18:21:25Z")
        self.assertEqual(projection["sourceUrl"], "https://riot.example/26-18")
        self.assertEqual(current["sourceUrl"], "https://riot.example/26-18")
        self.assertEqual(current["title"], "Patch 26.18 Notes")

    def test_adjacent_event_in_the_same_run_is_still_dated(self):
        adjacent_18 = {**ADJACENT,
                       "base_version": "16.17.8100000+branch.releases-16-17.content.release",
                       "target_version": "16.18.8159717+branch.releases-16-18.content.release"}
        projection = build_patch_notes_projection(
            {
                "current_open_cycle": "26.18",
                "events": [
                    event(slug="brand", source_patch_label="26.18", comparison=adjacent_18),
                    event(slug="garen", source_patch_label="26.18", comparison=CROSS_GAP),
                ],
            },
            {"patches": []},
        )
        changes = projection["patches"][0]["sections"][0]["changes"]
        self.assertEqual([c["targets"][0]["slug"] for c in changes], ["brand"])
        self.assertEqual(projection["patches"][0]["summary"]["totalChanges"], 1)

    def test_preview_projection_is_bounded_and_only_links_live_canonical_entities(self):
        archive = {
            "status": "fresh",
            "source_patch_label": "pbe-cycle-16.14",
            "observed_at": "2026-07-11T01:00:00Z",
            "events": [
                event(branch="pbe", lane="preview", source_patch_label="pbe-cycle-16.14"),
                event(slug="new-champion", canonical_id="999", branch="pbe", lane="preview", source_patch_label="pbe-cycle-16.14"),
                event(slug="old-cycle", source_patch_label="pbe-cycle-16.13"),
                event(slug="landed", source_patch_label="pbe-cycle-16.14", lifecycle="landed", landed=True),
            ],
        }
        known = {
            "champion": {"brand"},
            "augment": set(),
            "item": set(),
        }

        projection = build_preview_projection(archive, known)

        self.assertEqual([row["slug"] for row in projection["events"]], ["brand", "new-champion"])
        self.assertEqual(projection["events"][0]["href"], "/champions/brand")
        self.assertNotIn("href", projection["events"][1])
        self.assertNotIn("lifecycle", json.dumps(projection))
        self.assertNotIn("comparison", json.dumps(projection))


if __name__ == "__main__":
    unittest.main()
