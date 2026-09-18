#!/usr/bin/env python3

from __future__ import annotations

import json
import tempfile
import unittest
from pathlib import Path

from verify_patch_publish import (
    PATCH_NOTES_SCHEMA_VERSION,
    PatchPublishError,
    verify_patch_publish,
)


def summary(total: int = 1, kind: str = "added") -> dict:
    return {
        "totalChanges": total,
        "byKind": {kind: total} if total else {},
        "byEntityType": {"augment": total} if total else {},
        "byLabel": {},
        "damageRelevant": 0,
    }


def patch_note(
    *,
    patch: str = "26.13",
    kind: str = "added",
    text_zh_tw: str | None = "新增一個增幅。",
) -> dict:
    text = {"en": "Added an augment."}
    if text_zh_tw is not None:
        text["zh-tw"] = text_zh_tw

    return {
        "version": patch,
        "title": f"Patch {patch} Notes",
        "released": "2026-06-25",
        "publishedAt": "2026-06-25T12:00:00Z",
        "structuredDiff": "available",
        "summary": summary(1, kind),
        "sections": [
            {
                "id": "augments",
                "title": "Augments",
                "changes": [
                    {
                        "subject": {
                            "en": "Fixture",
                            "zh-tw": "測試",
                            "zh-cn": "测试",
                            "ja-jp": "テスト",
                            "ko-kr": "테스트",
                        },
                        "text": text,
                        "kind": kind,
                    }
                ],
            }
        ],
    }


def public_patch_notes(*, patch: str = "26.13", notes: list[dict] | None = None) -> dict:
    return {
        "schema_version": PATCH_NOTES_SCHEMA_VERSION,
        "patch": patch,
        "source": "CommunityDragon snapshot diffs",
        "sourceKind": "cdragon-structured-diff-v1",
        "status": "fresh",
        "scraped_at": "2026-06-23T18:00:00.000Z",
        "patches": notes
        if notes is not None
        else [
            patch_note(patch="26.13", kind="added"),
            patch_note(patch="26.12", kind="buffed"),
            patch_note(patch="26.11", kind="changed"),
        ],
    }


