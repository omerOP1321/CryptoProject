"""
Honest evaluation harness for the Crypto forecasting system.

WHY THIS EXISTS
---------------
The training notebooks reported "~80% accuracy", but that figure is the
directional accuracy of the *Bollinger %B series* (an autocorrelated indicator),
not of price. A zero-skill model that echoes the current %B scores ~76-80% on it.
This harness instead measures the ONLY thing that matters for the deployed
product: did the model predict the right PRICE DIRECTION at its real horizon,
and does it beat naive baselines by a statistically significant, cost-aware
margin.

WHAT IT DOES
------------
1. Pulls the live matured predictions from Supabase (same maturity rule as the
   dashboard in website/chart-utils.js) and scores LSTM / Transformer / ARIMA:
     - ERR  = mean |pred - actual| / actual * 100
     - DIR  = price up/down accuracy at the 5-min horizon
     - significance of DIR vs 50% (exact binomial + block-bootstrap 95% CI)
     - cost-aware net edge: average signed return of a long/short-on-signal
       strategy, and the break-even round-trip cost (bps).
2. Compares every model against the five required baselines:
     B1 predict current price | B2 no change | B3 always UP
     B4 always DOWN          | B5 moving-average(20)
3. Offline multi-horizon predictability probe on the historical CSVs: shows the
   directional "ceiling" at 5 / 15 / 30 / 60 min, to inform whether a longer
   horizon is worth pursuing.

USAGE
-----
    python eval_harness.py                 # full scorecard from live Supabase + CSVs
    python eval_harness.py --last 20       # restrict to last-N matured (dashboard view)
    python eval_harness.py --no-supabase   # offline horizon probe only

All metrics are reported over the FULL matured history by default (not the
flattering last-20 window the UI shows).
"""

import os
import json
import math
import argparse
import numpy as np

BASE_DIR = os.path.dirname(os.path.abspath(__file__))
COINS = [(1, "BTCUSDT"), (2, "ETHUSDT"), (3, "XRPUSDT")]
HORIZON_SEC = 300  # models forecast 1 candle (5 min) ahead

try:
    from scipy.stats import binomtest

    def binom_p(k, n, p=0.5):
        if n == 0:
            return float("nan")
        return binomtest(k, n, p, alternative="two-sided").pvalue
except Exception:  # pragma: no cover - scipy fallback
    from math import comb

    def binom_p(k, n, p=0.5):
        if n == 0:
            return float("nan")
        obs = comb(n, k) * p**k * (1 - p) ** (n - k)
        return sum(
            comb(n, i) * p**i * (1 - p) ** (n - i)
            for i in range(n + 1)
            if comb(n, i) * p**i * (1 - p) ** (n - i) <= obs * (1 + 1e-9)
        )


# ----------------------------------------------------------------------
# Data access
# ----------------------------------------------------------------------
def fetch_production():
    """Return {symbol: payload} from the Supabase predictions table."""
    creds = json.load(open(os.path.join(BASE_DIR, "supabase_creds.json")))
    from supabase import create_client

    sb = create_client(creds["url"], creds["key"])
    rows = sb.table("predictions").select("*").execute().data
    by_id = {r["id"]: r["payload"] for r in rows}
    return {sym: by_id[i] for i, sym in COINS if i in by_id}


def matured_records(payload, model, last_n=None, from_sec=-math.inf, to_sec=math.inf):
    """Port of chart-utils.js computeModelStats maturity logic.

    A prediction stored at target time t matures only once candle t has FULLY
    closed (a later candle exists). Realized price = close(t+300); baseline
    (price when the prediction was made) = close(t) = previous candle's close.
    Returns list of dicts {t, base, pred, actual}.
    """
    ph = payload.get("prediction_history", [])
    hist5 = payload.get("history", {}).get("5m", [])
    if not ph or not hist5:
        return []
    close_at = {c["time"] + HORIZON_SEC: c["c"] for c in hist5}
    last_candle = hist5[-1]["time"]
    out = []
    for e in ph:
        raw = e.get(model)
        if raw is None:
            continue
        try:
            pred = float(raw)
        except (TypeError, ValueError):
            continue
        if not math.isfinite(pred):
            continue
        t = int(e["time"])
        if t >= last_candle or t < from_sec or t > to_sec:
            continue
        actual = close_at.get(t + HORIZON_SEC)
        if actual is None or actual <= 0:
            continue
        base = close_at.get(t)
        out.append({"t": t, "base": base, "pred": pred, "actual": actual})
    if last_n is not None:
        out = out[-last_n:]
    return out


