#!/usr/bin/env python3

from __future__ import annotations

import json
import shutil
import subprocess
import tempfile
import unittest
from pathlib import Path

from analyze_trace import (
    ANALYSIS_SCHEMA,
    ARTIFACT_SCHEMA,
    analyze,
    parse_record,
    sha256_file,
)


def tagged(tag: str, payload: dict[str, object]) -> str:
    return f"[{tag}] {json.dumps(payload)}\n"


LIVE_GAME_POLL = {
    "gameflowPhase": "inProgress",
    "gameflowConfirmed": True,
    "captureAllowed": True,
}
IDLE_GAME_POLL = {
    "gameflowPhase": "none",
    "gameflowConfirmed": True,
    "captureAllowed": False,
}


def live_poll() -> str:
    """A confirmed live activation.

    Only this opens a game epoch, and only inside an epoch can offer or
    geometry evidence certify anything — so every fixture that exercises offer
    evidence must start here.
    """
    return tagged("game-poll", LIVE_GAME_POLL)


def badge_layer_payload(generation: int, **overrides: object) -> dict[str, object]:
    """A complete, affirmative FINAL badge-layer decision.

    This is the only record that may certify visible badges, so every fixture
    that expects `rendered`, `focus_loss`, or `focus_recovery` must contain one.
    """
    payload: dict[str, object] = {
        "gameEpoch": 1,
        "badgeLayerVisible": True,
        "reason": "badge-layer-visible",
        "authorized": True,
        "authorizationSource": "fixture",
        "previewMode": False,
        "visibleFrame": True,
        "offerSurface": True,
        "schedulerHealthy": True,
        "offerGeneration": generation,
        "renderedBadgeCount": 3,
        "previewBadgeCount": 0,
    }
    payload.update(overrides)
    return payload


def visible_badges(generation: int, **overrides: object) -> str:
    return tagged("badge-layer", badge_layer_payload(generation, **overrides))


def visible_badges_at(
    generation: int, elapsed_ms: int, **overrides: object
) -> str:
    return timestamped(
        "badge-layer", badge_layer_payload(generation, **overrides), elapsed_ms
    )


def focus_lost_at(generation: int, elapsed_ms: int, **overrides: object) -> str:
    payload: dict[str, object] = {
        "offerState": "OFFER_VISIBLE",
        "render": False,
        "foreground": False,
        "offerGenerationAfter": generation,
    }
    payload.update(overrides)
    return timestamped("offer-session", payload, elapsed_ms)


def focus_transition_at(
    generation: object, elapsed_ms: int, **overrides: object
) -> str:
    payload: dict[str, object] = {
        "transition": "foreground-loss",
        "offerGeneration": generation,
        "gameEpoch": 1,
    }
    payload.update(overrides)
    return timestamped("focus-transition", payload, elapsed_ms)


def offer_state_at(state: str, elapsed_ms: int, **overrides: object) -> str:
    payload: dict[str, object] = {"nextState": state}
    payload.update(overrides)
    return timestamped("offer-state", payload, elapsed_ms)


def native_not_foreground_at(elapsed_ms: int) -> str:
    """One timestamped native not-foreground classification."""
    return timestamped(
        "geometry-timing",
        {
            "stale": True,
            "timeoutClassification": "actual-game-window-not-foreground",
        },
        elapsed_ms,
    )


def timestamped(tag: str, payload: dict[str, object], elapsed_ms: int) -> str:
    return (
        json.dumps(
            {
                "observedAt": "2026-07-28T00:00:00Z",
                "elapsedMs": elapsed_ms,
                "line": tagged(tag, payload).rstrip(),
            }
        )
        + "\n"
    )


