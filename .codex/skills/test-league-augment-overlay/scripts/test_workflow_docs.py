#!/usr/bin/env python3
"""Documentation-as-contract tests for the focus-loss checkpoint.

The analyzer (`analyze_trace.py`) already treats `[focus-transition]` as an
authoritative, primary focus-loss signal. These tests hold the human-facing
workflow docs (`SKILL.md`, `references/validation-protocol.md`) to that same
contract, so the documented checkpoint procedure can never silently drift
from what the analyzer actually accepts.
"""

from __future__ import annotations

import re
import unittest
from pathlib import Path

SKILL_ROOT = Path(__file__).resolve().parent.parent
SKILL_MD = SKILL_ROOT / "SKILL.md"
VALIDATION_PROTOCOL_MD = SKILL_ROOT / "references" / "validation-protocol.md"
ANALYZE_TRACE_PY = Path(__file__).resolve().parent / "analyze_trace.py"

# The documented checkpoint used to wait exclusively on these two signals,
# with no mention of `[focus-transition]` at all — the exact defect Finding 1
# fixed. Neither phrase may reappear in either doc.
OLD_EXCLUSIVE_WAIT_PHRASES = (
    "Wait for either an explicit",
    "Explicit `foreground:false`, or at least two timestamped native "
    "not-foreground classifications spanning three seconds; overlay hidden",
)

GENERIC_DISQUALIFYING_TERMS = (
    "generic occlusion",
    "authorization denial",
    "preview",
    "missing positions",
    "scheduler failure",
    "geometry failure unrelated to focus",
)


class WorkflowDocsTest(unittest.TestCase):
    def setUp(self) -> None:
        self.skill_text = SKILL_MD.read_text(encoding="utf-8")
        self.protocol_text = VALIDATION_PROTOCOL_MD.read_text(encoding="utf-8")
        self.analyzer_text = ANALYZE_TRACE_PY.read_text(encoding="utf-8")
        # Prose wraps at arbitrary column widths in the source markdown, so a
        # multi-word phrase can straddle a line break; normalize whitespace
        # before checking for one, rather than assuming a hard-wrapped file
        # will never be reflowed.
        self.skill_text_flat = re.sub(r"\s+", " ", self.skill_text)
        self.protocol_text_flat = re.sub(r"\s+", " ", self.protocol_text)

    def test_focus_transition_is_documented_in_both_workflow_docs(self) -> None:
        self.assertIn("[focus-transition]", self.skill_text)
        self.assertIn("[focus-transition]", self.protocol_text)

    def test_focus_transition_is_documented_as_the_primary_signal(self) -> None:
        for text in (self.skill_text, self.protocol_text):
            self.assertIn("primary", text.lower())

    def test_checkpoint_is_documented_as_satisfied_by_any_single_signal(self) -> None:
        # A single signal satisfies the checkpoint, not a required combination.
        self.assertIn("any one", self.skill_text)
        self.assertIn("any one of", self.protocol_text)

    def test_old_exclusive_wait_condition_is_absent(self) -> None:
        for phrase in OLD_EXCLUSIVE_WAIT_PHRASES:
            self.assertNotIn(phrase, self.skill_text)
            self.assertNotIn(phrase, self.protocol_text)

    def test_workflow_no_longer_waits_for_geometry_after_the_transition(self) -> None:
        self.assertIn("do not keep waiting", self.skill_text.lower())

    def test_same_positive_generation_is_required(self) -> None:
        for text in (self.skill_text_flat, self.protocol_text_flat):
            self.assertIn("different generation", text)
            self.assertIn("different game epoch", text)

    def test_malformed_and_zero_generations_are_documented_as_disqualifying(
        self,
    ) -> None:
        self.assertIn("malformed, zero, boolean", self.skill_text_flat)

    def test_generic_rejections_are_documented_as_disqualifying(self) -> None:
        for term in GENERIC_DISQUALIFYING_TERMS:
            self.assertIn(term, self.skill_text_flat)

    def test_documented_alt_tab_sequence_matches_the_required_ordering(self) -> None:
        expected = (
            "The documented alt-tab sequence is: valid visible badge "
            "generation N → `[focus-transition]` loss for generation N → "
            "badge authority cleared → the user remains away from the game "
            "for at least five seconds → foreground restored → final "
            "visible badge generation N."
        )
        self.assertIn(expected, self.skill_text_flat)

    def test_documented_signal_name_matches_the_analyzer_accepted_tag(self) -> None:
        # The analyzer's own literal tag/value strings, not a paraphrase, are
        # what the docs must reference — keeps the two from drifting apart.
        self.assertIn('tag == "focus-transition"', self.analyzer_text)
        self.assertIn('"foreground-loss"', self.analyzer_text)
        self.assertIn("[focus-transition]", self.skill_text)
        self.assertIn("[focus-transition]", self.protocol_text)

    def test_checkpoint_matrix_focus_out_row_documents_focus_transition(self) -> None:
        focus_out_row = next(
            line
            for line in self.protocol_text.splitlines()
            if line.startswith("| Focus out |")
        )
        self.assertIn("[focus-transition]", focus_out_row)
        self.assertIn("primary", focus_out_row)

    def test_enforced_invariants_document_focus_transition_as_accepted(self) -> None:
        match = re.search(
            r"- Focus-loss coverage requires.*?(?=\n- )",
            self.protocol_text,
            re.DOTALL,
        )
        self.assertIsNotNone(match)
        self.assertIn("[focus-transition]", match.group(0))
        self.assertIn("primary", match.group(0))


if __name__ == "__main__":
    unittest.main()
