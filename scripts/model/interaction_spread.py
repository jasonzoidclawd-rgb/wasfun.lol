#!/usr/bin/env python3
"""Phase 0 measurement: the champion-specific interaction spread tau.

The Phase 5 gate (first-party uploader) needs to know how big champion x augment
interactions are. They are fitted on the champion rows the provider lists, but
the provider lists only each champion's most-picked augments per rarity, and
players pick good pairs more often, so the listed rows are a selected sample
and the fitted spread reads low. This script:

1. fits, per rarity, on the real listed rows
       lift_ca = g_a + beta * k_ca + iota_ca + eps_ca,   iota ~ N(0, tau^2),
       Var(eps_ca) = kappa * mu_c (1 - mu_c) / (a_ca * pi_c)
   with g_a a fixed effect per augment (augments listed on >= 2 champions),
   k_ca the kit-mismatch covariate, and (tau^2, kappa) by REML. The noise uses
   the champion's baseline rate mu_c, never the row's own rate. kappa is the
   noise scale fitted by marginal likelihood (the provider publishes no counts);
   in the provider's units 1/kappa is an implied player-game volume.
2. simulates worlds shaped like the real data (same champions, win and pick
   rates, pool sizes, noise scale, augment spread) with a known true tau and
   herding strength, lists each champion's top 6 by appearance, and runs the
   SAME estimator, to map true tau -> fitted tau;
3. inverts that map at the real fitted tau: the selection-corrected tau.

Step 0 guards all of this: if a two-way additive model (champion + augment)
fits the listed win rates exactly, the rows carry no champion-specific
outcome information and tau is NOT identifiable from them. That is the case
for the provider as of 2026-09-24: every champion's listed augment win rate
equals the augment's global win rate (3114 of 3114 rows). The script then
reports status "not-identifiable" instead of fitting noise.

numpy only. Seeded, so the recorded result reproduces.

Usage:
    python3 scripts/model/interaction_spread.py [--reps 6] [--out FILE]
"""

from __future__ import annotations

import argparse
import json
import sys
from pathlib import Path

import numpy as np

ROOT = Path(__file__).resolve().parents[2]
DATA = ROOT / "data" / "internal"
LISTED_PER_RARITY = 6
ROUNDING_SD = 0.01  # pp; the rounding of 2-decimal rates leaves ~0.003
LOG_KAPPA_BOUNDS = (np.log(1e-6), np.log(10.0))
LOG_TAU2_BOUNDS = (np.log(0.01), np.log(25.0))
RARITIES = ("prismatic", "gold", "silver")


# ── real data ───────────────────────────────────────────────────────────────


def load_rows(build: dict, tags: dict, damage: dict[str, str], rarity: str) -> dict:
    """Listed rows of one rarity as arrays. Rates become fractions."""
    champs, augs, lift, x, kit, mu_c = [], [], [], [], [], []
    for slug, champ in build["champions"].items():
        if not champ.get("pickRate"):
            continue
        mu = champ["winRate"] / 100.0
        pi = champ["pickRate"] / 100.0
        for row in champ["augments"]:
            if row["rarity"] != rarity:
                continue
            key = row["augmentId"] or f"src:{row['sourceSlug']}"
            a = row["appearanceRate"] / 100.0
            if a <= 0:
                continue
            profile = (tags.get(row["augmentId"] or "", {}) or {}).get("profile") if row["augmentId"] else None
            reviewed = (tags.get(row["augmentId"] or "", {}) or {}).get("reviewed", False)
            dmg = damage.get(slug)
            k = 1.0 if reviewed and ((profile == "ap" and dmg == "physical") or (profile == "ad" and dmg == "magic")) else 0.0
            champs.append(slug)
            augs.append(key)
            lift.append((row["winRate"] - champ["winRate"]))  # pp
            x.append(mu * (1 - mu) / (a * pi) * 1e4)  # pp^2 per unit kappa
            kit.append(k)
            mu_c.append(mu)
    return {
        "champ": np.array(champs), "aug": np.array(augs), "lift": np.array(lift, float),
        "x": np.array(x, float), "kit": np.array(kit, float),
    }


# ── estimator ───────────────────────────────────────────────────────────────


def _design(aug: np.ndarray, champ: np.ndarray) -> tuple[np.ndarray, np.ndarray, np.ndarray]:
    """Keep augments listed on >= 2 champions; return mask, augment index, champion index."""
    _, inv, counts = np.unique(aug, return_inverse=True, return_counts=True)
    keep = counts[inv] >= 2
    _, grp = np.unique(aug[keep], return_inverse=True)
    _, cg = np.unique(champ[keep], return_inverse=True)
    return keep, grp, cg