class AnalyzeTraceTest(unittest.TestCase):
    def write_trace(self, lines: list[str]) -> Path:
        directory = Path(tempfile.mkdtemp())
        path = directory / "trace.log"
        path.write_text("".join(lines), encoding="utf-8")
        self.addCleanup(lambda: shutil.rmtree(directory))
        return path

    def test_good_session_satisfies_required_coverage(self) -> None:
        path = self.write_trace(
            [
                tagged(
                    "game-poll",
                    {
                        "gameflowPhase": "none",
                        "gameflowConfirmed": True,
                        "captureAllowed": False,
                    },
                ),
                tagged(
                    "game-poll",
                    {
                        "gameflowPhase": "inProgress",
                        "gameflowConfirmed": True,
                        "captureAllowed": True,
                    },
                ),
                tagged(
                    "offer-session",
                    {
                        "offerState": "OFFER_VISIBLE",
                        "render": True,
                        "foreground": True,
                        "zeroRenderReason": "rendered",
                        "newOfferDetected": True,
                        "offerGenerationBefore": 4,
                        "offerGenerationAfter": 5,
                        "invalidatedSlots": [0, 1, 2],
                    },
                ),
                visible_badges_at(5, 1_000),
                focus_lost_at(5, 2_000),
                visible_badges_at(5, 6_000),
                tagged(
                    "game-poll",
                    {
                        "gameflowPhase": "none",
                        "gameflowConfirmed": True,
                        "captureAllowed": False,
                    },
                ),
            ]
        )
        required = {
            "in_progress",
            "rendered",
            "new_offer",
            "focus_loss",
            "focus_recovery",
            "ended",
        }
        result = analyze(path, required)
        self.assertEqual(result["status"], "pass")
        self.assertEqual(
            result["newOfferGenerations"],
            [{"gameEpoch": 1, "generation": 5}],
        )
        self.assertEqual(result["errors"], [])

    def test_healthy_live_session_without_in_progress_poll_is_covered(self) -> None:
        # The healthy Live Client Data path returns early, so a correct session
        # emits NO `[game-poll]` carrying `gameflowPhase: "inProgress"` from the
        # fall-through diagnostic. The one `live-active` ownership record is the
        # authoritative proof that a real game ran.
        path = self.write_trace(
            [
                tagged(
                    "game-poll",
                    {
                        "gameflowPhase": "champSelect",
                        "gameflowConfirmed": True,
                        "captureAllowed": False,
                        "liveDataStatus": "not-requested",
                        "action": "clear-confirmed-non-live",
                    },
                ),
                tagged(
                    "game-poll",
                    {
                        "gameflowPhase": "inProgress",
                        "gameflowConfirmed": True,
                        "captureAllowed": True,
                        "liveDataStatus": "ready",
                        "action": "live-active",
                        "failureAgeMs": 0,
                    },
                ),
                tagged(
                    "offer-session",
                    {
                        "offerState": "OFFER_VISIBLE",
                        "render": True,
                        "foreground": True,
                        "zeroRenderReason": "rendered",
                        "newOfferDetected": True,
                        "offerGenerationBefore": 11,
                        "offerGenerationAfter": 12,
                        "invalidatedSlots": [0, 1, 2],
                    },
                ),
                visible_badges(12),
                tagged(
                    "game-poll",
                    {
                        "gameflowPhase": "endOfGame",
                        "gameflowConfirmed": True,
                        "captureAllowed": False,
                        "liveDataStatus": "not-requested",
                        "action": "clear-confirmed-non-live",
                    },
                ),
            ]
        )
        result = analyze(path, {"in_progress", "rendered", "new_offer", "ended"})

        self.assertEqual(result["status"], "pass")
        self.assertEqual(result["errors"], [])
        self.assertTrue(result["coverage"]["in_progress"])
        self.assertTrue(result["coverage"]["ended"])
        self.assertEqual(
            result["liveActivation"],
            {
                "confirmedGamePollRecords": 1,
                "healthyOwnershipRecords": 1,
                "rejectedOwnershipRecords": 0,
            },
        )

    def test_incomplete_live_active_record_is_rejected(self) -> None:
        complete = {
            "gameflowPhase": "inProgress",
            "gameflowConfirmed": True,
            "captureAllowed": True,
            "liveDataStatus": "ready",
            "action": "live-active",
        }
        degraded = {
            "unconfirmed-gameflow": {"gameflowConfirmed": False},
            "missing-gameflow-confirmation": {"gameflowConfirmed": None},
            "capture-not-allowed": {"captureAllowed": False},
            "live-data-not-ready": {"liveDataStatus": "unavailable"},
            "non-live-phase": {"gameflowPhase": "lobby"},
        }
        for label, override in degraded.items():
            with self.subTest(label=label):
                payload = {**complete, **override}
                result = analyze(
                    self.write_trace([tagged("game-poll", payload)]),
                    {"in_progress"},
                )
                self.assertEqual(result["status"], "fail")
                self.assertFalse(result["coverage"]["in_progress"])
                self.assertTrue(
                    any("live-active" in error for error in result["errors"])
                )
                self.assertEqual(
                    result["liveActivation"]["rejectedOwnershipRecords"], 1
                )
                self.assertEqual(
                    result["liveActivation"]["healthyOwnershipRecords"], 0
                )

    def test_isolated_offer_session_cannot_prove_a_live_game(self) -> None:
        path = self.write_trace(
            [
                tagged(
                    "offer-session",
                    {
                        "offerState": "OFFER_VISIBLE",
                        "render": True,
                        "foreground": True,
                        "zeroRenderReason": "rendered",
                        "newOfferDetected": True,
                        "offerGenerationBefore": 1,
                        "offerGenerationAfter": 2,
                        "invalidatedSlots": [0],
                    },
                )
            ]
        )
        result = analyze(path, {"in_progress", "rendered", "new_offer", "ended"})

        self.assertEqual(result["status"], "partial")
        # No confirmed activation ever opened an epoch, so this offer traffic
        # belongs to no live game and certifies nothing — not even `rendered`.
        self.assertFalse(result["coverage"]["rendered"])
        self.assertFalse(result["coverage"]["new_offer"])
        self.assertFalse(result["coverage"]["in_progress"])
        self.assertFalse(result["coverage"]["ended"])
        self.assertIsNone(result["evaluatedGameEpoch"])
        self.assertEqual(result["gameEpochs"], [])
        self.assertEqual(
            result["liveActivation"],
            {
                "confirmedGamePollRecords": 0,
                "healthyOwnershipRecords": 0,
                "rejectedOwnershipRecords": 0,
            },
        )

    def test_fixture_and_pre_game_noise_cannot_prove_a_live_game(self) -> None:
        # Fixture-driven geometry/OCR/publication traffic plus lobby and
        # champ-select polling is exactly what a non-live development session
        # produces. None of it may satisfy in_progress or ended.
        path = self.write_trace(
            [
                tagged(
                    "game-poll",
                    {
                        "gameflowPhase": "lobby",
                        "gameflowConfirmed": True,
                        "captureAllowed": False,
                        "liveDataStatus": "not-requested",
                        "action": "clear-confirmed-non-live",
                    },
                ),
                tagged("slot-publication", {"slot": 0, "slotGeneration": 3}),
                tagged("identity-publish", {"runId": 1, "cropCount": 3}),
                tagged(
                    "offer-state",
                    {
                        "priorState": "NO_OFFER",
                        "nextState": "OFFER_VISIBLE",
                        "renderDecision": True,
                        "validCardCount": 3,
                    },
                ),
                tagged(
                    "offer-session",
                    {
                        "offerState": "OFFER_VISIBLE",
                        "render": True,
                        "foreground": True,
                        "zeroRenderReason": "rendered",
                        "newOfferDetected": True,
                        "offerGenerationBefore": 7,
                        "offerGenerationAfter": 8,
                        "invalidatedSlots": [2],
                    },
                ),
                tagged("geometry-timing", {"stale": True}),
                tagged(
                    "game-poll",
                    {
                        "gameflowPhase": "champSelect",
                        "gameflowConfirmed": True,
                        "captureAllowed": False,
                        "liveDataStatus": "not-requested",
                        "action": "clear-confirmed-non-live",
                    },
                ),
            ]
        )
        result = analyze(path, {"in_progress", "ended"})

        self.assertEqual(result["status"], "partial")
        self.assertEqual(result["errors"], [])
        self.assertFalse(result["coverage"]["in_progress"])
        self.assertFalse(result["coverage"]["ended"])
        self.assertEqual(result["liveActivation"]["healthyOwnershipRecords"], 0)
        # The fixture offer traffic sat outside every live epoch, so it also
        # certified no render and no new offer.
        self.assertFalse(result["coverage"]["rendered"])
        self.assertFalse(result["coverage"]["new_offer"])
        self.assertFalse(result["coverage"]["occlusion"])
        self.assertEqual(result["gameEpochs"], [])

    def rendered_offer(self, **overrides: object) -> dict[str, object]:
        payload: dict[str, object] = {
            "offerState": "OFFER_VISIBLE",
            "render": True,
            "foreground": True,
            "zeroRenderReason": "rendered",
        }
        payload.update(overrides)
        return payload

    def new_offer(self, before: int, after: int) -> dict[str, object]:
        return self.rendered_offer(
            newOfferDetected=True,
            offerGenerationBefore=before,
            offerGenerationAfter=after,
            invalidatedSlots=[0, 1, 2],
        )

    def test_pre_game_render_cannot_certify_a_live_game_without_offers(self) -> None:
        # The exact regression: a pre-game render, then a real live game that
        # never rendered an offer. The live game must not inherit the earlier
        # evidence.
        path = self.write_trace(
            [
                tagged("offer-session", self.rendered_offer(offerGenerationAfter=2)),
                live_poll(),
                tagged("game-poll", IDLE_GAME_POLL),
            ]
        )
        result = analyze(path, {"in_progress", "rendered", "ended"})

        self.assertEqual(result["status"], "partial")
        self.assertEqual(result["errors"], [])
        self.assertEqual(result["evaluatedGameEpoch"], 1)
        self.assertTrue(result["coverage"]["in_progress"])
        self.assertTrue(result["coverage"]["ended"])
        self.assertFalse(result["coverage"]["rendered"])
        self.assertTrue(
            any("outside the evaluated" in warning for warning in result["warnings"])
        )

    def test_pre_game_new_offer_cannot_satisfy_the_live_epoch(self) -> None:
        path = self.write_trace(
            [
                tagged("offer-session", self.new_offer(7, 8)),
                live_poll(),
            ]
        )
        result = analyze(path, {"in_progress", "new_offer"})

        self.assertEqual(result["status"], "partial")
        self.assertFalse(result["coverage"]["new_offer"])
        self.assertEqual(result["newOfferGenerations"], [])

    def test_preview_offer_traffic_cannot_qualify_a_live_epoch(self) -> None:
        # Preview/fixture surfaces emit the same offer-state and offer-session
        # shapes as a real game; only their position outside an epoch tells them
        # apart, and that must be enough.
        path = self.write_trace(
            [
                tagged(
                    "offer-state",
                    {"nextState": "OCCLUDED", "renderDecision": False},
                ),
                tagged("offer-session", self.new_offer(1, 2)),
                live_poll(),
            ]
        )
        result = analyze(path, {"in_progress", "rendered", "new_offer", "occlusion"})

        self.assertEqual(result["status"], "partial")
        self.assertEqual(result["errors"], [])
        self.assertFalse(result["coverage"]["rendered"])
        self.assertFalse(result["coverage"]["new_offer"])
        self.assertFalse(result["coverage"]["occlusion"])

    def test_live_offer_after_activation_passes(self) -> None:
        path = self.write_trace(
            [
                live_poll(),
                tagged("offer-session", self.new_offer(4, 5)),
                visible_badges(5),
                tagged("game-poll", IDLE_GAME_POLL),
            ]
        )
        result = analyze(path, {"in_progress", "rendered", "new_offer", "ended"})

        self.assertEqual(result["status"], "pass")
        self.assertEqual(result["errors"], [])
        self.assertEqual(result["warnings"], [])
        self.assertEqual(
            result["newOfferGenerations"],
            [{"gameEpoch": 1, "generation": 5}],
        )

    def test_game_one_coverage_cannot_satisfy_game_two(self) -> None:
        path = self.write_trace(
            [
                live_poll(),
                tagged("offer-session", self.new_offer(4, 5)),
                visible_badges(5),
                tagged("game-poll", IDLE_GAME_POLL),
                live_poll(),
            ]
        )
        result = analyze(path, {"in_progress", "rendered", "new_offer"})

        self.assertEqual(result["status"], "partial")
        self.assertEqual(result["evaluatedGameEpoch"], 2)
        self.assertTrue(result["coverage"]["in_progress"])
        self.assertFalse(result["coverage"]["rendered"])
        self.assertFalse(result["coverage"]["new_offer"])
        self.assertEqual(
            [epoch["coverage"]["rendered"] for epoch in result["gameEpochs"]],
            [True, False],
        )

    def test_second_live_active_without_a_non_live_gap_still_opens_a_fresh_epoch(
        self,
    ) -> None:
        # The App.tsx fix: a backward `game_time` bumps gameEpochRef AND resets
        # the liveOwnershipAnnouncedRef announcement latch (advanceGameEpoch),
        # so the very next healthy poll in the new game emits a FRESH
        # `live-active` record — even though no confirmed non-live
        # `[game-poll]` phase ever separated the two games (a missed non-live
        # interval, e.g. a fast reconnect). Steps, matching the required
        # integration fixture:
        #   1. Game one emits `live-active`.
        #   2. Game one emits rendered and new-offer evidence.
        #   3. No non-live record occurs.
        #   4. (game_time moves backward — an App.tsx-internal signal with no
        #      trace field of its own; its only observable trace consequence
        #      is step 5.)
        #   5. Game two emits a fresh `live-active`.
        #   6. Game two emits no offer evidence.
        healthy_live_active = {
            "gameflowPhase": "inProgress",
            "gameflowConfirmed": True,
            "captureAllowed": True,
            "liveDataStatus": "ready",
            "action": "live-active",
            "failureAgeMs": 0,
        }
        path = self.write_trace(
            [
                tagged("game-poll", healthy_live_active),  # 1
                tagged("offer-session", self.new_offer(4, 5)),  # 2
                visible_badges(5),  # 2
                # 3: no non-live game-poll record in between.
                tagged("game-poll", healthy_live_active),  # 5 (game two, no offer evidence: 6)
            ]
        )
        result = analyze(path, {"in_progress", "rendered", "new_offer"})

        self.assertEqual(result["status"], "partial")
        self.assertEqual(result["errors"], [])
        self.assertEqual(result["evaluatedGameEpoch"], 2)
        self.assertTrue(result["coverage"]["in_progress"])
        self.assertFalse(result["coverage"]["rendered"])
        self.assertFalse(result["coverage"]["new_offer"])
        self.assertEqual(
            [epoch["coverage"]["rendered"] for epoch in result["gameEpochs"]],
            [True, False],
        )
        self.assertEqual(
            [epoch["coverage"]["new_offer"] for epoch in result["gameEpochs"]],
            [True, False],
        )
        self.assertEqual(
            result["liveActivation"],
            {
                "confirmedGamePollRecords": 2,
                "healthyOwnershipRecords": 2,
                "rejectedOwnershipRecords": 0,
            },
        )

    def test_fixture_a_back_to_back_games_each_epoch_gets_its_own_evidence(
        self,
    ) -> None:
        # Required integration fixture ("Fixture A"): two confirmed games with
        # NO non-live gap between them. Game one's activation, offer, and
        # badge evidence land in epoch 1; game two's activation — emitted in
        # the SAME poll as the boundary, per beginNewGameEpoch's ordering —
        # opens a clean epoch 2, and game two's own offer/badge evidence
        # lands there, never inherited from or leaking into game one.
        #   1. Game one emits live-active.
        #   2. Game one emits offer/render evidence.
        #   3. No confirmed non-live poll occurs.
        #   4/5. A changed identity or backward game_time fires internally in
        #      App.tsx; game two's live-active is announced in that SAME
        #      poll, before any game-two evidence.
        #   6. Game two emits its own valid offer/render evidence.
        healthy_live_active = {
            "gameflowPhase": "inProgress",
            "gameflowConfirmed": True,
            "captureAllowed": True,
            "liveDataStatus": "ready",
            "action": "live-active",
            "failureAgeMs": 0,
        }
        path = self.write_trace(
            [
                tagged("game-poll", healthy_live_active),  # 1
                tagged("offer-session", self.new_offer(4, 5)),  # 2
                visible_badges(5),  # 2
                # 3: no confirmed non-live poll in between.
                tagged("game-poll", healthy_live_active),  # 4/5: game two live-active
                tagged("offer-session", self.new_offer(1, 2)),  # 6
                visible_badges(2),  # 6
            ]
        )
        result = analyze(path, {"in_progress", "rendered", "new_offer"})

        self.assertEqual(result["status"], "pass")
        self.assertEqual(result["errors"], [])
        self.assertEqual(len(result["gameEpochs"]), 2)
        self.assertEqual(result["evaluatedGameEpoch"], 2)
        # Game two's own coverage — not borrowed from game one, and not
        # missing because it was misattributed to the closed epoch.
        self.assertTrue(result["coverage"]["rendered"])
        self.assertTrue(result["coverage"]["new_offer"])
        self.assertEqual(
            [epoch["coverage"]["rendered"] for epoch in result["gameEpochs"]],
            [True, True],
        )
        self.assertEqual(
            [epoch["coverage"]["new_offer"] for epoch in result["gameEpochs"]],
            [True, True],
        )
        # Game two's own offer generation (2), scoped to epoch 2 — never
        # merged with game one's generation (5).
        self.assertEqual(
            result["newOfferGenerations"],
            [
                {"gameEpoch": 1, "generation": 5},
                {"gameEpoch": 2, "generation": 2},
            ],
        )
        self.assertEqual(
            result["liveActivation"],
            {
                "confirmedGamePollRecords": 2,
                "healthyOwnershipRecords": 2,
                "rejectedOwnershipRecords": 0,
            },
        )

    def test_fixture_b_prolonged_outage_recovery_stays_in_one_epoch(self) -> None:
        # Required integration fixture ("Fixture B"): a single confirmed game
        # survives an unconfirmed telemetry outage past the fail-closed grace
        # window. suspendGameRuntimeForUnavailableTelemetry fails rendering
        # closed WITHOUT closing game identity or resetting the activation
        # latch, so recovery of the SAME match emits "recover" — never a
        # second "live-active" — and its evidence stays in epoch 1.
        #   1. One game emits live-active.
        #   2. Valid pre-outage offer/render evidence.
        #   3/4. Telemetry unavailable beyond the grace period; rendering
        #      fails closed (no offer/badge evidence follows until recovery).
        #   5/6. The same game recovers with unchanged identity and forward
        #      game time — no second live-active, only "recover".
        #   7. Post-recovery evidence continues in the original epoch.
        healthy_live_active = {
            "gameflowPhase": "inProgress",
            "gameflowConfirmed": True,
            "captureAllowed": True,
            "liveDataStatus": "ready",
            "action": "live-active",
            "failureAgeMs": 0,
        }
        path = self.write_trace(
            [
                tagged("game-poll", healthy_live_active),  # 1
                tagged("offer-session", self.new_offer(4, 5)),  # 2
                visible_badges(5),  # 2
                # 3/4: unconfirmed outage past grace — LCU read failed
                # (gameflowConfirmed False), Live Client Data unavailable,
                # capture carried forward as allowed.
                tagged(
                    "game-poll",
                    {
                        "gameflowPhase": "unavailable",
                        "gameflowConfirmed": False,
                        "captureAllowed": True,
                        "liveDataStatus": "unavailable",
                        "action": "clear",
                    },
                ),
                # 5/6: the SAME match recovers — forward game_time, unchanged
                # identity, "recover" (not "live-active").
                tagged(
                    "game-poll",
                    {
                        "gameflowPhase": "inProgress",
                        "gameflowConfirmed": True,
                        "captureAllowed": True,
                        "liveDataStatus": "ready",
                        "action": "recover",
                        "failureAgeMs": 45_000,
                    },
                ),
                tagged("offer-session", self.new_offer(6, 7)),  # 7
                visible_badges(7),  # 7
            ]
        )
        result = analyze(path, {"in_progress", "rendered", "new_offer"})

        self.assertEqual(result["status"], "pass")
        self.assertEqual(result["errors"], [])
        self.assertEqual(len(result["gameEpochs"]), 1)
        self.assertEqual(result["evaluatedGameEpoch"], 1)
        self.assertTrue(result["coverage"]["in_progress"])
        self.assertTrue(result["coverage"]["rendered"])
        self.assertTrue(result["coverage"]["new_offer"])
        # Both the pre- and post-outage offer generations landed in epoch 1 —
        # recovery did not open a fresh epoch that would strand the
        # pre-outage generation behind the evaluated epoch boundary.
        self.assertEqual(
            result["newOfferGenerations"],
            [{"gameEpoch": 1, "generation": 5}, {"gameEpoch": 1, "generation": 7}],
        )
        self.assertEqual(
            result["liveActivation"],
            {
                "confirmedGamePollRecords": 2,
                "healthyOwnershipRecords": 1,
                "rejectedOwnershipRecords": 0,
            },
        )
        self.assertTrue(
            any("action 'clear'" in warning for warning in result["warnings"])
        )

    def test_confirmed_game_poll_activation_starts_a_clean_epoch(self) -> None:
        # Generation 9 belongs to the pre-game scope, so generation 2 inside the
        # epoch is not a regression, and the epoch's own maximum starts unset.
        path = self.write_trace(
            [
                tagged("offer-session", self.rendered_offer(offerGenerationAfter=9)),
                live_poll(),
                tagged("offer-session", self.new_offer(1, 2)),
            ]
        )
        result = analyze(path, {"in_progress", "new_offer"})

        self.assertEqual(result["status"], "pass")
        self.assertEqual(result["errors"], [])
        self.assertEqual(result["evaluatedGameEpoch"], 1)
        self.assertEqual(
            result["newOfferGenerations"],
            [{"gameEpoch": 1, "generation": 2}],
        )

    def test_healthy_live_activation_starts_a_clean_epoch(self) -> None:
        path = self.write_trace(
            [
                tagged("offer-session", self.rendered_offer(offerGenerationAfter=9)),
                tagged(
                    "game-poll",
                    {
                        "gameflowPhase": "inProgress",
                        "gameflowConfirmed": True,
                        "captureAllowed": True,
                        "liveDataStatus": "ready",
                        "action": "live-active",
                        "failureAgeMs": 0,
                    },
                ),
                tagged("offer-session", self.new_offer(1, 2)),
                visible_badges(2),
            ]
        )
        result = analyze(path, {"in_progress", "rendered", "new_offer"})

        self.assertEqual(result["status"], "pass")
        self.assertEqual(result["errors"], [])
        self.assertEqual(result["evaluatedGameEpoch"], 1)
        self.assertEqual(result["liveActivation"]["healthyOwnershipRecords"], 1)
        self.assertEqual(
            result["newOfferGenerations"],
            [{"gameEpoch": 1, "generation": 2}],
        )

    def test_transient_unavailable_records_preserve_the_epoch(self) -> None:
        # An unconfirmed `unavailable` blip must not close the epoch, so an
        # offer that arrives after it still belongs to the live game.
        path = self.write_trace(
            [
                live_poll(),
                tagged(
                    "game-poll",
                    {
                        "gameflowPhase": "unavailable",
                        "gameflowConfirmed": False,
                        "captureAllowed": True,
                        "action": "preserve",
                    },
                ),
                tagged("offer-session", self.new_offer(4, 5)),
                visible_badges(5),
            ]
        )
        result = analyze(path, {"in_progress", "rendered", "new_offer"})

        self.assertEqual(result["status"], "pass")
        self.assertEqual(result["errors"], [])
        self.assertEqual(result["evaluatedGameEpoch"], 1)
        self.assertEqual(len(result["gameEpochs"]), 1)

    def test_post_end_offer_noise_is_ignored(self) -> None:
        path = self.write_trace(
            [
                live_poll(),
                tagged("game-poll", IDLE_GAME_POLL),
                tagged("offer-session", self.new_offer(4, 5)),
            ]
        )
        result = analyze(path, {"in_progress", "rendered", "new_offer", "ended"})

        self.assertEqual(result["status"], "partial")
        self.assertEqual(result["errors"], [])
        self.assertTrue(result["coverage"]["ended"])
        self.assertFalse(result["coverage"]["rendered"])
        self.assertFalse(result["coverage"]["new_offer"])
        self.assertEqual(result["newOfferGenerations"], [])

    def test_one_internally_complete_epoch_passes(self) -> None:
        path = self.write_trace(
            [
                tagged("offer-session", self.rendered_offer(offerGenerationAfter=99)),
                visible_badges(99),
                live_poll(),
                tagged("offer-session", self.new_offer(4, 5)),
                visible_badges_at(5, 1_000),
                focus_lost_at(5, 2_000),
                visible_badges_at(5, 6_000),
                tagged("game-poll", IDLE_GAME_POLL),
                tagged("offer-session", self.new_offer(6, 7)),
                visible_badges(7),
            ]
        )
        result = analyze(
            path,
            {
                "in_progress",
                "rendered",
                "new_offer",
                "focus_loss",
                "focus_recovery",
                "ended",
            },
        )

        self.assertEqual(result["status"], "pass")
        self.assertEqual(result["errors"], [])
        self.assertEqual(result["evaluatedGameEpoch"], 1)

    def test_focus_evidence_cannot_be_borrowed_from_another_epoch(self) -> None:
        # Game one loses focus; game two regains it 5 s later. Without epoch
        # scoping that pair would forge a focus recovery for game two.
        path = self.write_trace(
            [
                live_poll(),
                visible_badges_at(1, 500),
                focus_lost_at(1, 1_000),
                tagged("game-poll", IDLE_GAME_POLL),
                live_poll(),
                visible_badges_at(1, 6_000),
            ]
        )
        result = analyze(path, {"focus_loss", "focus_recovery"})

        self.assertEqual(result["status"], "partial")
        self.assertFalse(result["coverage"]["focus_recovery"])
        self.assertFalse(result["coverage"]["focus_loss"])
        self.assertEqual(result["focusEvidence"]["observedLossDurationsMs"], [])
        self.assertNotIn(
            "focus_recovery",
            [event["kind"] for event in result["notableEvents"]],
        )

    def test_live_active_state_survives_unconfirmed_unavailable_records(self) -> None:
        path = self.write_trace(
            [
                tagged(
                    "game-poll",
                    {
                        "gameflowPhase": "inProgress",
                        "gameflowConfirmed": True,
                        "captureAllowed": True,
                        "liveDataStatus": "ready",
                        "action": "live-active",
                    },
                ),
                tagged(
                    "game-poll",
                    {
                        "gameflowPhase": "unavailable",
                        "gameflowConfirmed": False,
                        "captureAllowed": True,
                        "liveDataStatus": "unavailable",
                        "action": "preserve",
                    },
                ),
            ]
        )
        result = analyze(path, {"in_progress", "ended"})

        self.assertEqual(result["status"], "partial")
        self.assertEqual(result["errors"], [])
        self.assertTrue(result["coverage"]["in_progress"])
        self.assertFalse(result["coverage"]["ended"])

    def test_confirmed_true_gameflow_activates_and_ends_a_game(self) -> None:
        # Positive control for the strict confirmation rule below.
        path = self.write_trace(
            [
                tagged(
                    "game-poll",
                    {
                        "gameflowPhase": "inProgress",
                        "gameflowConfirmed": True,
                        "captureAllowed": True,
                    },
                ),
                tagged(
                    "game-poll",
                    {
                        "gameflowPhase": "endOfGame",
                        "gameflowConfirmed": True,
                        "captureAllowed": False,
                    },
                ),
            ]
        )
        result = analyze(path, {"in_progress", "ended"})

        self.assertEqual(result["status"], "pass")
        self.assertEqual(result["errors"], [])
        self.assertEqual(result["liveActivation"]["confirmedGamePollRecords"], 1)

    def test_missing_gameflow_confirmation_cannot_activate_a_game(self) -> None:
        # A record that simply omits `gameflowConfirmed` is malformed, not an
        # authority: absence of the field is not affirmative confirmation.
        path = self.write_trace(
            [tagged("game-poll", {"gameflowPhase": "inProgress", "captureAllowed": True})]
        )
        result = analyze(path, {"in_progress"})

        self.assertEqual(result["status"], "partial")
        self.assertFalse(result["coverage"]["in_progress"])
        self.assertEqual(result["liveActivation"]["confirmedGamePollRecords"], 0)

    def test_missing_gameflow_confirmation_cannot_end_a_game(self) -> None:
        path = self.write_trace(
            [
                tagged(
                    "game-poll",
                    {
                        "gameflowPhase": "inProgress",
                        "gameflowConfirmed": True,
                        "captureAllowed": True,
                    },
                ),
                tagged("game-poll", {"gameflowPhase": "endOfGame", "captureAllowed": False}),
            ]
        )
        result = analyze(path, {"in_progress", "ended"})

        self.assertEqual(result["status"], "partial")
        self.assertEqual(result["errors"], [])
        self.assertTrue(result["coverage"]["in_progress"])
        self.assertFalse(result["coverage"]["ended"])

    def test_non_boolean_gameflow_confirmation_is_unconfirmed(self) -> None:
        # Only the boolean singleton True confirms. JSON null, the integers 0
        # and 1 (note `1 is True` is False in Python), and the strings "true"
        # and "false" are all malformed values that must earn no credit.
        omitted = object()
        for label, value in (
            ("null", None),
            ("zero", 0),
            ("one", 1),
            ("string-true", "true"),
            ("string-false", "false"),
            ("false", False),
            ("omitted", omitted),
        ):
            with self.subTest(label=label):
                payload: dict[str, object] = {
                    "gameflowPhase": "inProgress",
                    "captureAllowed": True,
                }
                if value is not omitted:
                    payload["gameflowConfirmed"] = value
                result = analyze(
                    self.write_trace([tagged("game-poll", payload)]),
                    {"in_progress"},
                )
                self.assertEqual(result["status"], "partial")
                self.assertFalse(result["coverage"]["in_progress"])
                self.assertEqual(
                    result["liveActivation"]["confirmedGamePollRecords"], 0
                )

    def test_unconfirmed_unavailable_preserves_prior_confirmed_live_state(self) -> None:
        # The existing grace behaviour: a confirmed live game stays live across
        # unconfirmed `unavailable` samples instead of being falsely ended.
        path = self.write_trace(
            [
                tagged(
                    "game-poll",
                    {
                        "gameflowPhase": "inProgress",
                        "gameflowConfirmed": True,
                        "captureAllowed": True,
                    },
                ),
                tagged(
                    "game-poll",
                    {
                        "gameflowPhase": "unavailable",
                        "gameflowConfirmed": False,
                        "captureAllowed": True,
                        "action": "preserve",
                    },
                ),
            ]
        )
        result = analyze(path, {"in_progress", "ended"})

        self.assertEqual(result["status"], "partial")
        self.assertEqual(result["errors"], [])
        self.assertTrue(result["coverage"]["in_progress"])
        self.assertFalse(result["coverage"]["ended"])

    def test_malformed_records_cannot_prop_up_the_live_diagnostic(self) -> None:
        # The healthy-live diagnostic proves activation through its own strict
        # `live-active` validation. Malformed neighbours are inert: they neither
        # break that proof nor become a fallback source of lifecycle credit.
        path = self.write_trace(
            [
                tagged("game-poll", {"gameflowPhase": "inProgress", "captureAllowed": True}),
                tagged(
                    "game-poll",
                    {
                        "gameflowPhase": "inProgress",
                        "gameflowConfirmed": True,
                        "captureAllowed": True,
                        "liveDataStatus": "ready",
                        "action": "live-active",
                        "failureAgeMs": 0,
                    },
                ),
                tagged(
                    "game-poll",
                    {
                        "gameflowPhase": "none",
                        "gameflowConfirmed": "true",
                        "captureAllowed": True,
                    },
                ),
                tagged(
                    "game-poll",
                    {
                        "gameflowPhase": "endOfGame",
                        "gameflowConfirmed": True,
                        "captureAllowed": False,
                    },
                ),
            ]
        )
        result = analyze(path, {"in_progress", "ended"})

        self.assertEqual(result["status"], "pass")
        self.assertEqual(result["errors"], [])
        self.assertEqual(
            result["liveActivation"],
            {
                "confirmedGamePollRecords": 1,
                "healthyOwnershipRecords": 1,
                "rejectedOwnershipRecords": 0,
            },
        )

    def test_malformed_lifecycle_pair_remains_partial(self) -> None:
        path = self.write_trace(
            [
                tagged("game-poll", {"gameflowPhase": "inProgress", "captureAllowed": True}),
                tagged("game-poll", {"gameflowPhase": "endOfGame", "captureAllowed": False}),
            ]
        )
        result = analyze(path, {"in_progress", "ended"})

        self.assertEqual(result["status"], "partial")
        self.assertFalse(result["coverage"]["in_progress"])
        self.assertFalse(result["coverage"]["ended"])
        self.assertEqual(
            result["liveActivation"],
            {
                "confirmedGamePollRecords": 0,
                "healthyOwnershipRecords": 0,
                "rejectedOwnershipRecords": 0,
            },
        )

    def test_high_confidence_invariant_failures_are_errors(self) -> None:
        duplicate = {
            "offerState": "OFFER_VISIBLE",
            "render": True,
            "foreground": False,
            "zeroRenderReason": "rendered",
            "newOfferDetected": True,
            "offerGenerationBefore": 2,
            "offerGenerationAfter": 3,
            "invalidatedSlots": [1],
        }
        path = self.write_trace(
            [
                tagged(
                    "game-poll",
                    {
                        "gameflowPhase": "none",
                        "gameflowConfirmed": True,
                        "captureAllowed": True,
                    },
                ),
                tagged("offer-session", duplicate),
                tagged("offer-session", duplicate),
            ]
        )
        result = analyze(path, {"rendered"})
        self.assertEqual(result["status"], "fail")
        self.assertTrue(any("non-live" in error for error in result["errors"]))
        self.assertTrue(any("not foreground" in error for error in result["errors"]))
        self.assertTrue(any("more than once" in error for error in result["errors"]))

    def test_unconfirmed_unavailable_without_capture_is_unknown(self) -> None:
        path = self.write_trace(
            [
                tagged(
                    "game-poll",
                    {
                        "gameflowPhase": "unavailable",
                        "gameflowConfirmed": False,
                        "captureAllowed": False,
                        "liveDataStatus": "unavailable",
                        "action": "clear",
                    },
                ),
                tagged(
                    "game-poll",
                    {
                        "gameflowPhase": "inProgress",
                        "gameflowConfirmed": True,
                        "captureAllowed": True,
                    },
                ),
            ]
        )
        result = analyze(path, {"in_progress"})
        self.assertEqual(result["status"], "pass")
        self.assertEqual(result["errors"], [])
        self.assertEqual(result["warnings"], [])

    def test_confirmed_live_data_unavailable_preserve_is_valid(self) -> None:
        path = self.write_trace(
            [
                tagged(
                    "game-poll",
                    {
                        "gameflowPhase": "inProgress",
                        "gameflowConfirmed": True,
                        "captureAllowed": True,
                        "liveDataStatus": "unavailable",
                        "action": "preserve",
                    },
                )
            ]
        )
        result = analyze(path, {"in_progress"})
        self.assertEqual(result["status"], "pass")
        self.assertEqual(result["errors"], [])
        self.assertEqual(result["warnings"], [])

    def test_unconfirmed_unavailable_preserve_is_transient(self) -> None:
        path = self.write_trace(
            [
                tagged(
                    "game-poll",
                    {
                        "gameflowPhase": "inProgress",
                        "gameflowConfirmed": True,
                        "captureAllowed": True,
                    },
                ),
                tagged(
                    "game-poll",
                    {
                        "gameflowPhase": "unavailable",
                        "gameflowConfirmed": False,
                        "captureAllowed": True,
                        "liveDataStatus": "unavailable",
                        "action": "preserve",
                    },
                ),
            ]
        )
        result = analyze(path, {"in_progress"})
        self.assertEqual(result["status"], "pass")
        self.assertEqual(result["errors"], [])
        self.assertEqual(result["warnings"], [])
        self.assertFalse(result["coverage"]["ended"])

    def test_unconfirmed_unavailable_clear_with_capture_warns(self) -> None:
        path = self.write_trace(
            [
                tagged(
                    "game-poll",
                    {
                        "gameflowPhase": "inProgress",
                        "gameflowConfirmed": True,
                        "captureAllowed": True,
                    },
                ),
                tagged(
                    "game-poll",
                    {
                        "gameflowPhase": "unavailable",
                        "gameflowConfirmed": False,
                        "captureAllowed": True,
                        "liveDataStatus": "unavailable",
                        "action": "clear",
                    },
                ),
            ]
        )
        result = analyze(path, {"in_progress"})
        self.assertEqual(result["status"], "pass")
        self.assertEqual(result["errors"], [])
        self.assertTrue(
            any("action 'clear'" in warning for warning in result["warnings"])
        )
        self.assertFalse(
            any("Confirmed non-live" in message for message in result["warnings"])
        )
        self.assertFalse(result["coverage"]["ended"])

    def test_confirmed_non_live_capture_allowed_fails(self) -> None:
        for phase in (
            "lobby",
            "matchmaking",
            "readyCheck",
            "champSelect",
            "endOfGame",
        ):
            with self.subTest(phase=phase):
                path = self.write_trace(
                    [
                        tagged(
                            "game-poll",
                            {
                                "gameflowPhase": "inProgress",
                                "gameflowConfirmed": True,
                                "captureAllowed": True,
                            },
                        ),
                        tagged(
                            "game-poll",
                            {
                                "gameflowPhase": phase,
                                "gameflowConfirmed": True,
                                "captureAllowed": True,
                            },
                        ),
                    ]
                )
                result = analyze(path, {"in_progress", "ended"})
                self.assertEqual(result["status"], "fail")
                self.assertIn(
                    f"Confirmed non-live phase {phase!r} allowed capture.",
                    result["errors"],
                )

    def test_missing_foreground_is_unknown_not_focus_loss(self) -> None:
        path = self.write_trace(
            [
                live_poll(),
                tagged(
                    "offer-session",
                    {
                        "offerState": "OFFER_VISIBLE",
                        "render": True,
                        "zeroRenderReason": "rendered",
                        "offerGenerationAfter": 1,
                    },
                )
            ]
        )
        result = analyze(path, {"rendered"})
        self.assertEqual(result["status"], "fail")
        self.assertFalse(result["coverage"]["focus_loss"])
        self.assertTrue(
            any("foreground authority" in error for error in result["errors"])
        )
        self.assertEqual(
            result["foregroundAuthority"],
            {
                "renderedRecords": 1,
                "missingOrInvalidRecords": 1,
                "missingOrInvalidRatio": 1.0,
            },
        )

    def test_nonboolean_foreground_is_unknown_not_authority(self) -> None:
        path = self.write_trace(
            [
                live_poll(),
                tagged(
                    "offer-session",
                    {
                        "offerState": "OFFER_VISIBLE",
                        "render": True,
                        "foreground": "unknown",
                        "zeroRenderReason": "rendered",
                        "offerGenerationAfter": 1,
                    },
                )
            ]
        )
        result = analyze(path, {"rendered"})
        self.assertEqual(result["status"], "fail")
        self.assertFalse(result["coverage"]["focus_loss"])
        self.assertTrue(
            any("foreground authority" in error for error in result["errors"])
        )

    def test_native_not_foreground_timeout_does_not_fake_focus_checkpoint(
        self,
    ) -> None:
        path = self.write_trace(
            [
                live_poll(),
                visible_badges_at(1, 500),
                tagged(
                    "geometry-timing",
                    {
                        "stale": True,
                        "timeoutClassification": "actual-game-window-not-foreground",
                    },
                ),
                visible_badges_at(1, 5_000),
            ]
        )
        result = analyze(path, {"rendered", "focus_loss", "focus_recovery"})
        self.assertEqual(result["status"], "partial")
        self.assertTrue(result["coverage"]["rendered"])
        self.assertFalse(result["coverage"]["focus_loss"])
        self.assertFalse(result["coverage"]["focus_recovery"])
        self.assertEqual(result["counts"]["stale-results"], 1)

    def test_timestamped_native_focus_dwell_can_satisfy_checkpoint(self) -> None:
        path = self.write_trace(
            [
                live_poll(),
                visible_badges_at(1, 500),
                timestamped(
                    "geometry-timing",
                    {
                        "stale": True,
                        "timeoutClassification": "actual-game-window-not-foreground",
                    },
                    1_000,
                ),
                timestamped(
                    "geometry-timing",
                    {
                        "stale": True,
                        "timeoutClassification": "actual-game-window-not-foreground",
                    },
                    4_500,
                ),
                visible_badges_at(1, 5_000),
            ]
        )
        result = analyze(path, {"rendered", "focus_loss", "focus_recovery"})
        self.assertEqual(result["status"], "pass")
        self.assertTrue(result["coverage"]["focus_loss"])
        self.assertTrue(result["coverage"]["focus_recovery"])
        self.assertEqual(result["focusEvidence"]["observedLossDurationsMs"], [4000.0])

    def test_inconclusive_native_records_do_not_reset_focus_streak(self) -> None:
        interleaved_records = {
            "capture-timeout": {
                "stale": True,
                "timeoutClassification": "capture-timeout",
            },
            "capture-busy": {
                "stale": True,
                "timeoutClassification": "capture-busy",
            },
            "stale-unclassified": {"stale": True},
        }
        for label, interleaved in interleaved_records.items():
            with self.subTest(label=label):
                path = self.write_trace(
                    [
                        live_poll(),
                        visible_badges_at(1, 500),
                        timestamped(
                            "geometry-timing",
                            {
                                "stale": True,
                                "timeoutClassification": (
                                    "actual-game-window-not-foreground"
                                ),
                            },
                            1_000,
                        ),
                        timestamped("geometry-timing", interleaved, 2_500),
                        timestamped(
                            "geometry-timing",
                            {
                                "stale": True,
                                "timeoutClassification": (
                                    "actual-game-window-not-foreground"
                                ),
                            },
                            4_000,
                        ),
                        visible_badges_at(1, 4_500),
                    ]
                )
                result = analyze(
                    path,
                    {"rendered", "focus_loss", "focus_recovery"},
                )
                self.assertEqual(result["status"], "pass")
                self.assertTrue(result["coverage"]["focus_loss"])
                self.assertTrue(result["coverage"]["focus_recovery"])
                self.assertEqual(
                    result["focusEvidence"]["observedLossDurationsMs"],
                    [3500.0],
                )

    def test_successful_native_probe_resets_focus_streak(self) -> None:
        path = self.write_trace(
            [
                live_poll(),
                visible_badges_at(1, 500),
                timestamped(
                    "geometry-timing",
                    {
                        "stale": True,
                        "timeoutClassification": "actual-game-window-not-foreground",
                    },
                    1_000,
                ),
                timestamped(
                    "geometry-timing",
                    {"stale": False, "timeoutClassification": "none"},
                    2_000,
                ),
                timestamped(
                    "geometry-timing",
                    {
                        "stale": True,
                        "timeoutClassification": "actual-game-window-not-foreground",
                    },
                    4_500,
                ),
                visible_badges_at(1, 5_000),
            ]
        )
        result = analyze(path, {"rendered", "focus_loss", "focus_recovery"})
        self.assertEqual(result["status"], "partial")
        self.assertTrue(result["coverage"]["rendered"])
        self.assertFalse(result["coverage"]["focus_loss"])
        self.assertFalse(result["coverage"]["focus_recovery"])

    def test_affirmative_foreground_recovery_resets_native_streak(self) -> None:
        path = self.write_trace(
            [
                live_poll(),
                visible_badges_at(1, 500),
                timestamped(
                    "geometry-timing",
                    {
                        "stale": True,
                        "timeoutClassification": "actual-game-window-not-foreground",
                    },
                    1_000,
                ),
                timestamped(
                    "offer-session",
                    {
                        "offerState": "NO_OFFER",
                        "render": False,
                        "foreground": True,
                        "offerGenerationAfter": 1,
                    },
                    2_000,
                ),
                timestamped(
                    "geometry-timing",
                    {
                        "stale": True,
                        "timeoutClassification": "actual-game-window-not-foreground",
                    },
                    4_500,
                ),
                visible_badges_at(1, 5_000),
            ]
        )
        result = analyze(path, {"rendered", "focus_loss", "focus_recovery"})
        self.assertEqual(result["status"], "partial")
        self.assertTrue(result["coverage"]["rendered"])
        self.assertFalse(result["coverage"]["focus_loss"])
        self.assertFalse(result["coverage"]["focus_recovery"])

    def test_one_native_event_cannot_satisfy_focus_coverage(self) -> None:
        path = self.write_trace(
            [
                live_poll(),
                visible_badges_at(1, 500),
                timestamped(
                    "geometry-timing",
                    {
                        "stale": True,
                        "timeoutClassification": "actual-game-window-not-foreground",
                    },
                    1_000,
                ),
                visible_badges_at(1, 5_000),
            ]
        )
        result = analyze(path, {"rendered", "focus_loss", "focus_recovery"})
        self.assertEqual(result["status"], "partial")
        self.assertTrue(result["coverage"]["rendered"])
        self.assertFalse(result["coverage"]["focus_loss"])
        self.assertFalse(result["coverage"]["focus_recovery"])

    def test_native_span_below_minimum_cannot_satisfy_focus_coverage(self) -> None:
        path = self.write_trace(
            [
                live_poll(),
                visible_badges_at(1, 500),
                timestamped(
                    "geometry-timing",
                    {
                        "stale": True,
                        "timeoutClassification": "actual-game-window-not-foreground",
                    },
                    1_000,
                ),
                timestamped(
                    "geometry-timing",
                    {
                        "stale": True,
                        "timeoutClassification": "actual-game-window-not-foreground",
                    },
                    3_999,
                ),
                visible_badges_at(1, 5_000),
            ]
        )
        result = analyze(path, {"rendered", "focus_loss", "focus_recovery"})
        self.assertEqual(result["status"], "partial")
        self.assertTrue(result["coverage"]["rendered"])
        self.assertFalse(result["coverage"]["focus_loss"])
        self.assertFalse(result["coverage"]["focus_recovery"])

    def test_short_explicit_focus_blip_cannot_satisfy_recovery(self) -> None:
        path = self.write_trace(
            [
                live_poll(),
                visible_badges_at(1, 500),
                focus_lost_at(1, 1_000),
                visible_badges_at(1, 1_200),
            ]
        )
        result = analyze(path, {"focus_loss", "focus_recovery"})
        self.assertEqual(result["status"], "partial")
        self.assertTrue(result["coverage"]["focus_loss"])
        self.assertFalse(result["coverage"]["focus_recovery"])
        self.assertEqual(result["focusEvidence"]["observedLossDurationsMs"], [200.0])

    def test_repeated_explicit_focus_loss_uses_earliest_timestamp(self) -> None:
        lines = [live_poll(), visible_badges_at(1, 500)] + [
            focus_lost_at(1, elapsed_ms)
            for elapsed_ms in (1_000, 2_000, 3_000, 4_000)
        ]
        lines.append(visible_badges_at(1, 6_000))
        result = analyze(
            self.write_trace(lines),
            {"rendered", "focus_loss", "focus_recovery"},
        )

        self.assertEqual(result["status"], "pass")
        self.assertEqual(result["focusEvidence"]["observedLossDurationsMs"], [5000.0])
        self.assertEqual(
            sum(
                event["kind"] == "focus_loss"
                for event in result["notableEvents"]
            ),
            1,
        )

    def test_repeated_explicit_focus_loss_below_dwell_remains_partial(self) -> None:
        lines = [live_poll(), visible_badges_at(1, 500)] + [
            focus_lost_at(1, elapsed_ms) for elapsed_ms in (1_000, 2_000, 3_000)
        ]
        lines.append(visible_badges_at(1, 3_500))
        result = analyze(
            self.write_trace(lines),
            {"rendered", "focus_loss", "focus_recovery"},
        )

        self.assertEqual(result["status"], "partial")
        self.assertTrue(result["coverage"]["focus_loss"])
        self.assertFalse(result["coverage"]["focus_recovery"])
        self.assertEqual(result["focusEvidence"]["observedLossDurationsMs"], [2500.0])
        self.assertEqual(
            sum(
                event["kind"] == "focus_loss"
                for event in result["notableEvents"]
            ),
            1,
        )

    def test_explicit_focus_loss_without_timestamp_fails_closed(self) -> None:
        path = self.write_trace(
            [
                live_poll(),
                visible_badges_at(1, 500),
                tagged(
                    "offer-session",
                    {
                        "offerState": "OFFER_VISIBLE",
                        "render": False,
                        "foreground": False,
                        "offerGenerationAfter": 1,
                    },
                ),
                visible_badges_at(1, 6_000),
            ]
        )
        result = analyze(path, {"rendered", "focus_loss", "focus_recovery"})

        self.assertEqual(result["status"], "partial")
        self.assertTrue(result["coverage"]["focus_loss"])
        self.assertFalse(result["coverage"]["focus_recovery"])
        self.assertEqual(result["focusEvidence"]["observedLossDurationsMs"], [])

    def test_non_rendering_foreground_sample_is_not_focus_recovery(self) -> None:
        path = self.write_trace(
            [
                live_poll(),
                visible_badges_at(1, 500),
                focus_lost_at(1, 1_000),
                timestamped(
                    "offer-session",
                    {
                        "offerState": "NO_OFFER",
                        "render": False,
                        "foreground": True,
                        "offerGenerationAfter": 1,
                    },
                    6_000,
                ),
            ]
        )
        result = analyze(path, {"focus_loss", "focus_recovery"})

        self.assertEqual(result["status"], "partial")
        self.assertTrue(result["coverage"]["focus_loss"])
        self.assertFalse(result["coverage"]["focus_recovery"])
        self.assertEqual(result["focusEvidence"]["observedLossDurationsMs"], [])

    def test_new_game_epoch_clears_pending_explicit_focus_loss(self) -> None:
        path = self.write_trace(
            [
                tagged(
                    "game-poll",
                    {
                        "gameflowPhase": "inProgress",
                        "gameflowConfirmed": True,
                        "captureAllowed": True,
                    },
                ),
                visible_badges_at(1, 500),
                focus_lost_at(1, 1_000),
                tagged(
                    "game-poll",
                    {
                        "gameflowPhase": "endOfGame",
                        "gameflowConfirmed": True,
                        "captureAllowed": False,
                    },
                ),
                tagged(
                    "game-poll",
                    {
                        "gameflowPhase": "inProgress",
                        "gameflowConfirmed": True,
                        "captureAllowed": True,
                    },
                ),
                visible_badges_at(1, 6_000),
            ]
        )
        result = analyze(path, {"rendered", "focus_loss", "focus_recovery"})

        self.assertEqual(result["status"], "partial")
        # Game one's focus loss stays in game one. Game two is the evaluated
        # epoch and only rendered, so the later foreground frame cannot pair
        # with the earlier loss to manufacture a recovery — and the loss itself
        # is not borrowed forward.
        self.assertEqual(result["evaluatedGameEpoch"], 2)
        self.assertTrue(result["coverage"]["rendered"])
        self.assertFalse(result["coverage"]["focus_loss"])
        self.assertFalse(result["coverage"]["focus_recovery"])
        self.assertEqual(result["focusEvidence"]["observedLossDurationsMs"], [])
        self.assertEqual(
            [epoch["coverage"]["focus_loss"] for epoch in result["gameEpochs"]],
            [True, False],
        )

    # ─── The FINAL badge-layer gate is the only authority on visible badges ───

    def test_intermediate_offer_render_cannot_certify_visible_badges(self) -> None:
        # `[offer-session].render` is decided before authorization, preview
        # mode, the visible frame, and scheduler health are consulted. A live
        # epoch full of them still proves nothing reached the screen.
        path = self.write_trace(
            [
                live_poll(),
                tagged("offer-session", self.new_offer(4, 5)),
                tagged("offer-state", {"nextState": "OFFER_VISIBLE", "renderDecision": True}),
                tagged("slot-publication", {"slot": 0, "slotGeneration": 5}),
            ]
        )
        result = analyze(path, {"in_progress", "rendered", "new_offer"})

        self.assertEqual(result["status"], "partial")
        self.assertEqual(result["errors"], [])
        self.assertFalse(result["coverage"]["rendered"])
        self.assertTrue(result["coverage"]["new_offer"])
        # The intermediate evidence is retained as context, not as proof.
        self.assertEqual(result["counts"]["rendered-records"], 1)
        self.assertEqual(result["badgeLayer"]["visibleRecords"], 0)

    def test_unauthenticated_development_launch_cannot_certify_visible_badges(
        self,
    ) -> None:
        # A plain `npm run tauri dev` launch: no fixture flag, no member.
        path = self.write_trace(
            [
                live_poll(),
                tagged(
                    "badge-layer",
                    badge_layer_payload(
                        5,
                        badgeLayerVisible=False,
                        reason="authorization-denied",
                        authorized=False,
                        authorizationSource="none",
                        renderedBadgeCount=0,
                    ),
                ),
            ]
        )
        result = analyze(path, {"in_progress", "rendered"})

        self.assertEqual(result["status"], "partial")
        self.assertEqual(result["errors"], [])
        self.assertFalse(result["coverage"]["rendered"])
        self.assertEqual(
            result["badgeLayer"],
            {
                "visibleRecords": 0,
                "malformedRecords": 0,
                "rejectionReasons": {"authorization-denied": 1},
            },
        )

    def test_fixture_authorized_visible_badges_certify_rendered(self) -> None:
        path = self.write_trace([live_poll(), visible_badges(5)])
        result = analyze(path, {"in_progress", "rendered"})

        self.assertEqual(result["status"], "pass")
        self.assertEqual(result["errors"], [])
        self.assertTrue(result["coverage"]["rendered"])
        self.assertEqual(result["badgeLayer"]["visibleRecords"], 1)
        self.assertEqual(
            result["focusEvidence"]["visibleBadgeGenerations"], [5]
        )
        self.assertIn(
            "badge_layer", [event["kind"] for event in result["notableEvents"]]
        )

    def test_member_authorized_visible_badges_certify_rendered(self) -> None:
        path = self.write_trace(
            [live_poll(), visible_badges(5, authorizationSource="member")]
        )
        result = analyze(path, {"in_progress", "rendered"})

        self.assertEqual(result["status"], "pass")
        self.assertEqual(result["errors"], [])
        self.assertTrue(result["coverage"]["rendered"])
        self.assertEqual(result["badgeLayer"]["visibleRecords"], 1)

    def test_closed_final_gates_cannot_certify_visible_badges(self) -> None:
        closed = {
            "preview-mode": {"previewMode": True, "previewBadgeCount": 3},
            "visible-frame-rejected": {"visibleFrame": False},
            "offer-surface-rejected": {"offerSurface": False},
            "scheduler-unhealthy": {"schedulerHealthy": False},
            "no-visible-badges": {"renderedBadgeCount": 0},
        }
        for reason, override in closed.items():
            with self.subTest(reason=reason):
                path = self.write_trace(
                    [
                        live_poll(),
                        tagged(
                            "badge-layer",
                            badge_layer_payload(
                                5,
                                badgeLayerVisible=False,
                                reason=reason,
                                **override,
                            ),
                        ),
                    ]
                )
                result = analyze(path, {"in_progress", "rendered"})

                self.assertEqual(result["status"], "partial")
                self.assertEqual(result["errors"], [])
                self.assertFalse(result["coverage"]["rendered"])
                self.assertEqual(
                    result["badgeLayer"]["rejectionReasons"], {reason: 1}
                )

    def test_malformed_final_gate_records_cannot_certify_visible_badges(self) -> None:
        degraded = {
            "unauthorized": {"authorized": False},
            "no-authorization-source": {"authorizationSource": "none"},
            "unknown-authorization-source": {"authorizationSource": "dev"},
            "preview-contradiction": {"previewMode": True},
            "no-visible-frame": {"visibleFrame": False},
            "no-offer-surface": {"offerSurface": False},
            "unhealthy-scheduler": {"schedulerHealthy": False},
            "missing-generation": {"offerGeneration": None},
            "boolean-generation": {"offerGeneration": True},
            "rejected-generation": {"offerGeneration": -1},
            "no-painted-badge": {"renderedBadgeCount": 0},
            "reason-without-flag": {"badgeLayerVisible": False},
            "flag-without-reason": {"reason": "no-visible-badges"},
            "string-flag": {"badgeLayerVisible": "true"},
            "missing-scheduler-field": {"schedulerHealthy": None},
        }
        for label, override in degraded.items():
            with self.subTest(label=label):
                payload = badge_layer_payload(5, **override)
                if label == "missing-scheduler-field":
                    payload.pop("schedulerHealthy")
                path = self.write_trace([live_poll(), tagged("badge-layer", payload)])
                result = analyze(path, {"in_progress", "rendered"})

                self.assertEqual(result["status"], "fail")
                self.assertFalse(result["coverage"]["rendered"])
                self.assertEqual(result["badgeLayer"]["malformedRecords"], 1)
                self.assertEqual(result["badgeLayer"]["visibleRecords"], 0)
                self.assertTrue(
                    any(
                        "complete final-gate authority" in error
                        for error in result["errors"]
                    ),
                    result["errors"],
                )

    # ---- a visible badge layer needs a POSITIVE, non-boolean generation -----

    def test_generation_one_certifies_visible_badges(self) -> None:
        # The smallest real offer identity. Zero is the NO_OFFER source state,
        # so one is the first generation that can carry badges.
        path = self.write_trace([live_poll(), visible_badges(1)])
        result = analyze(path, {"in_progress", "rendered"})

        self.assertEqual(result["status"], "pass")
        self.assertEqual(result["errors"], [])
        self.assertTrue(result["coverage"]["rendered"])
        self.assertEqual(result["badgeLayer"]["visibleRecords"], 1)
        self.assertEqual(result["badgeLayer"]["malformedRecords"], 0)
        self.assertEqual(result["focusEvidence"]["visibleBadgeGenerations"], [1])

    def test_non_positive_or_non_integer_generations_never_certify_badges(self) -> None:
        # `bool` subclasses `int` and generation zero is the pre-offer state, so
        # neither a plain isinstance check nor a `>= 0` check is enough.
        malformed: dict[str, object] = {
            "zero": 0,
            "negative": -1,
            "true": True,
            "false": False,
            "string": "1",
            "float": 1.0,
            "null": None,
        }
        for label, generation in malformed.items():
            with self.subTest(label=label):
                path = self.write_trace(
                    [live_poll(), visible_badges(generation)]  # type: ignore[arg-type]
                )
                result = analyze(path, {"in_progress", "rendered"})

                self.assertEqual(result["status"], "fail")
                self.assertFalse(result["coverage"]["rendered"])
                self.assertEqual(result["badgeLayer"]["visibleRecords"], 0)
                self.assertEqual(result["badgeLayer"]["malformedRecords"], 1)
                self.assertEqual(
                    result["focusEvidence"]["visibleBadgeGenerations"], []
                )
                self.assertTrue(
                    any(
                        "strictly positive integer offer generation" in error
                        for error in result["errors"]
                    ),
                    result["errors"],
                )

    def test_a_missing_generation_field_never_certifies_badges(self) -> None:
        payload = badge_layer_payload(1)
        payload.pop("offerGeneration")
        path = self.write_trace([live_poll(), tagged("badge-layer", payload)])
        result = analyze(path, {"in_progress", "rendered"})

        self.assertEqual(result["status"], "fail")
        self.assertFalse(result["coverage"]["rendered"])
        self.assertEqual(result["badgeLayer"]["malformedRecords"], 1)
        self.assertEqual(result["focusEvidence"]["visibleBadgeGenerations"], [])

    def test_a_malformed_generation_cannot_seed_a_later_focus_recovery(self) -> None:
        # Generation zero claimed visible badges, focus left, and the offer came
        # back as a real generation. Nothing was ever certified visible, so the
        # loss never opened and the return recovers nothing.
        for label, generation in (("zero", 0), ("true", True)):
            with self.subTest(label=label):
                path = self.write_trace(
                    [
                        live_poll(),
                        timestamped(
                            "badge-layer", badge_layer_payload(generation), 500  # type: ignore[arg-type]
                        ),
                        focus_lost_at(1, 1_000),
                        visible_badges_at(1, 6_000),
                    ]
                )
                result = analyze(path, {"rendered", "focus_loss", "focus_recovery"})

                self.assertEqual(result["status"], "fail")
                self.assertFalse(result["coverage"]["focus_loss"])
                self.assertFalse(result["coverage"]["focus_recovery"])
                self.assertEqual(result["focusEvidence"]["observedLossDurationsMs"], [])
                self.assertEqual(
                    result["focusEvidence"]["visibleBadgeGenerations"], [1]
                )

    def test_badge_visibility_outside_the_live_epoch_cannot_certify(self) -> None:
        path = self.write_trace([visible_badges(5), live_poll()])
        result = analyze(path, {"in_progress", "rendered"})

        self.assertEqual(result["status"], "partial")
        self.assertEqual(result["errors"], [])
        self.assertFalse(result["coverage"]["rendered"])
        self.assertEqual(result["gameEpochs"][0]["visibleBadgeGenerations"], [])
        self.assertTrue(
            any("outside the evaluated" in warning for warning in result["warnings"])
        )

    def test_badge_visibility_after_confirmed_game_end_cannot_certify(self) -> None:
        path = self.write_trace(
            [live_poll(), tagged("game-poll", IDLE_GAME_POLL), visible_badges(5)]
        )
        result = analyze(path, {"in_progress", "rendered", "ended"})

        self.assertEqual(result["status"], "partial")
        self.assertEqual(result["errors"], [])
        self.assertTrue(result["coverage"]["ended"])
        self.assertFalse(result["coverage"]["rendered"])

    # ─── Focus evidence is bound to one visible offer generation ───

    def test_focus_loss_without_visible_badges_does_not_qualify(self) -> None:
        path = self.write_trace(
            [
                live_poll(),
                focus_lost_at(1, 1_000),
                visible_badges_at(1, 6_000),
            ]
        )
        result = analyze(path, {"rendered", "focus_loss", "focus_recovery"})

        self.assertEqual(result["status"], "partial")
        self.assertTrue(result["coverage"]["rendered"])
        self.assertFalse(result["coverage"]["focus_loss"])
        self.assertFalse(result["coverage"]["focus_recovery"])
        self.assertTrue(
            any(
                "no offer whose badges had been certified visible" in warning
                for warning in result["warnings"]
            ),
            result["warnings"],
        )

    def test_no_offer_surface_with_foreground_loss_does_not_qualify(self) -> None:
        # Combat, respawn, and the scoreboard all collapse the surface first;
        # losing focus afterwards loses no visible badges.
        for state in ("NO_OFFER", "OCCLUDED", "UNCERTAIN"):
            with self.subTest(state=state):
                path = self.write_trace(
                    [
                        live_poll(),
                        visible_badges_at(1, 500),
                        focus_lost_at(1, 1_000, offerState=state),
                        visible_badges_at(1, 6_000),
                    ]
                )
                result = analyze(path, {"focus_loss", "focus_recovery"})

                self.assertEqual(result["status"], "partial")
                self.assertFalse(result["coverage"]["focus_loss"])
                self.assertFalse(result["coverage"]["focus_recovery"])

    def test_intermediate_render_cannot_arm_a_focus_checkpoint(self) -> None:
        path = self.write_trace(
            [
                live_poll(),
                timestamped(
                    "offer-session",
                    self.rendered_offer(offerGenerationAfter=1),
                    500,
                ),
                focus_lost_at(1, 1_000),
                timestamped(
                    "offer-session",
                    self.rendered_offer(offerGenerationAfter=1),
                    6_000,
                ),
            ]
        )
        result = analyze(path, {"rendered", "focus_loss", "focus_recovery"})

        self.assertEqual(result["status"], "partial")
        self.assertFalse(result["coverage"]["rendered"])
        self.assertFalse(result["coverage"]["focus_loss"])
        self.assertFalse(result["coverage"]["focus_recovery"])

    def test_non_certifying_badge_records_cannot_arm_a_focus_checkpoint(self) -> None:
        hidden = {
            "authorization-denied": {
                "authorized": False,
                "authorizationSource": "none",
            },
            "preview-mode": {"previewMode": True},
            "scheduler-unhealthy": {"schedulerHealthy": False},
        }
        for reason, override in hidden.items():
            with self.subTest(reason=reason):
                rejected = tagged(
                    "badge-layer",
                    badge_layer_payload(
                        1, badgeLayerVisible=False, reason=reason, **override
                    ),
                )
                path = self.write_trace(
                    [live_poll(), rejected, focus_lost_at(1, 1_000), rejected]
                )
                result = analyze(path, {"focus_loss", "focus_recovery"})

                self.assertEqual(result["status"], "partial")
                self.assertFalse(result["coverage"]["focus_loss"])
                self.assertFalse(result["coverage"]["focus_recovery"])

    def test_same_generation_loss_and_recovery_qualifies(self) -> None:
        path = self.write_trace(
            [
                live_poll(),
                visible_badges_at(7, 500),
                focus_lost_at(7, 1_000),
                visible_badges_at(7, 6_000),
            ]
        )
        result = analyze(path, {"rendered", "focus_loss", "focus_recovery"})

        self.assertEqual(result["status"], "pass")
        self.assertEqual(result["errors"], [])
        self.assertEqual(result["focusEvidence"]["observedLossDurationsMs"], [5000.0])
        self.assertEqual(
            sum(event["kind"] == "focus_loss" for event in result["notableEvents"]),
            1,
        )
        self.assertEqual(
            sum(
                event["kind"] == "focus_recovery" for event in result["notableEvents"]
            ),
            1,
        )

    # ---- visible-offer authority must be CURRENT, not historical ------------

    def test_occlusion_then_native_focus_then_the_same_generation_fails(self) -> None:
        # The stale-authority attack: badges were visible, an in-game modal hid
        # them, focus moved while they were already gone, and the same offer
        # re-rendered afterwards. Neither checkpoint may be satisfied.
        path = self.write_trace(
            [
                live_poll(),
                visible_badges_at(9, 500),
                offer_state_at("OCCLUDED", 1_000),
                native_not_foreground_at(2_000),
                native_not_foreground_at(6_000),
                visible_badges_at(9, 7_000),
            ]
        )
        result = analyze(path, {"rendered", "focus_loss", "focus_recovery"})

        self.assertEqual(result["status"], "partial")
        self.assertTrue(result["coverage"]["rendered"])
        self.assertFalse(result["coverage"]["focus_loss"])
        self.assertFalse(result["coverage"]["focus_recovery"])
        self.assertEqual(result["focusEvidence"]["observedLossDurationsMs"], [])

    def test_no_offer_invalidates_visible_badge_authority(self) -> None:
        path = self.write_trace(
            [
                live_poll(),
                visible_badges_at(9, 500),
                offer_state_at("NO_OFFER", 1_000),
                native_not_foreground_at(2_000),
                native_not_foreground_at(6_000),
                visible_badges_at(9, 7_000),
            ]
        )
        result = analyze(path, {"rendered", "focus_loss", "focus_recovery"})

        self.assertFalse(result["coverage"]["focus_loss"])
        self.assertFalse(result["coverage"]["focus_recovery"])

    def test_an_invisible_final_gate_invalidates_visible_badge_authority(self) -> None:
        path = self.write_trace(
            [
                live_poll(),
                visible_badges_at(9, 500),
                # The gate stopped certifying: the visible frame was rejected.
                visible_badges_at(
                    9,
                    1_000,
                    badgeLayerVisible=False,
                    reason="visible-frame-rejected",
                    visibleFrame=False,
                ),
                native_not_foreground_at(2_000),
                native_not_foreground_at(6_000),
                visible_badges_at(9, 7_000),
            ]
        )
        result = analyze(path, {"rendered", "focus_loss", "focus_recovery"})

        self.assertEqual(result["errors"], [])
        self.assertFalse(result["coverage"]["focus_loss"])
        self.assertFalse(result["coverage"]["focus_recovery"])

    def test_authorization_denied_invalidates_visible_badge_authority(self) -> None:
        path = self.write_trace(
            [
                live_poll(),
                visible_badges_at(9, 500),
                visible_badges_at(
                    9,
                    1_000,
                    badgeLayerVisible=False,
                    reason="authorization-denied",
                    authorized=False,
                    authorizationSource="none",
                ),
                native_not_foreground_at(2_000),
                native_not_foreground_at(6_000),
                visible_badges_at(9, 7_000),
            ]
        )
        result = analyze(path, {"rendered", "focus_loss", "focus_recovery"})

        self.assertFalse(result["coverage"]["focus_loss"])
        self.assertFalse(result["coverage"]["focus_recovery"])
        self.assertEqual(
            result["badgeLayer"]["rejectionReasons"].get("authorization-denied"), 1
        )

    def test_zero_painted_badges_invalidate_visible_badge_authority(self) -> None:
        # The finding-1 case in trace form: the gate was open but nothing
        # received a DOM position, so nothing was on screen to lose.
        path = self.write_trace(
            [
                live_poll(),
                visible_badges_at(9, 500),
                visible_badges_at(
                    9,
                    1_000,
                    badgeLayerVisible=False,
                    reason="no-visible-badges",
                    renderedBadgeCount=0,
                ),
                native_not_foreground_at(2_000),
                native_not_foreground_at(6_000),
                visible_badges_at(9, 7_000),
            ]
        )
        result = analyze(path, {"rendered", "focus_loss", "focus_recovery"})

        self.assertFalse(result["coverage"]["focus_loss"])
        self.assertFalse(result["coverage"]["focus_recovery"])
        self.assertEqual(
            result["badgeLayer"]["rejectionReasons"].get("no-visible-badges"), 1
        )

    def test_every_rejection_reason_invalidates_visible_badge_authority(self) -> None:
        rejections: list[dict[str, object]] = [
            {"reason": "authorization-denied", "authorized": False,
             "authorizationSource": "none"},
            {"reason": "preview-mode", "previewMode": True},
            {"reason": "visible-frame-rejected", "visibleFrame": False},
            {"reason": "offer-surface-rejected", "offerSurface": False},
            {"reason": "scheduler-unhealthy", "schedulerHealthy": False},
            {"reason": "no-visible-badges", "renderedBadgeCount": 0},
        ]
        for rejection in rejections:
            with self.subTest(reason=rejection["reason"]):
                path = self.write_trace(
                    [
                        live_poll(),
                        visible_badges_at(3, 500),
                        visible_badges_at(
                            3, 1_000, badgeLayerVisible=False, **rejection
                        ),
                        native_not_foreground_at(2_000),
                        native_not_foreground_at(6_000),
                        visible_badges_at(3, 7_000),
                    ]
                )
                result = analyze(path, {"rendered", "focus_loss", "focus_recovery"})

                self.assertEqual(result["errors"], [])
                self.assertTrue(result["coverage"]["rendered"])
                self.assertFalse(result["coverage"]["focus_loss"])
                self.assertFalse(result["coverage"]["focus_recovery"])

    def test_native_focus_samples_while_occluded_never_open_a_loss(self) -> None:
        path = self.write_trace(
            [
                live_poll(),
                visible_badges_at(9, 500),
                offer_state_at("OCCLUDED", 1_000),
                native_not_foreground_at(2_000),
                native_not_foreground_at(6_000),
            ]
        )
        result = analyze(path, {"rendered", "focus_loss"})

        self.assertFalse(result["coverage"]["focus_loss"])
        self.assertTrue(
            any(
                "no offer whose badges were certified visible at the time" in warning
                for warning in result["warnings"]
            ),
            result["warnings"],
        )

    def test_explicit_foreground_loss_while_occluded_never_opens_a_loss(self) -> None:
        path = self.write_trace(
            [
                live_poll(),
                visible_badges_at(9, 500),
                offer_state_at("OCCLUDED", 1_000),
                # The offer-session still calls itself visible; the surface
                # already said otherwise, so the authority is gone.
                focus_lost_at(9, 2_000),
                visible_badges_at(9, 7_000),
            ]
        )
        result = analyze(path, {"rendered", "focus_loss", "focus_recovery"})

        self.assertFalse(result["coverage"]["focus_loss"])
        self.assertFalse(result["coverage"]["focus_recovery"])
        self.assertTrue(
            any(
                "no offer whose badges had been certified visible" in warning
                for warning in result["warnings"]
            ),
            result["warnings"],
        )

    def test_a_newly_visible_offer_establishes_fresh_focus_authority(self) -> None:
        # Authority is re-established by a later render, and a focus test that
        # begins AFTER it is legitimate.
        path = self.write_trace(
            [
                live_poll(),
                visible_badges_at(9, 500),
                offer_state_at("OCCLUDED", 1_000),
                native_not_foreground_at(1_500),
                offer_state_at("OFFER_VISIBLE", 2_000),
                visible_badges_at(9, 2_500),
                native_not_foreground_at(3_000),
                native_not_foreground_at(6_500),
                visible_badges_at(9, 7_000),
            ]
        )
        result = analyze(path, {"rendered", "focus_loss", "focus_recovery"})

        self.assertEqual(result["status"], "pass")
        self.assertEqual(result["errors"], [])
        self.assertTrue(result["coverage"]["focus_loss"])
        self.assertTrue(result["coverage"]["focus_recovery"])
        # The dwell is measured from the streak that began after re-render,
        # never from the sample collected while the offer was occluded.
        self.assertEqual(result["focusEvidence"]["observedLossDurationsMs"], [4000.0])

    def test_a_hidden_interval_never_extends_a_later_legitimate_loss(self) -> None:
        # A badge-layer record reporting invisibility is the EXPECTED
        # consequence of losing focus, so it must not retire a streak that
        # already began while the badges were up.
        path = self.write_trace(
            [
                live_poll(),
                visible_badges_at(4, 500),
                native_not_foreground_at(1_000),
                visible_badges_at(
                    4,
                    1_200,
                    badgeLayerVisible=False,
                    reason="visible-frame-rejected",
                    visibleFrame=False,
                ),
                native_not_foreground_at(4_500),
                visible_badges_at(4, 5_000),
            ]
        )
        result = analyze(path, {"rendered", "focus_loss", "focus_recovery"})

        self.assertEqual(result["status"], "pass")
        self.assertTrue(result["coverage"]["focus_loss"])
        self.assertTrue(result["coverage"]["focus_recovery"])
        self.assertEqual(result["focusEvidence"]["observedLossDurationsMs"], [4000.0])

    def test_a_new_generation_does_not_recover_the_previous_offer(self) -> None:
        path = self.write_trace(
            [
                live_poll(),
                visible_badges_at(7, 500),
                focus_lost_at(7, 1_000),
                visible_badges_at(8, 6_000),
            ]
        )
        result = analyze(path, {"rendered", "focus_loss", "focus_recovery"})

        self.assertEqual(result["status"], "partial")
        self.assertTrue(result["coverage"]["rendered"])
        self.assertTrue(result["coverage"]["focus_loss"])
        self.assertFalse(result["coverage"]["focus_recovery"])
        self.assertEqual(result["focusEvidence"]["observedLossDurationsMs"], [])
        self.assertTrue(
            any(
                "never recovers the previous one" in warning
                for warning in result["warnings"]
            ),
            result["warnings"],
        )

    def test_focus_evidence_cannot_cross_a_confirmed_game_end(self) -> None:
        path = self.write_trace(
            [
                live_poll(),
                visible_badges_at(1, 500),
                focus_lost_at(1, 1_000),
                tagged("game-poll", IDLE_GAME_POLL),
                visible_badges_at(1, 6_000),
            ]
        )
        result = analyze(path, {"focus_loss", "focus_recovery", "ended"})

        self.assertEqual(result["status"], "partial")
        self.assertTrue(result["coverage"]["ended"])
        self.assertTrue(result["coverage"]["focus_loss"])
        self.assertFalse(result["coverage"]["focus_recovery"])
        self.assertEqual(result["focusEvidence"]["observedLossDurationsMs"], [])

    def test_pre_game_visible_badges_cannot_arm_a_live_focus_checkpoint(self) -> None:
        path = self.write_trace(
            [
                visible_badges_at(1, 200),
                live_poll(),
                focus_lost_at(1, 1_000),
                visible_badges_at(1, 6_000),
            ]
        )
        result = analyze(path, {"focus_loss", "focus_recovery"})

        self.assertEqual(result["status"], "partial")
        self.assertFalse(result["coverage"]["focus_loss"])
        self.assertFalse(result["coverage"]["focus_recovery"])

    def test_native_evidence_without_prior_visible_badges_does_not_qualify(
        self,
    ) -> None:
        native = {
            "stale": True,
            "timeoutClassification": "actual-game-window-not-foreground",
        }
        path = self.write_trace(
            [
                live_poll(),
                timestamped("geometry-timing", native, 1_000),
                timestamped("geometry-timing", native, 4_500),
                visible_badges_at(1, 5_000),
            ]
        )
        result = analyze(path, {"rendered", "focus_loss", "focus_recovery"})

        self.assertEqual(result["status"], "partial")
        self.assertTrue(result["coverage"]["rendered"])
        self.assertFalse(result["coverage"]["focus_loss"])
        self.assertFalse(result["coverage"]["focus_recovery"])
        self.assertTrue(
            any(
                "no offer whose badges were certified visible at the time" in warning
                for warning in result["warnings"]
            ),
            result["warnings"],
        )

    def test_mixed_repeated_loss_samples_keep_the_earliest_timestamp(self) -> None:
        native = {
            "stale": True,
            "timeoutClassification": "actual-game-window-not-foreground",
        }
        path = self.write_trace(
            [
                live_poll(),
                visible_badges_at(3, 500),
                timestamped("geometry-timing", native, 1_000),
                timestamped("geometry-timing", native, 4_500),
                focus_lost_at(3, 5_000),
                visible_badges_at(3, 6_000),
            ]
        )
        result = analyze(path, {"rendered", "focus_loss", "focus_recovery"})

        self.assertEqual(result["status"], "pass")
        # The native streak opened the loss at 1000 ms; the later explicit
        # sample is the same logical loss and never shortens it.
        self.assertEqual(result["focusEvidence"]["observedLossDurationsMs"], [5000.0])
        self.assertEqual(
            sum(event["kind"] == "focus_loss" for event in result["notableEvents"]),
            1,
        )

    def test_missing_required_coverage_is_partial_and_cli_exits_nonzero(self) -> None:
        path = self.write_trace(
            [tagged("game-poll", {"gameflowPhase": "none", "captureAllowed": False})]
        )
        result = analyze(path, {"rendered"})
        self.assertEqual(result["status"], "partial")
        script = Path(__file__).with_name("analyze_trace.py")
        completed = subprocess.run(
            ["/usr/bin/python3", str(script), str(path), "--require", "rendered"],
            stdout=subprocess.PIPE,
            stderr=subprocess.STDOUT,
            text=True,
            check=False,
        )
        self.assertEqual(completed.returncode, 1)

    def test_empty_requirements_cannot_pass(self) -> None:
        path = self.write_trace(
            [tagged("game-poll", {"gameflowPhase": "none", "captureAllowed": False})]
        )
        result = analyze(path, set())
        self.assertEqual(result["status"], "fail")

    def test_unknown_requirement_has_no_spurious_missing_warning(self) -> None:
        path = self.write_trace(
            [tagged("game-poll", {"gameflowPhase": "none", "captureAllowed": False})]
        )
        result = analyze(path, {"bogus_thing"})
        self.assertEqual(result["status"], "fail")
        self.assertTrue(any("Unknown coverage" in error for error in result["errors"]))
        self.assertFalse(any("not observed" in warning for warning in result["warnings"]))

    def test_render_noise_does_not_starve_later_new_offer_event(self) -> None:
        lines = [live_poll()] + [
            tagged(
                "offer-session",
                {
                    "offerState": "OFFER_VISIBLE",
                    "render": True,
                    "foreground": True,
                    "zeroRenderReason": "rendered",
                    "offerGenerationAfter": 4,
                    "newOfferDetected": False,
                },
            )
            for _ in range(600)
        ]
        lines.append(
            tagged(
                "offer-session",
                {
                    "offerState": "OFFER_VISIBLE",
                    "render": True,
                    "foreground": True,
                    "zeroRenderReason": "rendered",
                    "newOfferDetected": True,
                    "offerGenerationBefore": 4,
                    "offerGenerationAfter": 5,
                    "invalidatedSlots": [0],
                },
            )
        )
        result = analyze(self.write_trace(lines), {"new_offer"})
        kinds = [event["kind"] for event in result["notableEvents"]]
        self.assertIn("new_offer", kinds)

    def test_generation_regression_fails_but_new_game_resets_scope(self) -> None:
        base = {"offerState": "OFFER_VISIBLE", "render": False, "foreground": True}
        live = {
            "gameflowPhase": "inProgress",
            "gameflowConfirmed": True,
            "captureAllowed": True,
        }
        idle = {
            "gameflowPhase": "none",
            "gameflowConfirmed": True,
            "captureAllowed": False,
        }
        failing = self.write_trace(
            [
                tagged("game-poll", live),
                tagged("offer-session", {**base, "offerGenerationAfter": 6}),
                tagged("offer-session", {**base, "offerGenerationAfter": 3}),
            ]
        )
        self.assertEqual(analyze(failing, {"in_progress"})["status"], "fail")
        reset = self.write_trace(
            [
                tagged("game-poll", live),
                tagged("offer-session", {**base, "offerGenerationAfter": 6}),
                tagged("game-poll", idle),
                tagged("game-poll", live),
                tagged("offer-session", {**base, "offerGenerationAfter": 3}),
            ]
        )
        self.assertEqual(analyze(reset, {"in_progress"})["status"], "pass")

    # ---- new-offer advancement rejects booleans and non-integers ------------

    def test_valid_generation_pairs_advance_a_new_offer(self) -> None:
        # Zero is permitted only as the pre-offer source state, so `0 -> 1` is a
        # real first offer and `1 -> 2` is a real reroll.
        for before, after in ((0, 1), (1, 2)):
            with self.subTest(pair=(before, after)):
                path = self.write_trace(
                    [live_poll(), tagged("offer-session", self.new_offer(before, after))]
                )
                result = analyze(path, {"in_progress", "new_offer"})

                self.assertEqual(result["status"], "pass")
                self.assertEqual(result["errors"], [])
                self.assertTrue(result["coverage"]["new_offer"])
                self.assertEqual(
                    result["newOfferGenerations"],
                    [{"gameEpoch": 1, "generation": after}],
                )

    def test_malformed_generation_pairs_never_advance_a_new_offer(self) -> None:
        # `isinstance(False, int)` is True, so `false -> true` would otherwise
        # read as `0 -> 1` and certify a new offer from a record that carries no
        # generation at all.
        pairs: dict[str, tuple[object, object]] = {
            "false-to-true": (False, True),
            "true-to-int": (True, 2),
            "int-to-true": (1, True),
            "string-before": ("1", 2),
            "float-before": (1.0, 2),
            "null-before": (None, 2),
            "null-after": (1, None),
            "negative-before": (-1, 1),
            "zero-after": (1, 0),
            "equal": (2, 2),
            "decreasing": (3, 2),
        }
        for label, (before, after) in pairs.items():
            with self.subTest(label=label):
                path = self.write_trace(
                    [
                        live_poll(),
                        tagged(
                            "offer-session",
                            self.new_offer(before, after),  # type: ignore[arg-type]
                        ),
                    ]
                )
                result = analyze(path, {"in_progress", "new_offer"})

                self.assertEqual(result["status"], "fail")
                self.assertFalse(result["coverage"]["new_offer"])
                self.assertEqual(result["newOfferGenerations"], [])
                self.assertEqual(result["gameEpochs"][0]["newOfferGenerations"], [])
                self.assertTrue(
                    any(
                        "did not advance its generation" in error
                        for error in result["errors"]
                    ),
                    result["errors"],
                )

    def test_missing_generation_fields_never_advance_a_new_offer(self) -> None:
        for label, payload in (
            ("no-before", {"offerGenerationAfter": 2}),
            ("no-after", {"offerGenerationBefore": 1}),
            ("neither", {}),
        ):
            with self.subTest(label=label):
                record = self.rendered_offer(
                    newOfferDetected=True, invalidatedSlots=[0, 1, 2], **payload
                )
                path = self.write_trace(
                    [live_poll(), tagged("offer-session", record)]
                )
                result = analyze(path, {"in_progress", "new_offer"})

                self.assertEqual(result["status"], "fail")
                self.assertFalse(result["coverage"]["new_offer"])
                self.assertEqual(result["newOfferGenerations"], [])

    def test_a_malformed_pair_never_becomes_offer_identity_or_focus_evidence(
        self,
    ) -> None:
        # A `false -> true` record between a real render and a real focus loss
        # must change neither the certified visible generation nor the focus
        # correlation that generation owns.
        path = self.write_trace(
            [
                live_poll(),
                visible_badges_at(4, 500),
                timestamped("offer-session", self.new_offer(False, True), 700),  # type: ignore[arg-type]
                focus_lost_at(4, 1_000),
                visible_badges_at(4, 6_000),
            ]
        )
        result = analyze(path, {"rendered", "focus_loss", "focus_recovery"})

        self.assertEqual(result["status"], "fail")
        self.assertEqual(result["newOfferGenerations"], [])
        self.assertEqual(result["focusEvidence"]["visibleBadgeGenerations"], [4])
        self.assertTrue(result["coverage"]["focus_loss"])
        self.assertTrue(result["coverage"]["focus_recovery"])

    def test_timestamped_wrapper_is_parsed(self) -> None:
        inner = tagged(
            "offer-state",
            {"nextState": "OCCLUDED", "renderDecision": False},
        ).rstrip()
        outer = json.dumps(
            {"observedAt": "2026-07-28T00:00:00Z", "elapsedMs": 1250, "line": inner}
        )
        tag, payload, metadata = parse_record(outer)
        self.assertEqual(tag, "offer-state")
        self.assertEqual(payload["nextState"], "OCCLUDED")
        self.assertEqual(metadata["elapsedMs"], 1250)

    def test_trace_reopen_marker_is_visible_in_verdict(self) -> None:
        path = self.write_trace(
            [
                json.dumps(
                    {
                        "observedAt": "2026-07-28T00:00:00Z",
                        "elapsedMs": 500,
                        "event": "trace-reopened",
                    }
                )
                + "\n",
                tagged(
                    "game-poll",
                    {
                        "gameflowPhase": "inProgress",
                        "gameflowConfirmed": True,
                        "captureAllowed": True,
                    },
                ),
            ]
        )
        result = analyze(path, {"in_progress"})
        self.assertEqual(result["status"], "pass")
        self.assertEqual(result["counts"]["observer-event"], 1)
        self.assertTrue(any("reopened" in warning for warning in result["warnings"]))
        self.assertIn(
            "trace_reopened",
            [event["kind"] for event in result["notableEvents"]],
        )

    # -- [focus-transition]: deterministic foreground-loss before OCR stops --
    #
    # The documented alt-tab flow stops OCR and halts the geometry scheduler
    # immediately on foreground loss, so a real trace may carry no later
    # `[offer-session]` foreground:false record and no qualifying native
    # not-foreground span. The `[focus-transition]` diagnostic is the runtime's
    # deterministic, edge-triggered record of that exact instant, emitted
    # before badge visibility is cleared, so it must be able to establish
    # focus loss on its own.

    def test_focus_transition_opens_focus_loss_for_visible_generation(self) -> None:
        path = self.write_trace(
            [
                live_poll(),
                visible_badges_at(1, 500),
                focus_transition_at(1, 1_000),
                visible_badges_at(1, 5_000),
            ]
        )
        result = analyze(path, {"rendered", "focus_loss", "focus_recovery"})
        self.assertEqual(result["status"], "pass")
        self.assertTrue(result["coverage"]["focus_loss"])
        self.assertTrue(result["coverage"]["focus_recovery"])
        self.assertEqual(result["focusEvidence"]["observedLossDurationsMs"], [4000.0])

    def test_focus_transition_loss_survives_a_following_generic_rejection(
        self,
    ) -> None:
        # The runtime stops OCR right after emitting the transition, so the
        # very next badge-layer record is typically a rejection. The loss
        # must already be recorded by the transition itself, not by whatever
        # rejection reason happens to follow it.
        path = self.write_trace(
            [
                live_poll(),
                visible_badges_at(1, 500),
                focus_transition_at(1, 1_000),
                tagged(
                    "badge-layer",
                    badge_layer_payload(
                        1,
                        badgeLayerVisible=False,
                        reason="visible-frame-rejected",
                        visibleFrame=False,
                    ),
                ),
            ]
        )
        result = analyze(path, {"focus_loss"})
        self.assertTrue(result["coverage"]["focus_loss"])

    def test_short_focus_transition_dwell_cannot_satisfy_recovery(self) -> None:
        path = self.write_trace(
            [
                live_poll(),
                visible_badges_at(1, 500),
                focus_transition_at(1, 1_000),
                visible_badges_at(1, 1_200),
            ]
        )
        result = analyze(path, {"focus_loss", "focus_recovery"})
        self.assertEqual(result["status"], "partial")
        self.assertTrue(result["coverage"]["focus_loss"])
        self.assertFalse(result["coverage"]["focus_recovery"])
        self.assertEqual(result["focusEvidence"]["observedLossDurationsMs"], [200.0])

    def test_focus_transition_without_prior_visible_generation_does_not_open_loss(
        self,
    ) -> None:
        path = self.write_trace(
            [
                live_poll(),
                focus_transition_at(1, 1_000),
                visible_badges_at(1, 5_000),
            ]
        )
        result = analyze(path, {"rendered"})
        self.assertFalse(result["coverage"]["focus_loss"])
        self.assertTrue(
            any(
                "no offer whose badges had been certified visible" in warning
                for warning in result["warnings"]
            )
        )

    def test_focus_transition_with_zero_generation_is_rejected(self) -> None:
        path = self.write_trace(
            [
                live_poll(),
                visible_badges_at(1, 500),
                focus_transition_at(0, 1_000),
                visible_badges_at(1, 5_000),
            ]
        )
        result = analyze(path, {"rendered"})
        self.assertFalse(result["coverage"]["focus_loss"])
        self.assertTrue(
            any("malformed or non-positive" in error for error in result["errors"])
        )

    def test_focus_transition_with_boolean_generation_is_rejected(self) -> None:
        path = self.write_trace(
            [
                live_poll(),
                visible_badges_at(1, 500),
                focus_transition_at(True, 1_000),
                visible_badges_at(1, 5_000),
            ]
        )
        result = analyze(path, {"rendered"})
        self.assertFalse(result["coverage"]["focus_loss"])
        self.assertTrue(
            any("malformed or non-positive" in error for error in result["errors"])
        )

    def test_focus_transition_with_string_generation_is_rejected(self) -> None:
        path = self.write_trace(
            [
                live_poll(),
                visible_badges_at(1, 500),
                focus_transition_at("1", 1_000),
                visible_badges_at(1, 5_000),
            ]
        )
        result = analyze(path, {"rendered"})
        self.assertFalse(result["coverage"]["focus_loss"])
        self.assertTrue(
            any("malformed or non-positive" in error for error in result["errors"])
        )

    def test_focus_transition_with_missing_generation_is_rejected(self) -> None:
        path = self.write_trace(
            [
                live_poll(),
                visible_badges_at(1, 500),
                focus_transition_at(None, 1_000),
                visible_badges_at(1, 5_000),
            ]
        )
        result = analyze(path, {"rendered"})
        self.assertFalse(result["coverage"]["focus_loss"])
        self.assertTrue(
            any("malformed or non-positive" in error for error in result["errors"])
        )

    def test_occlusion_does_not_establish_focus_loss(self) -> None:
        path = self.write_trace(
            [
                live_poll(),
                visible_badges_at(1, 500),
                tagged(
                    "offer-state",
                    {"nextState": "OCCLUDED", "renderDecision": False},
                ),
                visible_badges_at(1, 5_000),
            ]
        )
        result = analyze(path, {"rendered", "occlusion"})
        self.assertTrue(result["coverage"]["occlusion"])
        self.assertFalse(result["coverage"]["focus_loss"])

    def test_generic_badge_rejection_does_not_establish_focus_loss(self) -> None:
        path = self.write_trace(
            [
                live_poll(),
                visible_badges_at(1, 500),
                tagged(
                    "badge-layer",
                    badge_layer_payload(
                        1,
                        badgeLayerVisible=False,
                        reason="scheduler-unhealthy",
                        schedulerHealthy=False,
                    ),
                ),
                visible_badges_at(1, 5_000),
            ]
        )
        result = analyze(path, {"rendered", "focus_loss"})
        self.assertFalse(result["coverage"]["focus_loss"])

    def test_focus_transition_loss_does_not_recover_on_a_different_generation(
        self,
    ) -> None:
        path = self.write_trace(
            [
                live_poll(),
                visible_badges_at(1, 500),
                focus_transition_at(1, 1_000),
                tagged(
                    "offer-session",
                    {
                        "offerState": "OFFER_VISIBLE",
                        "render": True,
                        "foreground": True,
                        "zeroRenderReason": "rendered",
                        "newOfferDetected": True,
                        "offerGenerationBefore": 1,
                        "offerGenerationAfter": 2,
                        "invalidatedSlots": [0],
                    },
                ),
                visible_badges_at(2, 5_000),
            ]
        )
        result = analyze(path, {"focus_loss", "focus_recovery"})
        self.assertTrue(result["coverage"]["focus_loss"])
        self.assertFalse(result["coverage"]["focus_recovery"])
        self.assertTrue(
            any(
                "never recovers the previous one" in warning
                for warning in result["warnings"]
            )
        )

    def test_epoch_change_prevents_focus_transition_recovery(self) -> None:
        path = self.write_trace(
            [
                live_poll(),
                visible_badges_at(1, 500),
                focus_transition_at(1, 1_000),
                tagged(
                    "game-poll",
                    {
                        "gameflowPhase": "none",
                        "gameflowConfirmed": True,
                        "captureAllowed": False,
                    },
                ),
                live_poll(),
                visible_badges_at(1, 6_000),
            ]
        )
        result = analyze(path, {"focus_loss", "focus_recovery"})
        self.assertTrue(result["gameEpochs"][0]["coverage"]["focus_loss"])
        self.assertFalse(result["gameEpochs"][0]["coverage"]["focus_recovery"])
        self.assertFalse(result["coverage"]["focus_recovery"])

    def test_repeated_focus_transition_preserves_earliest_timestamp(self) -> None:
        # This diagnostic is edge-triggered by construction (it fires once,
        # at the synchronous foreground true->false transition), so a repeat
        # can only be defensive noise. It must not extend or shorten the
        # dwell recorded by the first occurrence.
        lines = [live_poll(), visible_badges_at(1, 500), focus_transition_at(1, 1_000)]
        lines += [
            focus_transition_at(1, elapsed_ms) for elapsed_ms in (2_000, 3_000, 4_000)
        ]
        lines.append(visible_badges_at(1, 6_000))
        result = analyze(
            self.write_trace(lines), {"rendered", "focus_loss", "focus_recovery"}
        )
        self.assertEqual(result["status"], "pass")
        self.assertEqual(result["focusEvidence"]["observedLossDurationsMs"], [5000.0])
        self.assertEqual(
            sum(event["kind"] == "focus_loss" for event in result["notableEvents"]),
            1,
        )

    def test_no_visibility_credited_from_rejections_during_lost_focus_window(
        self,
    ) -> None:
        path = self.write_trace(
            [
                live_poll(),
                visible_badges_at(1, 500),
                focus_transition_at(1, 1_000),
                timestamped(
                    "badge-layer",
                    badge_layer_payload(
                        1,
                        badgeLayerVisible=False,
                        reason="scheduler-unhealthy",
                        schedulerHealthy=False,
                    ),
                    2_000,
                ),
                timestamped(
                    "badge-layer",
                    badge_layer_payload(
                        1,
                        badgeLayerVisible=False,
                        reason="visible-frame-rejected",
                        visibleFrame=False,
                    ),
                    3_000,
                ),
            ]
        )
        result = analyze(path, {"focus_loss", "focus_recovery"})
        self.assertTrue(result["coverage"]["focus_loss"])
        self.assertFalse(result["coverage"]["focus_recovery"])
        # The one certified frame at ts=500 is the only visible record; the
        # two rejections observed while unfocused credit nothing.
        self.assertEqual(result["badgeLayer"]["visibleRecords"], 1)

    def test_synthetic_alt_tab_trace_satisfies_focus_loss_and_recovery(self) -> None:
        """Exact documented runtime order for a five-second alt-tab.

        live-active -> valid visible badge generation N -> foreground
        transition for N -> no scheduler records for five seconds ->
        foreground restored -> valid visible badge generation N. No later
        `[offer-session]` foreground:false record and no native geometry span
        are available in this flow, so `[focus-transition]` must be the sole
        evidence establishing the loss, and recovery must bind to the same
        generation N after the 3000ms dwell.
        """
        path = self.write_trace(
            [
                tagged(
                    "game-poll",
                    {
                        "gameflowPhase": "inProgress",
                        "gameflowConfirmed": True,
                        "captureAllowed": True,
                        "liveDataStatus": "ready",
                        "action": "live-active",
                        "failureAgeMs": 0,
                    },
                ),
                visible_badges_at(7, 500),
                focus_transition_at(7, 1_000),
                visible_badges_at(7, 6_000),
            ]
        )
        result = analyze(path, {"rendered", "focus_loss", "focus_recovery"})
        self.assertEqual(result["status"], "pass")
        self.assertTrue(result["coverage"]["rendered"])
        self.assertTrue(result["coverage"]["focus_loss"])
        self.assertTrue(result["coverage"]["focus_recovery"])
        self.assertEqual(result["focusEvidence"]["observedLossDurationsMs"], [5000.0])
        loss_events = [
            event for event in result["notableEvents"] if event["kind"] == "focus_loss"
        ]
        recovery_events = [
            event
            for event in result["notableEvents"]
            if event["kind"] == "focus_recovery"
        ]
        self.assertEqual(len(loss_events), 1)
        self.assertEqual(len(recovery_events), 1)