# ----------------------------------------------------------------------
# Scoring
# ----------------------------------------------------------------------
def block_bootstrap_dir_ci(hits, block=10, n_boot=2000, seed=0):
    """95% CI for directional accuracy using a moving-block bootstrap, which
    respects serial correlation (consecutive 5-min predictions are not iid)."""
    hits = np.asarray(hits, dtype=float)
    n = len(hits)
    if n == 0:
        return (float("nan"), float("nan"))
    rng = np.random.default_rng(seed)
    nblocks = int(np.ceil(n / block))
    means = []
    for _ in range(n_boot):
        starts = rng.integers(0, n, size=nblocks)
        sample = np.concatenate([
            np.take(hits, range(s, s + block), mode="wrap") for s in starts
        ])[:n]
        means.append(sample.mean())
    lo, hi = np.percentile(means, [2.5, 97.5])
    return (lo * 100, hi * 100)


def score_model(records):
    """ERR, DIR, significance, and cost-aware edge for one model's matured set."""
    if not records:
        return None
    errs, signed_ret, dir_hits = [], [], []
    for r in records:
        errs.append(abs(r["pred"] - r["actual"]) / r["actual"] * 100)
        base = r["base"]
        if base is None or base <= 0:
            continue
        pm = r["pred"] - base          # predicted move
        am = r["actual"] - base        # actual move
        if pm == 0 or am == 0:
            continue
        dir_hits.append(1 if (pm > 0) == (am > 0) else 0)
        # long if pred up, short if pred down; realized signed return (fraction)
        signed_ret.append(np.sign(pm) * (am / base))
    n_dir = len(dir_hits)
    hits = int(np.sum(dir_hits))
    dir_acc = hits / n_dir * 100 if n_dir else float("nan")
    lo, hi = block_bootstrap_dir_ci(dir_hits) if n_dir else (float("nan"),) * 2
    gross = float(np.mean(signed_ret)) if signed_ret else float("nan")  # per-trade return
    return {
        "n": len(records),
        "err": float(np.mean(errs)),
        "dir": dir_acc,
        "dir_n": n_dir,
        "dir_hits": hits,
        "p": binom_p(hits, n_dir),
        "ci": (lo, hi),
        "gross_bps": gross * 1e4,            # mean per-trade edge in basis points
        "breakeven_bps": gross * 1e4,        # round-trip cost that wipes out the edge
    }


def baselines_on_grid(payload):
    """B1-B5 evaluated on every candle (the universal grid), so models can be
    compared against them on equal footing."""
    hist5 = payload.get("history", {}).get("5m", [])
    if len(hist5) < 25:
        return {}
    close_at = {c["time"] + HORIZON_SEC: c["c"] for c in hist5}
    closes_by_t = {c["time"]: c["c"] for c in hist5}
    sorted_t = sorted(closes_by_t)
    idx = {t: i for i, t in enumerate(sorted_t)}

    grid = []
    for c in hist5:
        t = c["time"]
        base, actual = close_at.get(t), close_at.get(t + HORIZON_SEC)
        if base and actual and base > 0 and actual > 0:
            grid.append((t, base, actual))
    if not grid:
        return {}

    moves = np.array([a - b for _, b, a in grid])
    up = int((moves > 0).sum())
    down = int((moves < 0).sum())
    tot_dir = up + down
    persist_err = float(np.mean([abs(b - a) / a * 100 for _, b, a in grid]))

    ma_err, ma_hits, ma_n = [], 0, 0
    for t, base, actual in grid:
        i = idx.get(t)
        if i is None or i < 20:
            continue
        ma = float(np.mean([closes_by_t[sorted_t[i - j]] for j in range(20)]))
        ma_err.append(abs(ma - actual) / actual * 100)
        pm, am = ma - base, actual - base
        if pm != 0 and am != 0:
            ma_n += 1
            ma_hits += (pm > 0) == (am > 0)

    return {
        "n": len(grid),
        "up_rate": up / tot_dir * 100 if tot_dir else float("nan"),
        "B1_B2_persist_err": persist_err,
        "B3_up_dir": up / tot_dir * 100 if tot_dir else float("nan"),
        "B4_down_dir": down / tot_dir * 100 if tot_dir else float("nan"),
        "B5_ma_err": float(np.mean(ma_err)) if ma_err else float("nan"),
        "B5_ma_dir": ma_hits / ma_n * 100 if ma_n else float("nan"),
    }


# ----------------------------------------------------------------------
# Offline multi-horizon predictability probe (uses historical CSVs)
# ----------------------------------------------------------------------
def horizon_probe(symbol, horizons=(1, 3, 6, 12)):
    """For each horizon h (in 5-min candles), report the realized directional
    'ceiling' available to a momentum/persistence rule: the fraction of times
    the sign of the past-h return predicts the sign of the next-h return.
    ~50% means the horizon is near-efficient (unpredictable from price alone)."""
    import pandas as pd

    path = os.path.join(BASE_DIR, "data", f"{symbol}_5m_data.csv")
    if not os.path.exists(path):
        return None
    close = pd.read_csv(path)["close"].astype(float).values
    out = {}
    for h in horizons:
        if len(close) <= 2 * h:
            continue
        past = np.sign(close[h:] - close[:-h])          # sign of return over [t-h, t]
        fut = np.sign(close[2 * h:] - close[h:-h])       # sign of return over [t, t+h]
        m = min(len(past), len(fut))
        past, fut = past[:m], fut[:m]
        mask = (past != 0) & (fut != 0)
        momentum = (past[mask] == fut[mask]).mean() * 100 if mask.sum() else float("nan")
        out[h] = {
            "minutes": h * 5,
            "momentum_dir": momentum,            # >50 trend, <50 mean-revert
            "n": int(mask.sum()),
        }
    return out