class VerifyPatchPublishTests(unittest.TestCase):
    def write_public_data(
        self,
        root: Path,
        *,
        patch_notes: dict | None = None,
        meta_patch: str | None = "26.13",
        structural_patch: str | None = None,
    ) -> None:
        public_dir = root / "public" / "data"
        public_dir.mkdir(parents=True)
        if structural_patch is not None:
            (public_dir / "pipeline-status.json").write_text(
                json.dumps({"structural": {"patch": structural_patch}}),
                encoding="utf-8",
            )
        if patch_notes is not None:
            (public_dir / "patch-notes.json").write_text(
                json.dumps(patch_notes),
                encoding="utf-8",
            )
        if meta_patch is not None:
            (public_dir / "meta.json").write_text(
                json.dumps({"patch": meta_patch}),
                encoding="utf-8",
            )

    def test_passing_data_returns_concise_summary(self):
        with tempfile.TemporaryDirectory() as tmpdir:
            root = Path(tmpdir)
            self.write_public_data(root, patch_notes=public_patch_notes())

            summary = verify_patch_publish(
                root=root,
                changed_paths=[
                    "data/internal/patch-events.json",
                    "public/data/patch-notes.json",
                ],
            )

        self.assertEqual(summary["patch"], "26.13")
        self.assertEqual(summary["scraped_at"], "2026-06-23T18:00:00.000Z")
        self.assertEqual(summary["patches"], 3)
        self.assertEqual(summary["totalChanges"], 3)
        self.assertEqual(summary["zhTwText"], 3)
        self.assertEqual(summary["zhTwCoverage"], 1.0)
        self.assertEqual(summary["kinds"], ["added", "buffed", "changed"])

    def test_a_stale_schema_version_is_rejected(self):
        """v3 makes `structuredDiff` required and an absent `summary` meaningful.

        `summary` was already optional in v2 and every reader already used
        optional access, so no consumer breaks — but a downstream reader needs
        a marker to tell "not measured" from "nothing to report".
        """
        notes = public_patch_notes()
        notes["schema_version"] = 2

        with tempfile.TemporaryDirectory() as tmpdir:
            root = Path(tmpdir)
            self.write_public_data(root, patch_notes=notes)

            with self.assertRaisesRegex(PatchPublishError, "schema_version must be 3"):
                verify_patch_publish(root=root, changed_paths=["public/data/patch-notes.json"])

    def test_a_missing_schema_version_is_rejected(self):
        notes = public_patch_notes()
        del notes["schema_version"]

        with tempfile.TemporaryDirectory() as tmpdir:
            root = Path(tmpdir)
            self.write_public_data(root, patch_notes=notes)

            with self.assertRaisesRegex(PatchPublishError, "schema_version must be 3"):
                verify_patch_publish(root=root, changed_paths=["public/data/patch-notes.json"])

    def test_unmeasured_patch_may_not_publish_a_summary_of_zeroes(self):
        """A zeroed summary without a diff presents "unchecked" as "unchanged"."""
        unmeasured = patch_note(patch="26.13")
        unmeasured["structuredDiff"] = "unavailable"
        unmeasured["summary"] = summary(0)
        unmeasured["sections"] = []
        notes = public_patch_notes(
            notes=[unmeasured, patch_note(patch="26.12", kind="buffed"),
                   patch_note(patch="26.11", kind="changed")],
        )

        with tempfile.TemporaryDirectory() as tmpdir:
            root = Path(tmpdir)
            self.write_public_data(root, patch_notes=notes)

            with self.assertRaisesRegex(PatchPublishError, "no structured diff to back it"):
                verify_patch_publish(root=root, changed_paths=["public/data/patch-notes.json"])

    def test_unmeasured_patch_without_a_summary_publishes_cleanly(self):
        unmeasured = patch_note(patch="26.13")
        unmeasured["structuredDiff"] = "unavailable"
        unmeasured.pop("summary")
        unmeasured["sections"] = []
        notes = public_patch_notes(
            notes=[unmeasured, patch_note(patch="26.12", kind="buffed"),
                   patch_note(patch="26.11", kind="changed")],
        )

        with tempfile.TemporaryDirectory() as tmpdir:
            root = Path(tmpdir)
            self.write_public_data(root, patch_notes=notes)

            result = verify_patch_publish(
                root=root, changed_paths=["public/data/patch-notes.json"],
            )

        self.assertEqual(result["totalChanges"], 2)

    def test_every_published_patch_must_declare_its_diff_state(self):
        legacy = patch_note(patch="26.13")
        legacy.pop("structuredDiff")
        notes = public_patch_notes(
            notes=[legacy, patch_note(patch="26.12", kind="buffed"),
                   patch_note(patch="26.11", kind="changed")],
        )

        with tempfile.TemporaryDirectory() as tmpdir:
            root = Path(tmpdir)
            self.write_public_data(root, patch_notes=notes)

            with self.assertRaisesRegex(PatchPublishError, "must declare structuredDiff"):
                verify_patch_publish(root=root, changed_paths=["public/data/patch-notes.json"])

    def test_claimed_diff_without_a_summary_is_rejected(self):
        hollow = patch_note(patch="26.13")
        hollow.pop("summary")
        notes = public_patch_notes(
            notes=[hollow, patch_note(patch="26.12", kind="buffed"),
                   patch_note(patch="26.11", kind="changed")],
        )

        with tempfile.TemporaryDirectory() as tmpdir:
            root = Path(tmpdir)
            self.write_public_data(root, patch_notes=notes)

            with self.assertRaisesRegex(PatchPublishError, "publishes no summary"):
                verify_patch_publish(root=root, changed_paths=["public/data/patch-notes.json"])

    def test_low_zh_tw_text_coverage_is_reported_not_blocking(self):
        """Localized change TEXT is an unimplemented gap, tracked not gated.

        `patch_event_projection._change_text` emits `{"en": ...}` only, so this
        could never pass with real data — it stayed green for 59 days purely
        because the pipeline was producing zero changes. It is reported in the
        summary so the gap stays visible.
        """
        notes = [
            patch_note(patch="26.13", text_zh_tw=None),
            patch_note(patch="26.12", text_zh_tw=None),
            patch_note(patch="26.11", text_zh_tw="修正。"),
        ]
        with tempfile.TemporaryDirectory() as tmpdir:
            root = Path(tmpdir)
            self.write_public_data(root, patch_notes=public_patch_notes(notes=notes))

            summary = verify_patch_publish(root=root, changed_paths=[])

        self.assertEqual(summary["zhTwText"], 1)
        self.assertEqual(summary["zhTwTextLocalizationGap"], 2)

    def test_missing_localized_subject_fails(self):
        """Subject locale keys ARE a real contract and must be enforced."""
        note = patch_note(patch="26.13")
        note["sections"][0]["changes"][0]["subject"] = {"en": "Fixture"}
        with tempfile.TemporaryDirectory() as tmpdir:
            root = Path(tmpdir)
            self.write_public_data(
                root,
                patch_notes=public_patch_notes(
                    notes=[note, patch_note(patch="26.12"), patch_note(patch="26.11")]
                ),
            )

            with self.assertRaisesRegex(PatchPublishError, "localized subject keys"):
                verify_patch_publish(root=root, changed_paths=[])

    def test_structural_patch_mismatch_fails(self):
        with tempfile.TemporaryDirectory() as tmpdir:
            root = Path(tmpdir)
            self.write_public_data(
                root,
                patch_notes=public_patch_notes(patch="26.17"),
                structural_patch="26.18",
            )

            with self.assertRaisesRegex(PatchPublishError, "structural patch mismatch"):
                verify_patch_publish(root=root, changed_paths=[])

    def test_statistics_clock_trailing_structural_is_allowed(self):
        """The normal steady state: statistics lag the live game by a patch."""
        with tempfile.TemporaryDirectory() as tmpdir:
            root = Path(tmpdir)
            self.write_public_data(
                root,
                patch_notes=public_patch_notes(patch="26.18"),
                meta_patch="26.17",
                structural_patch="26.18",
            )

            summary = verify_patch_publish(root=root, changed_paths=[])

        self.assertEqual(summary["patch"], "26.18")

    def test_missing_public_patch_notes_file_fails(self):
        with tempfile.TemporaryDirectory() as tmpdir:
            root = Path(tmpdir)
            self.write_public_data(root, patch_notes=None)

            with self.assertRaisesRegex(PatchPublishError, "missing public patch-notes"):
                verify_patch_publish(root=root, changed_paths=[])

    def test_invalid_kind_fails(self):
        notes = [
            patch_note(patch="26.13", kind="added"),
            patch_note(patch="26.12", kind="experimental"),
            patch_note(patch="26.11", kind="changed"),
        ]
        with tempfile.TemporaryDirectory() as tmpdir:
            root = Path(tmpdir)
            self.write_public_data(root, patch_notes=public_patch_notes(notes=notes))

            with self.assertRaisesRegex(PatchPublishError, "unsupported kind"):
                verify_patch_publish(root=root, changed_paths=[])

    def test_internal_patch_notes_change_requires_public_patch_notes_change(self):
        with tempfile.TemporaryDirectory() as tmpdir:
            root = Path(tmpdir)
            self.write_public_data(root, patch_notes=public_patch_notes())

            with self.assertRaisesRegex(PatchPublishError, "public patch-notes"):
                verify_patch_publish(
                    root=root,
                    changed_paths=["data/internal/patch-events.json"],
                )

    def test_internal_pbe_preview_change_requires_public_preview_change(self):
        with tempfile.TemporaryDirectory() as tmpdir:
            root = Path(tmpdir)
            self.write_public_data(root, patch_notes=public_patch_notes())

            with self.assertRaisesRegex(PatchPublishError, "public PBE preview"):
                verify_patch_publish(
                    root=root,
                    changed_paths=["data/internal/pbe-preview.json", "public/data/patch-notes.json"],
                )


if __name__ == "__main__":
    unittest.main()