def _reml(lift, x, kit, grp, cg, tau2, kappa):
    """REML log-likelihood of (tau2, kappa) with fixed augment means, fixed
    champion offsets (a level shared by all of a champion's rows is not an
    interaction: it never changes which card to take) and a shared kit slope
    beta, all profiled out by weighted backfitting. The REML determinant uses
    the two one-way blocks, an approximation the simulation shares."""
    v = tau2 + kappa * x
    w = 1.0 / v
    G, C = grp.max() + 1, cg.max() + 1
    sw_a, sw_c = np.bincount(grp, w, G), np.bincount(cg, w, C)
    beta, h = 0.0, np.zeros(C)
    for _ in range(12):
        g = np.bincount(grp, w * (lift - beta * kit - h[cg]), G) / sw_a
        h = np.bincount(cg, w * (lift - beta * kit - g[grp]), C) / sw_c
        h -= np.average(h, weights=sw_c)
        r0 = lift - g[grp] - h[cg]
        den = (w * kit * kit).sum()
        beta = (w * kit * r0).sum() / den if den > 1e-12 else 0.0
    r = lift - g[grp] - h[cg] - beta * kit
    ll = -0.5 * (np.log(v).sum() + (w * r * r).sum() + np.log(sw_a).sum() + np.log(sw_c).sum())
    return ll, beta, g


def fit(rows: dict) -> dict:
    keep, grp, cg = _design(rows["aug"], rows["champ"])
    lift, x, kit = rows["lift"][keep], rows["x"][keep], rows["kit"][keep]
    # coarse grid, then a local refinement; both in log space
    best = None
    for lt in np.linspace(np.log(0.01), np.log(25.0), 40):
        for lk in np.linspace(np.log(1e-6), np.log(10.0), 60):
            ll = _reml(lift, x, kit, grp, cg, np.exp(lt), np.exp(lk))[0]
            if best is None or ll > best[0]:
                best = (ll, lt, lk)
    _, lt, lk = best
    step = 0.25
    while step > 1e-3:
        moved = False
        for dt, dk in ((step, 0), (-step, 0), (0, step), (0, -step)):
            if not (LOG_TAU2_BOUNDS[0] <= lt + dt <= LOG_TAU2_BOUNDS[1] and LOG_KAPPA_BOUNDS[0] <= lk + dk <= LOG_KAPPA_BOUNDS[1]):
                continue
            ll = _reml(lift, x, kit, grp, cg, np.exp(lt + dt), np.exp(lk + dk))[0]
            if ll > best[0] + 1e-9:
                best, lt, lk, moved = (ll, lt + dt, lk + dk), lt + dt, lk + dk, True
                break
        if not moved:
            step /= 2
    tau2, kappa = float(np.exp(lt)), float(np.exp(lk))
    _, beta, _ = _reml(lift, x, kit, grp, cg, tau2, kappa)
    return {
        "tau": tau2 ** 0.5, "tau2": tau2, "kappa": kappa, "beta": float(beta),
        "rows": int(keep.sum()), "augments": int(grp.max() + 1), "rowsDropped": int((~keep).sum()),
        "kitRows": int(kit.sum()),
    }


# ── selection-correcting simulation ─────────────────────────────────────────


def simulate(rng, champ_mu, champ_pi, pool, kappa, g_sd, beta, tau, herd, kit_share=0.15, listed=LISTED_PER_RARITY):
    """One world shaped like the real data; returns listed rows in estimator form."""
    C = len(champ_mu)
    g = g_sd * rng.normal(0, 1, pool)
    kit = (rng.random((C, pool)) < kit_share).astype(float)
    theta = g[None, :] + beta * kit + tau * rng.normal(0, 1, (C, pool))  # pp
    lp = 0.8 * rng.normal(0, 1, pool)[None, :] + 0.7 * rng.normal(0, 1, (C, pool)) + herd * theta / 2
    p = np.exp(lp)
    p = p / p.sum(1, keepdims=True) * 1.33
    N = 1.0 / kappa  # implied volume in the provider's units
    n = np.maximum(rng.poisson(N * champ_pi[:, None] * p), 1)
    k = rng.binomial(n, np.clip(champ_mu[:, None] + theta / 100, 0.01, 0.99))
    a_hat = n / (N * champ_pi[:, None])
    champ, aug, lift, x, kk = [], [], [], [], []
    for c in range(C):
        top = np.argsort(-a_hat[c])[:listed]
        mu = champ_mu[c]
        for j in top:
            champ.append(c)
            aug.append(j)
            lift.append((k[c, j] / n[c, j] - mu) * 100)
            x.append(mu * (1 - mu) / (a_hat[c, j] * champ_pi[c]) * 1e4)
            kk.append(kit[c, j])
    return {"champ": np.array(champ), "aug": np.array(aug), "lift": np.array(lift),
            "x": np.array(x), "kit": np.array(kk)}


def identifiability(rows: dict) -> dict:
    """Residual spread of a plain two-way additive fit. Exactly zero means the
    per-champion rows are a champion level plus a global augment value."""
    keep, grp, cg = _design(rows["aug"], rows["champ"])
    y = rows["lift"][keep]
    G, C = grp.max() + 1, cg.max() + 1
    X = np.zeros((len(y), G + C))
    X[np.arange(len(y)), grp] = 1
    X[np.arange(len(y)), G + cg] = 1
    coef, *_ = np.linalg.lstsq(X, y, rcond=None)
    resid = y - X @ coef
    sd = float(np.sqrt(resid @ resid / max(len(y) - np.linalg.matrix_rank(X), 1)))
    # Rates are published to 0.01 pp, so rounding alone leaves a residual of about
    # 0.003 pp. Anything up to ROUNDING_SD is indistinguishable from an exact copy.
    return {"additiveResidualSd": sd, "identifiable": sd > ROUNDING_SD}