# ----------------------------------------------------------------------
# Reporting
# ----------------------------------------------------------------------
def fmt_pct(x):
    return "  n/a " if x is None or (isinstance(x, float) and math.isnan(x)) else f"{x:6.2f}"


def print_scorecard(last_n=None, use_supabase=True):
    cost_levels = [1, 2, 5, 10]  # round-trip costs in bps to test against
    print("=" * 78)
    print("HONEST EVALUATION SCORECARD  (price direction @ 5-min horizon)")
    print("Window:", f"last {last_n} matured" if last_n else "FULL matured history")
    print("=" * 78)

    if use_supabase:
        try:
            production = fetch_production()
        except Exception as e:
            print(f"!! Could not reach Supabase ({e}); skipping live scorecard.")
            production = {}
    else:
        production = {}

    for _id, sym in COINS:
        payload = production.get(sym)
        print(f"\n### {sym}")
        if not payload:
            print("   (no live payload)")
        else:
            base = baselines_on_grid(payload)
            if base:
                print(f"   Baselines (grid n={base['n']}, actual UP-rate {base['up_rate']:.1f}%):")
                print(f"     B1/B2 persistence/no-change  ERR={base['B1_B2_persist_err']:.4f}%  (no direction)")
                print(f"     B3 always-UP   DIR={base['B3_up_dir']:.1f}%   "
                      f"B4 always-DOWN DIR={base['B4_down_dir']:.1f}%")
                print(f"     B5 MA(20)      ERR={base['B5_ma_err']:.4f}%  DIR={base['B5_ma_dir']:.1f}%")
            print(f"   {'model':<12}{'n':>5}{'ERR%':>9}{'DIR%':>8}{'95%CI':>16}"
                  f"{'binom p':>10}{'edge bps':>10}{'verdict':>14}")
            persist_err = base.get("B1_B2_persist_err") if base else None
            # Ensemble is scored too once the engine starts writing it to history
            # (entries created before that fix simply have no Ensemble value).
            for model in ("LSTM", "Transformer", "ARIMA", "Ensemble"):
                recs = matured_records(payload, model, last_n=last_n)
                s = score_model(recs)
                if not s:
                    print(f"   {model:<12}   (no matured predictions)")
                    continue
                ci = f"[{s['ci'][0]:.0f},{s['ci'][1]:.0f}]"
                sig = s["p"] < 0.05
                beats_err = persist_err is not None and s["err"] < persist_err
                if sig and s["dir"] > 50 and beats_err:
                    verdict = "REAL EDGE"
                elif sig and s["dir"] > 50:
                    verdict = "dir-only"
                else:
                    verdict = "~chance"
                print(f"   {model:<12}{s['n']:>5}{s['err']:>9.4f}{s['dir']:>8.1f}{ci:>16}"
                      f"{s['p']:>10.3f}{s['gross_bps']:>10.2f}{verdict:>14}")
                # cost-aware: is the per-trade edge positive after costs?
                net = [f"{c}bp:{s['gross_bps'] - c:+.1f}" for c in cost_levels]
                print(f"   {'':<12}   net edge after round-trip cost -> " + "  ".join(net))

    # ---- offline horizon probe ----
    print("\n" + "=" * 78)
    print("MULTI-HORIZON PREDICTABILITY PROBE (offline, from data/*.csv)")
    print("Momentum DIR = does past-h return sign predict next-h return sign.")
    print("~50% => near-efficient/unpredictable from price;  >53% => exploitable drift.")
    print("=" * 78)
    for _id, sym in COINS:
        probe = horizon_probe(sym)
        if not probe:
            print(f"{sym}: no CSV")
            continue
        cells = "  ".join(
            f"{v['minutes']:>3}m:{v['momentum_dir']:.1f}%(n={v['n']})" for v in probe.values()
        )
        print(f"{sym}:  {cells}")
    print("\nNote: this CSV probe uses only the locally cached recent candles; for a")
    print("definitive horizon study, point it at the full-history CSV on Drive.")


if __name__ == "__main__":
    ap = argparse.ArgumentParser()
    ap.add_argument("--last", type=int, default=None,
                    help="restrict to last-N matured predictions (default: full history)")
    ap.add_argument("--no-supabase", action="store_true",
                    help="skip live scorecard, run offline horizon probe only")
    args = ap.parse_args()
    print_scorecard(last_n=args.last, use_supabase=not args.no_supabase)