class AnalyzerProvenanceTest(unittest.TestCase):
    """The analyzer inherits artifact identity; it never mints it."""

    def setUp(self) -> None:
        self.directory = Path(tempfile.mkdtemp())
        self.addCleanup(lambda: shutil.rmtree(self.directory))
        self.trace = self.directory / "trace.timestamped.jsonl"
        self.trace.write_text(tagged("game-poll", LIVE_GAME_POLL), encoding="utf-8")
        self.video = self.directory / "screen.mp4"
        self.video.write_bytes(b"not really a container, but it hashes")
        self.manifest = self.directory / "manifest.json"
        self.write_manifest()

    def identity(self, path: Path) -> dict[str, object]:
        return {
            "path": str(path),
            "sha256": sha256_file(path),
            "bytes": path.stat().st_size,
        }

    def write_manifest(self, **overrides: object) -> None:
        manifest = {
            "status": "complete",
            "videoEnabled": True,
            "artifacts": {
                "schema": ARTIFACT_SCHEMA,
                "video": self.identity(self.video),
                "trace": self.identity(self.trace),
                "traceRecordCount": 1,
                "captureStopElapsedMs": 1_000,
                "finalizationCompletedElapsedMs": 1_200,
            },
        }
        manifest.update(overrides)
        self.manifest.write_text(json.dumps(manifest, indent=2), encoding="utf-8")

    def test_analysis_carries_its_own_source_identity_without_a_manifest(self) -> None:
        result = analyze(self.trace, {"in_progress"})

        self.assertEqual(result["schema"], ANALYSIS_SCHEMA)
        self.assertEqual(result["sourceSha256"], sha256_file(self.trace))
        self.assertEqual(result["sourceBytes"], self.trace.stat().st_size)
        # No manifest supplied: no inherited identity is invented for one.
        self.assertIsNone(result["manifestPath"])
        self.assertIsNone(result["manifestSha256"])
        self.assertIsNone(result["videoIdentity"])
        self.assertEqual(result["status"], "pass")

    def test_matching_manifest_is_inherited_verbatim(self) -> None:
        result = analyze(self.trace, {"in_progress"}, self.manifest)
        manifest = json.loads(self.manifest.read_text(encoding="utf-8"))

        self.assertEqual(result["status"], "pass")
        self.assertEqual(result["manifestPath"], str(self.manifest))
        self.assertEqual(result["manifestSha256"], sha256_file(self.manifest))
        self.assertEqual(result["videoIdentity"], manifest["artifacts"]["video"])

    def test_trace_that_the_recorder_never_hashed_fails_closed(self) -> None:
        self.trace.write_text(
            tagged("game-poll", LIVE_GAME_POLL) + tagged("game-poll", IDLE_GAME_POLL),
            encoding="utf-8",
        )

        result = analyze(self.trace, {"in_progress"}, self.manifest)

        self.assertEqual(result["status"], "fail")
        self.assertTrue(
            any(
                "does not match the recorder manifest" in error
                for error in result["errors"]
            ),
            result["errors"],
        )
        # The mismatch is reported, not papered over with the current hash.
        self.assertEqual(result["sourceSha256"], sha256_file(self.trace))

    def test_manifest_without_artifact_identity_fails_closed(self) -> None:
        self.manifest.write_text(
            json.dumps({"status": "complete", "videoEnabled": True}),
            encoding="utf-8",
        )

        result = analyze(self.trace, {"in_progress"}, self.manifest)

        self.assertEqual(result["status"], "fail")
        self.assertTrue(
            any("no artifacts block" in error for error in result["errors"]),
            result["errors"],
        )
        self.assertIsNone(result["videoIdentity"])

    def test_incomplete_recording_may_not_root_identity(self) -> None:
        self.write_manifest(status="recording")

        result = analyze(self.trace, {"in_progress"}, self.manifest)

        self.assertEqual(result["status"], "fail")
        self.assertTrue(
            any("only a completed session" in error for error in result["errors"]),
            result["errors"],
        )

    def test_recording_failed_repository_drift_manifest_may_not_root_identity(
        self,
    ) -> None:
        # A repository-drift failure never reaches "complete" (record_session.py
        # holds it at "recording-failed" precisely so this generic gate — not
        # any drift-specific analyzer logic — is what refuses it.
        self.write_manifest(
            status="recording-failed",
            failureReason="repository-drift",
            repositoryFingerprintSchema=1,
            repositoryFingerprintStart="a" * 64,
            repositoryFingerprintFinal="b" * 64,
            repositoryStable=False,
        )

        result = analyze(self.trace, {"in_progress"}, self.manifest)

        self.assertEqual(result["status"], "fail")
        self.assertTrue(
            any("only a completed session" in error for error in result["errors"]),
            result["errors"],
        )

    def test_recording_failed_checkpoint_unreadable_manifest_may_not_root_identity(
        self,
    ) -> None:
        # A checkpoint-unreadable failure never reaches "complete"
        # (record_session.py holds it at "recording-failed" precisely so this
        # generic gate — not any checkpoint-specific analyzer logic — is what
        # refuses it.
        self.write_manifest(
            status="recording-failed",
            failureReason="trace-checkpoint-unreadable",
            traceContinuityVerified=False,
        )

        result = analyze(self.trace, {"in_progress"}, self.manifest)

        self.assertEqual(result["status"], "fail")
        self.assertTrue(
            any("only a completed session" in error for error in result["errors"]),
            result["errors"],
        )

    def test_missing_video_identity_for_a_video_session_fails_closed(self) -> None:
        manifest = json.loads(self.manifest.read_text(encoding="utf-8"))
        manifest["artifacts"]["video"] = None
        self.manifest.write_text(json.dumps(manifest, indent=2), encoding="utf-8")

        result = analyze(self.trace, {"in_progress"}, self.manifest)

        self.assertEqual(result["status"], "fail")
        self.assertTrue(
            any("records no video identity" in error for error in result["errors"]),
            result["errors"],
        )


if __name__ == "__main__":
    unittest.main()
