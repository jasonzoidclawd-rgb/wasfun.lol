#!/usr/bin/env python3
"""Presentation projections consume CDragon events, never prose structure."""

from __future__ import annotations

import json
import unittest

from generate_pool_rules import (
    comparison_crosses_cycle_boundary,
    comparison_crosses_patch_boundary,
    comparison_is_patch_adjacent,
)
from patch_event_projection import (
    _dated_events,
    build_patch_notes_projection,
    build_preview_projection,
    patch_boundary_lanes,
    whole_patch_diff_available,
)


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
# The real 26.18 boundary: the patch before it, compared against it.
BOUNDARY_18 = {
    "base_branch": "latest",
    "base_version": "16.17.8100000+branch.releases-16-17.content.release",
    "target_branch": "latest",
    "target_version": "16.18.8159717+branch.releases-16-18.content.release",
}
# A routine refresh WITHIN 26.18. Proves a hotfix; proves nothing about the
# transition into the patch.
SAME_PATCH_18 = {
    "base_branch": "latest",
    "base_version": "16.18.8159717+branch.releases-16-18.content.release",
    "target_branch": "latest",
    "target_version": "16.18.8201044+branch.releases-16-18.content.release",
}
STRUCTURAL_LANES = ("augment", "champion", "item")


def comparisons(
    comparison: dict,
    cycle: str = "26.13",
    lanes: tuple[str, ...] = STRUCTURAL_LANES,
) -> list[dict]:
    """Archive comparison records, one per structural lane."""
    return [
        {"entity_type": lane, "source_patch_label": cycle, **comparison}
        for lane in lanes
    ]


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
            "comparisons": comparisons(ADJACENT, "26.13"),
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
                "comparisons": comparisons(ADJACENT, "26.13"),
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
                "comparisons": comparisons(ADJACENT, "26.13"),
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
            {
                "current_open_cycle": "26.13",
                "comparisons": comparisons(ADJACENT, "26.13"),
                "events": [live],
            },
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
        # Withholding the date must not become a claim that nothing changed:
        # nothing was measured for 26.18, so no count is published at all.
        self.assertEqual(current["structuredDiff"], "unavailable")
        self.assertNotIn("summary", current)
        # Status, freshness and the Riot source link are untouched.
        self.assertEqual(projection["status"], "fresh")
        self.assertEqual(projection["scraped_at"], "2026-09-10T18:21:25Z")
        self.assertEqual(projection["sourceUrl"], "https://riot.example/26-18")
        self.assertEqual(current["sourceUrl"], "https://riot.example/26-18")
        self.assertEqual(current["title"], "Patch 26.18 Notes")

    def test_adjacent_event_in_the_same_run_is_still_dated(self):
        projection = build_patch_notes_projection(
            {
                "current_open_cycle": "26.18",
                "comparisons": comparisons(BOUNDARY_18, "26.18"),
                "events": [
                    event(slug="brand", source_patch_label="26.18", comparison=BOUNDARY_18),
                    event(slug="garen", source_patch_label="26.18", comparison=CROSS_GAP),
                ],
            },
            {"patches": []},
        )
        changes = projection["patches"][0]["sections"][0]["changes"]
        self.assertEqual([c["targets"][0]["slug"] for c in changes], ["brand"])
        self.assertEqual(projection["patches"][0]["structuredDiff"], "available")
        self.assertEqual(projection["patches"][0]["summary"]["totalChanges"], 1)

    def test_a_comparison_recorded_for_another_cycle_proves_nothing_here(self):
        projection = build_patch_notes_projection(
            {
                "current_open_cycle": "26.18",
                "comparisons": comparisons(ADJACENT, "26.13"),
                "events": [],
            },
            {"patches": []},
        )

        self.assertEqual(projection["patches"][0]["structuredDiff"], "unavailable")

    def test_prose_only_history_entries_publish_no_summary(self):
        projection = build_patch_notes_projection(
            {"current_open_cycle": "26.18", "events": []},
            {"patches": [
                {"version": "26.18", "articleTitle": "Patch 26.18 Notes"},
                {"version": "26.17", "articleTitle": "Patch 26.17 Notes"},
                {"version": "26.16", "articleTitle": "Patch 26.16 Notes"},
            ]},
        )

        for patch in projection["patches"][1:]:
            self.assertEqual(patch["structuredDiff"], "unavailable", patch["version"])
            self.assertNotIn("summary", patch)

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



