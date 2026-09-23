"""Phase 0 tau measurement: the estimator recovers a known spread, and refuses
to report one when the rows carry no champion-specific information."""

import sys
from pathlib import Path

import numpy as np

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
import interaction_spread as M  # noqa: E402

RNG_SEED = 7
C = 60


def _world():
    rng = np.random.default_rng(RNG_SEED)
    mu = rng.uniform(0.46, 0.58, C)
    pi = rng.uniform(0.01, 0.1, C)
    return rng, mu, pi


def test_recovers_a_known_spread_when_nothing_is_selected():
    rng, mu, pi = _world()
    for tau in (0.5, 2.0):
        fitted = M.fit(M.simulate(rng, mu, pi, 30, 1e-6, 2.0, -1.0, tau, 0.0, listed=30))["tau"]
        assert abs(fitted - tau) < 0.25, (tau, fitted)


def test_selection_with_herding_reads_low():
    rng, mu, pi = _world()
    fitted = np.mean([M.fit(M.simulate(rng, mu, pi, 30, 1e-6, 2.0, -1.0, 3.0, 1.0))["tau"] for _ in range(2)])
    assert fitted < 2.9


def test_additive_rows_are_not_identifiable():
    # champion level + global augment value, exactly what the provider publishes today
    champ = np.repeat(np.arange(20), 6)
    aug = np.tile(np.arange(6), 20)
    level = np.linspace(-2, 2, 20)[champ]
    rows = {"champ": champ, "aug": aug, "lift": level + np.linspace(-3, 3, 6)[aug],
            "x": np.ones(120), "kit": np.zeros(120)}
    assert M.identifiability(rows)["identifiable"] is False
    rows["lift"] = rows["lift"] + np.random.default_rng(1).normal(0, 1, 120)
    assert M.identifiability(rows)["identifiable"] is True