def global_copy_share(build: dict, stats: dict) -> tuple[int, int]:
    """(rows equal to the augment's global win rate, rows compared)."""
    glob = {r["sourceSlug"]: r["winRate"] for r in stats["rows"]}
    rows = [r for c in build["champions"].values() for r in c["augments"] if r["sourceSlug"] in glob]
    same = sum(1 for r in rows if abs(r["winRate"] - glob[r["sourceSlug"]]) < 0.005)
    return same, len(rows)


def correction_curve(rng, real, fitted, reps, taus, herds):
    curve = {}
    for herd in herds:
        for tau in taus:
            vals = [fit(simulate(rng, real["mu"], real["pi"], real["pool"], fitted["kappa"],
                                 real["g_sd"], fitted["beta"], tau, herd))["tau"] for _ in range(reps)]
            curve[(herd, tau)] = (float(np.mean(vals)), float(np.std(vals)))
    return curve


def invert(curve, herd, taus, observed):
    """True tau at the observed fitted tau, by linear interpolation. Outside the
    simulated range the value is reported as a bound, never silently clamped."""
    fitted = np.array([curve[(herd, t)][0] for t in taus])
    order = np.argsort(fitted)
    lo, hi = fitted[order][0], fitted[order][-1]
    value = float(np.interp(observed, fitted[order], np.array(taus)[order]))
    if observed > hi:
        return {"atLeast": value}
    if observed < lo:
        return {"atMost": value}
    return {"value": value}


def main(argv=None) -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("--reps", type=int, default=6)
    ap.add_argument("--seed", type=int, default=20260924)
    ap.add_argument("--out", type=Path, default=None)
    args = ap.parse_args(argv)
    rng = np.random.default_rng(args.seed)

    build = json.loads((DATA / "champion-build-feed.json").read_text())
    stats = json.loads((DATA / "augment-stats-feed.json").read_text())
    tags = json.loads((DATA / "augment-kit-tags.json").read_text())["tags"]
    damage = {s: p.get("damageType") for s, p in json.loads((DATA / "abilities.json").read_text())["profiles"].items()}
    champs = [c for c in build["champions"].values() if c.get("pickRate")]
    real_common = {
        "mu": np.array([c["winRate"] / 100 for c in champs]),
        "pi": np.array([c["pickRate"] / 100 for c in champs]),
    }
    taus = [0.25, 0.5, 1.0, 1.5, 2.0, 2.5, 3.0, 3.5, 4.0, 5.0, 6.0, 8.0]
    herds = [0.25, 0.5, 1.0]
    same, compared = global_copy_share(build, stats)
    result = {"patch": build.get("patch"), "fetchedAt": build.get("fetchedAt"), "seed": args.seed,
              "reps": args.reps, "championRowsEqualToGlobal": [same, compared], "rarities": {}}
    print(f"champion rows whose win rate equals the augment's global win rate: {same}/{compared}")
    for rarity in RARITIES:
        rows = load_rows(build, tags, damage, rarity)
        ident = identifiability(rows)
        if not ident["identifiable"]:
            result["rarities"][rarity] = {"status": "not-identifiable", **ident}
            print(f"{rarity:9s} tau NOT identifiable: two-way additive residual sd {ident['additiveResidualSd']:.1e} pp")
            continue
        fitted = fit(rows)
        live = [r for r in stats["rows"] if r["availability"] == "live" and r["rarity"] == rarity]
        wr = np.array([r["winRate"] for r in live])
        real = {**real_common, "pool": len(live), "g_sd": float(np.std(wr - np.average(wr)))}
        curve = correction_curve(rng, real, fitted, args.reps, taus, herds)
        corrected = {str(h): invert(curve, h, taus, fitted["tau"]) for h in herds}
        result["rarities"][rarity] = {
            "status": "measured",
            **ident,
            "fitted": fitted,
            "poolSize": real["pool"],
            "globalWinRateSd": real["g_sd"],
            "impliedVolume": 1.0 / fitted["kappa"],
            "correctedTauByHerding": corrected,
            "curve": {f"herd={h} tau={t}": curve[(h, t)] for h, t in curve},
        }
        print(f"{rarity:9s} fitted tau {fitted['tau']:.2f} pp (rows {fitted['rows']}, augments {fitted['augments']}, "
              f"beta {fitted['beta']:+.2f}, kit rows {fitted['kitRows']}), implied volume {1/fitted['kappa']:,.0f}; "
              f"corrected tau by herding {corrected}")
    if args.out:
        args.out.write_text(json.dumps(result, indent=1) + "\n")
    return 0


if __name__ == "__main__":
    sys.exit(main())