class WholePatchBoundaryCoverageTests(unittest.TestCase):
    """A patch is "measured" only if its own boundary was observed everywhere.

    Two different questions are asked of a comparison, and collapsing them is
    the defect these probes exist to keep out:

      event-level dating (`comparison_is_patch_adjacent`)
          "May this individual observation be attributed to the patch?"
          A same-patch refresh qualifies: a hotfix inside 26.18 IS a 26.18
          change, and it stays dateable and representable in the archive.

      patch-level coverage (`whole_patch_diff_available`)
          "Was the transition INTO this patch observed, across every
          structural lane?" A same-patch refresh NEVER qualifies, because it
          only sees what moved after the patch already landed.

    Reading the first as the second is what would let a routine
    16.18.a -> 16.18.b refresh convert the historical 16.13 -> 16.18 gap into
    a published "verified: 0 changes in 26.18".
    """

    def project(self, patch_events: dict) -> dict:
        return build_patch_notes_projection(
            {"current_open_cycle": "26.18", "observed_at": "2026-09-17T23:58:16Z",
             "status": "fresh", **patch_events},
            {"patches": [{"version": "26.18", "articleTitle": "Patch 26.18 Notes"}]},
        )["patches"][0]

    def assertUnavailable(self, card: dict, why: str) -> None:
        self.assertEqual(card["structuredDiff"], "unavailable", why)
        self.assertNotIn("summary", card, why)
        self.assertEqual(card["sections"], [], why)

    # ── Probe 1 ──────────────────────────────────────────────────────────────
    def test_historical_gap_then_same_patch_refresh_stays_unavailable(self):
        """THE BLOCKER. 16.13 -> 16.18, later 16.18.a -> 16.18.b.

        The refresh is adjacent and its events are dateable, but it observed
        only the inside of 26.18. The five patches of accumulated change hidden
        by the gap are still unaccounted for, so the patch stays unknown.
        """
        card = self.project({
            "comparisons": [
                *comparisons(CROSS_GAP, "26.18"),
                *comparisons(SAME_PATCH_18, "26.18"),
            ],
            "events": [
                event(slug="brand", source_patch_label="26.18", comparison=CROSS_GAP),
                event(slug="garen", canonical_id="86", source_patch_label="26.18",
                      comparison=SAME_PATCH_18, is_hotfix=True),
            ],
        })

        self.assertUnavailable(card, "a same-patch refresh cannot close a patch gap")

    def test_same_patch_refresh_alone_never_establishes_coverage(self):
        card = self.project({
            "comparisons": comparisons(SAME_PATCH_18, "26.18"),
            "events": [],
        })

        self.assertUnavailable(card, "an in-patch refresh proves no boundary")

    # ── Probe 2 ──────────────────────────────────────────────────────────────
    def test_complete_real_boundary_is_available(self):
        card = self.project({
            "comparisons": comparisons(BOUNDARY_18, "26.18"),
            "events": [event(slug="brand", source_patch_label="26.18",
                             comparison=BOUNDARY_18)],
        })

        self.assertEqual(card["structuredDiff"], "available")
        self.assertEqual(card["summary"]["totalChanges"], 1)

    # ── Probe 3 ──────────────────────────────────────────────────────────────
    def test_partial_boundary_is_unavailable(self):
        for missing in STRUCTURAL_LANES:
            present = tuple(lane for lane in STRUCTURAL_LANES if lane != missing)
            card = self.project({
                "comparisons": comparisons(BOUNDARY_18, "26.18", present),
                "events": [],
            })

            self.assertUnavailable(card, f"missing the {missing} lane")

    def test_a_single_lane_never_establishes_coverage(self):
        for lane in STRUCTURAL_LANES:
            card = self.project({
                "comparisons": comparisons(BOUNDARY_18, "26.18", (lane,)),
                "events": [],
            })

            self.assertUnavailable(card, f"{lane} alone")

    # ── Probe 4 ──────────────────────────────────────────────────────────────
    def test_cross_gap_on_every_lane_is_still_unavailable(self):
        card = self.project({
            "comparisons": comparisons(CROSS_GAP, "26.18"),
            "events": [],
        })

        self.assertUnavailable(card, "three gapped lanes are still a gap")

    # ── Probe 5 ──────────────────────────────────────────────────────────────
    def test_complete_boundary_then_same_patch_refresh_stays_available(self):
        """Coverage is monotonic: a later refresh must not REVOKE it either."""
        card = self.project({
            "comparisons": [
                *comparisons(BOUNDARY_18, "26.18"),
                *comparisons(SAME_PATCH_18, "26.18"),
            ],
            "events": [
                event(slug="brand", source_patch_label="26.18", comparison=BOUNDARY_18),
                event(slug="garen", canonical_id="86", source_patch_label="26.18",
                      comparison=SAME_PATCH_18, is_hotfix=True),
            ],
        })

        self.assertEqual(card["structuredDiff"], "available")
        # The in-patch hotfix is a real 26.18 change and is counted alongside
        # the boundary change: event-level dating is untouched.
        self.assertEqual(card["summary"]["totalChanges"], 2)

    # ── Probe 6 ──────────────────────────────────────────────────────────────
    def test_complete_boundary_with_zero_events_is_a_verified_zero(self):
        card = self.project({
            "comparisons": comparisons(BOUNDARY_18, "26.18"),
            "events": [],
        })

        self.assertEqual(card["structuredDiff"], "available")
        self.assertEqual(card["summary"]["totalChanges"], 0)
        self.assertEqual(card["sections"], [])

    # ── Probe 7 ──────────────────────────────────────────────────────────────
    def test_no_valid_boundary_with_zero_events_is_unknown(self):
        self.assertUnavailable(self.project({"events": []}), "no evidence at all")
        self.assertUnavailable(
            self.project({"comparisons": [], "events": []}), "an empty record",
        )

    # ── Probe 8 ──────────────────────────────────────────────────────────────
    def test_same_patch_hotfix_stays_dateable_while_the_patch_stays_unknown(self):
        """The two questions, asked of the same event, give different answers."""
        hotfix = event(slug="brand", source_patch_label="26.18",
                       comparison=SAME_PATCH_18, is_hotfix=True)

        # Event level: this observation belongs to 26.18 and may be dated.
        self.assertTrue(comparison_is_patch_adjacent(hotfix["comparison"]))
        # Patch level: it says nothing about the transition into 26.18.
        self.assertFalse(comparison_crosses_patch_boundary(hotfix["comparison"]))

        patch_events = {
            "current_open_cycle": "26.18",
            "comparisons": comparisons(SAME_PATCH_18, "26.18"),
            "events": [hotfix],
        }
        # The event is still attributable to 26.18 by the unchanged rule...
        self.assertEqual(
            [e["slug"] for e in _dated_events(patch_events, "26.18", set())], ["brand"],
        )
        # ...and the archive still holds it, unmodified, for any surface that
        # wants "observations made" rather than "what this patch changed".
        self.assertEqual(patch_events["events"], [hotfix])
        # ...but the whole patch remains unknown, so the card counts nothing.
        self.assertEqual(patch_boundary_lanes(patch_events, "26.18"), set())
        self.assertUnavailable(self.project(patch_events), "hotfix is not coverage")

    # ── Predicate-level proofs ───────────────────────────────────────────────
    def test_boundary_crossing_is_strictly_narrower_than_adjacency(self):
        pairs = [ADJACENT, CROSS_GAP, BOUNDARY_18, SAME_PATCH_18, None, {}, "nonsense"]
        for comparison in pairs:
            if comparison_crosses_patch_boundary(comparison):
                self.assertTrue(
                    comparison_is_patch_adjacent(comparison),
                    f"boundary admitted a pair adjacency rejects: {comparison}",
                )

    def test_boundary_crossing_rejects_every_same_patch_pair(self):
        for build in ("8159717", "8201044", "9999999"):
            same = {**SAME_PATCH_18,
                    "target_version": f"16.18.{build}+branch.releases-16-18.content.release"}
            self.assertTrue(comparison_is_patch_adjacent(same), build)
            self.assertFalse(comparison_crosses_patch_boundary(same), build)

    # ── Label/version agreement (TASK 3 matrix A-I) ──────────────────────────
    def test_cycle_boundary_matrix(self):
        """A comparison must cross the boundary into the patch it CLAIMS.

        The label and the versions come from different feeds — the label from
        Riot's patch-notes metadata, the versions from the CDragon lineage — so
        they can disagree. A valid 16.16 -> 16.17 boundary stamped "26.18" is
        real evidence about 26.17 and none at all about 26.18.
        """
        def pair(base: str, target: str) -> dict:
            return {
                "base_branch": "latest",
                "base_version": f"{base}.8000000+branch.releases.content.release",
                "target_branch": "latest",
                "target_version": f"{target}.8100000+branch.releases.content.release",
            }

        cases = [
            # (id, cycle, comparison, qualifies)
            ("A  real boundary into the claimed patch", "26.18", pair("16.17", "16.18"), True),
            ("B  same-patch refresh", "26.18", pair("16.18", "16.18"), False),
            ("C  cross-gap", "26.18", pair("16.13", "16.18"), False),
            ("D  adjacent boundary, WRONG target patch", "26.18", pair("16.16", "16.17"), False),
            ("E  that same diff, for its own patch", "26.17", pair("16.16", "16.17"), True),
            ("F  cycle missing", None, pair("16.17", "16.18"), False),
            ("F  cycle empty", "", pair("16.17", "16.18"), False),
            ("F  cycle unparseable", "unknown", pair("16.17", "16.18"), False),
            ("F  cycle is a PBE tag", "pbe-cycle-16.18.1", pair("16.17", "16.18"), False),
            ("G  target version malformed", "26.18", pair("16.17", "not-a-version"), False),
            ("G  base version malformed", "26.18", pair("nope", "16.18"), False),
            ("G  comparison is not a dict", "26.18", "16.17 -> 16.18", False),
            ("G  comparison missing", "26.18", None, False),
            # Backwards pairs are rejected by adjacency itself, so they never
            # reach the label check — a lane cannot regress into coverage.
            ("   backwards comparison", "26.17", pair("16.18", "16.17"), False),
            ("   backwards across a gap", "26.13", pair("16.18", "16.13"), False),
            ("   season rollover keeps working", "27.0", pair("16.24", "17.0"), True),
            ("   rollover claimed for the wrong patch", "27.1", pair("16.24", "17.0"), False),
        ]
        for label, cycle, comparison, expected in cases:
            self.assertEqual(
                comparison_crosses_cycle_boundary(comparison, cycle), expected, label,
            )

    def test_the_label_fallback_path_still_qualifies(self):
        """`_latest_patch_label` falls back to the source version.

        When Riot's patch-metadata.json is missing, the pipeline labels the
        lane with the CDragon source version itself rather than a game patch
        ("16.18.8159717+..." instead of "26.18"). The label then trivially
        agrees with the versions, and coverage must still be provable — the
        cycle check must not assume a game-patch-shaped label.
        """
        cycle = "16.18.8159717+branch.releases-16-18.content.release"
        patch_events = {
            "current_open_cycle": cycle,
            "comparisons": comparisons(BOUNDARY_18, cycle),
            "events": [],
        }

        self.assertEqual(
            patch_boundary_lanes(patch_events, cycle), {"augment", "champion", "item"},
        )
        self.assertTrue(whole_patch_diff_available(patch_events, cycle))

    def test_an_adjacent_boundary_for_the_wrong_patch_adds_no_lane(self):
        """TASK 3 probe D, at the lane level rather than the predicate level."""
        wrong_target = {
            "base_branch": "latest",
            "base_version": "16.16.8050000+branch.releases-16-16.content.release",
            "target_branch": "latest",
            "target_version": "16.17.8100000+branch.releases-16-17.content.release",
        }
        # Stamped 26.18 across ALL THREE lanes — the strongest malformed case.
        patch_events = {
            "current_open_cycle": "26.18",
            "comparisons": comparisons(wrong_target, "26.18"),
            "events": [event(slug="brand", source_patch_label="26.18",
                             comparison=wrong_target)],
        }

        self.assertEqual(patch_boundary_lanes(patch_events, "26.18"), set())
        self.assertFalse(whole_patch_diff_available(patch_events, "26.18"))
        self.assertUnavailable(
            self.project(patch_events), "a boundary into 26.17 is not 26.18 coverage",
        )

    def test_one_mislabelled_lane_disqualifies_the_whole_patch(self):
        """TASK 3 probe I: two honest lanes plus one contradictory one."""
        wrong_target = {
            "base_branch": "latest",
            "base_version": "16.16.8050000+branch.releases-16-16.content.release",
            "target_branch": "latest",
            "target_version": "16.17.8100000+branch.releases-16-17.content.release",
        }
        patch_events = {
            "current_open_cycle": "26.18",
            "comparisons": [
                *comparisons(BOUNDARY_18, "26.18", ("champion", "augment")),
                {"entity_type": "item", "source_patch_label": "26.18", **wrong_target},
            ],
            "events": [],
        }

        self.assertEqual(
            patch_boundary_lanes(patch_events, "26.18"), {"champion", "augment"},
        )
        self.assertUnavailable(self.project(patch_events), "the item lane is unproven")

    def test_a_malformed_record_cannot_widen_real_coverage(self):
        """Garbage alongside good evidence must neither help nor corrupt it."""
        good = comparisons(BOUNDARY_18, "26.18")
        junk = [
            None,
            "not a record",
            {"entity_type": "item", "source_patch_label": "26.18"},
            {"entity_type": "item", "source_patch_label": "26.18",
             "base_version": None, "target_version": None},
        ]

        only_junk = {"current_open_cycle": "26.18", "comparisons": junk, "events": []}
        self.assertEqual(patch_boundary_lanes(only_junk, "26.18"), set())
        self.assertUnavailable(self.project(only_junk), "junk is not evidence")

        mixed = {"current_open_cycle": "26.18", "comparisons": [*good, *junk], "events": []}
        self.assertEqual(
            patch_boundary_lanes(mixed, "26.18"), {"augment", "champion", "item"},
        )
        self.assertEqual(self.project(mixed)["structuredDiff"], "available")

    def test_boundary_crossing_accepts_only_the_immediately_previous_patch(self):
        def pair(base: str, target: str) -> dict:
            return {"base_version": f"{base}.1+x", "target_version": f"{target}.2+x"}

        self.assertTrue(comparison_crosses_patch_boundary(pair("16.17", "16.18")))
        self.assertFalse(comparison_crosses_patch_boundary(pair("16.16", "16.18")))
        self.assertFalse(comparison_crosses_patch_boundary(pair("16.18", "16.18")))
        # A backwards pair is not a boundary crossing either.
        self.assertFalse(comparison_crosses_patch_boundary(pair("16.18", "16.17")))


