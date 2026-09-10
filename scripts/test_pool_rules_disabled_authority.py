#!/usr/bin/env python3
"""`pool-rules.disabled` must be DERIVED from the availability resolver.

Regression: the list used to be seeded from its own previous output and then
unioned with the resolver, so it was monotonic — an augment could enter but
never leave. Riot re-enabled Clown College in 26.18 and the resolver moved it to
`confirmed_live`, but the carried-forward list still called it disabled. Two
authorities for one current-state fact.
"""

from __future__ import annotations

import json
import subprocess
import sys
import tempfile
import unittest
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
SCRIPTS = ROOT / "scripts"


def augment(slug: str, status: str) -> dict:
    return {
        "slug": slug,
        "name": slug.replace("-", " ").title(),
        "rarity": "gold",
        "availability": {"status": status},
        "flags": {"lifecycle": "active" if status == "confirmed_live" else "removed"},
    }


class PoolRulesDisabledAuthorityTests(unittest.TestCase):
    def _run(self, augments: list[dict], stale_disabled: list[str]) -> dict:
        with tempfile.TemporaryDirectory() as tmp:
            data_dir = Path(tmp)
            for name in ("items.json", "abilities.json", "champions.json"):
                (data_dir / name).write_text(json.dumps({name.split(".")[0]: []}))
            (data_dir / "items.json").write_text(json.dumps({"items": []}))
            (data_dir / "augments.json").write_text(json.dumps({"augments": augments}))
            (data_dir / "patch-events.json").write_text(
                json.dumps({"current_open_cycle": "26.18", "observed_at": "", "events": []})
            )
            (data_dir / "patch-metadata.json").write_text(json.dumps({"patch": "26.18", "patches": []}))
            # Seed a STALE disabled list, exactly the failure mode.
            (data_dir / "pool-rules.json").write_text(json.dumps({"disabled": stale_disabled}))

            result = subprocess.run(
                [sys.executable, str(SCRIPTS / "generate_pool_rules.py")],
                cwd=str(ROOT),
                env={"MAYHEM_DATA_DIR": str(data_dir), "PATH": "/usr/bin:/bin"},
                capture_output=True,
                text=True,
            )
            if result.returncode != 0:
                self.fail(f"generate_pool_rules failed: {result.stderr[-2000:]}")
            return json.loads((data_dir / "pool-rules.json").read_text())

    def test_stale_disabled_entry_is_dropped_when_resolver_says_live(self):
        rules = self._run(
            augments=[
                augment("clown-college", "confirmed_live"),
                augment("adamant", "disabled"),
            ],
            stale_disabled=["clown-college", "adamant"],
        )
        self.assertEqual(rules["disabled"], ["adamant"])
        self.assertNotIn("clown-college", rules["disabled"])

    def test_disabled_equals_resolver_exactly(self):
        augments = [
            augment("a-live", "confirmed_live"),
            augment("b-disabled", "disabled"),
            augment("c-removed", "removed"),
            augment("d-legacy", "unverified_legacy"),
        ]
        rules = self._run(augments, stale_disabled=["c-removed", "zzz-ghost"])
        resolver = sorted(
            a["slug"] for a in augments if a["availability"]["status"] == "disabled"
        )
        self.assertEqual(rules["disabled"], resolver)

    def test_removed_is_not_reported_as_disabled(self):
        rules = self._run(
            augments=[augment("gone", "removed"), augment("off", "disabled")],
            stale_disabled=[],
        )
        self.assertEqual(rules["disabled"], ["off"])


class LiveArtifactConsistencyTests(unittest.TestCase):
    def test_generated_pool_rules_match_generated_availability(self):
        augments = json.loads((ROOT / "data/internal/augments.json").read_text())["augments"]
        rules = json.loads((ROOT / "data/internal/pool-rules.json").read_text())
        resolver = {
            a["slug"]
            for a in augments
            if ((a.get("availability") or {}).get("status") or "") == "disabled"
        }
        self.assertEqual(set(rules["disabled"]), resolver)

    def test_public_disabled_projection_matches_resolver(self):
        augments = json.loads((ROOT / "public/data/augments.json").read_text())["augments"]
        rules = json.loads((ROOT / "public/data/pool-rules.json").read_text())
        resolver = {
            a["slug"]
            for a in augments
            if ((a.get("availability") or {}).get("status") or "") == "disabled"
        }
        self.assertEqual(set(rules["disabled"]), resolver)


if __name__ == "__main__":
    unittest.main()