class HistoricalPatchEvidenceTests(unittest.TestCase):
    """History is judged on evidence, not on position in the list.

    A patch does not become unmeasured by scrolling off the top: the archive
    keeps every comparison and event under its own patch label, so the same
    boundary rule applies to a historical card as to the current one.
    """

    BOUNDARY_17 = {
        "base_branch": "latest",
        "base_version": "16.16.8050000+branch.releases-16-16.content.release",
        "target_branch": "latest",
        "target_version": "16.17.8100000+branch.releases-16-17.content.release",
    }

    def project(self, patch_events: dict, versions: tuple[str, ...]) -> dict:
        projection = build_patch_notes_projection(
            {"observed_at": "2026-09-17T23:58:16Z", "status": "fresh", **patch_events},
            {"patches": [
                {"version": version, "articleTitle": f"Patch {version} Notes"}
                for version in versions
            ]},
        )
        return {card["version"]: card for card in projection["patches"]}

    def test_prose_only_history_stays_unavailable(self):
        cards = self.project(
            {"current_open_cycle": "26.18",
             "comparisons": comparisons(BOUNDARY_18, "26.18"),
             "events": []},
            ("26.18", "26.17", "26.16"),
        )

        self.assertEqual(cards["26.18"]["structuredDiff"], "available")
        for version in ("26.17", "26.16"):
            self.assertEqual(cards[version]["structuredDiff"], "unavailable", version)
            self.assertNotIn("summary", cards[version])
            self.assertEqual(cards[version]["sections"], [])

    def test_history_with_complete_archived_boundary_stays_measured(self):
        cards = self.project(
            {
                "current_open_cycle": "26.18",
                "comparisons": [
                    *comparisons(BOUNDARY_18, "26.18"),
                    *comparisons(self.BOUNDARY_17, "26.17"),
                ],
                "events": [
                    event(slug="brand", source_patch_label="26.18", comparison=BOUNDARY_18),
                    event(slug="garen", canonical_id="86", source_patch_label="26.17",
                          comparison=self.BOUNDARY_17),
                    event(slug="teemo", canonical_id="17", source_patch_label="26.17",
                          comparison=self.BOUNDARY_17, change_kind="added"),
                ],
            },
            ("26.18", "26.17"),
        )

        self.assertEqual(cards["26.17"]["structuredDiff"], "available")
        # Reconstructed ONLY from events dated to 26.17 — 26.18's change is not
        # borrowed, and 26.17's are not lent forward.
        self.assertEqual(cards["26.17"]["summary"]["totalChanges"], 2)
        self.assertEqual(cards["26.18"]["summary"]["totalChanges"], 1)
        slugs = [
            change["targets"][0]["slug"]
            for section in cards["26.17"]["sections"]
            for change in section["changes"]
        ]
        self.assertEqual(sorted(slugs), ["garen", "teemo"])

    def test_history_with_gapped_evidence_stays_unavailable(self):
        cards = self.project(
            {
                "current_open_cycle": "26.18",
                "comparisons": [
                    *comparisons(BOUNDARY_18, "26.18"),
                    *comparisons(CROSS_GAP, "26.17"),
                ],
                "events": [event(slug="brand", source_patch_label="26.17",
                                 comparison=CROSS_GAP)],
            },
            ("26.18", "26.17"),
        )

        self.assertEqual(cards["26.17"]["structuredDiff"], "unavailable")
        self.assertNotIn("summary", cards["26.17"])

    def test_history_with_partial_lane_evidence_stays_unavailable(self):
        cards = self.project(
            {
                "current_open_cycle": "26.18",
                "comparisons": [
                    *comparisons(BOUNDARY_18, "26.18"),
                    *comparisons(self.BOUNDARY_17, "26.17", ("champion", "augment")),
                ],
                "events": [],
            },
            ("26.18", "26.17"),
        )

        self.assertEqual(cards["26.17"]["structuredDiff"], "unavailable")

    def test_a_measured_patch_stays_measured_across_rollover(self):
        """The same archive, before and after 26.19 opens."""
        archive = {
            "comparisons": comparisons(BOUNDARY_18, "26.18"),
            "events": [
                event(slug="brand", source_patch_label="26.18", comparison=BOUNDARY_18),
                event(slug="garen", canonical_id="86", source_patch_label="26.18",
                      comparison=BOUNDARY_18, change_kind="added"),
            ],
        }

        before = self.project(
            {"current_open_cycle": "26.18", **archive}, ("26.18",),
        )["26.18"]

        # 26.19 opens. Nothing about 26.18's evidence changed; a 26.19 refresh
        # is appended and 26.18 becomes a history card.
        rolled = {
            "comparisons": [
                *archive["comparisons"],
                *comparisons(SAME_PATCH_18, "26.19"),
            ],
            "events": archive["events"],
        }
        after = self.project(
            {"current_open_cycle": "26.19", **rolled}, ("26.19", "26.18"),
        )

        self.assertEqual(before["structuredDiff"], "available")
        self.assertEqual(after["26.18"]["structuredDiff"], "available")
        self.assertEqual(
            after["26.18"]["summary"], before["summary"],
            "a measured patch must keep its verified count after rollover",
        )
        self.assertEqual(after["26.18"]["sections"], before["sections"])
        # ...and the newly-open patch, which only has an in-patch refresh,
        # is correctly unknown rather than a verified zero.
        self.assertEqual(after["26.19"]["structuredDiff"], "unavailable")
        self.assertNotIn("summary", after["26.19"])


if __name__ == "__main__":
    unittest.main()
