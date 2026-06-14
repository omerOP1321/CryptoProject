"""
Feature selection — the missing "Feature Selection" stage from the methodological
framework (Omole & Enke 2024, Fig. 1: GA / Boruta / LightGBM).

We implement **Boruta** (the paper's best selector) using only scikit-learn, so
there are no fragile extra dependencies. Boruta's idea: for each real feature,
create a "shadow" feature by shuffling its values (destroying any relationship
to the target). Train a Random Forest on [real | shadow] features; a real
feature is *confirmed* only if its importance beats the best shadow's importance.
Repeat over several runs and keep features confirmed a majority of the time.

LEAKAGE NOTE: selection is fit on the TRAINING region only (everything before the
walk-forward test folds), never on test data — exactly like the model itself.

Why this stage now: the experiment grid showed that naively adding feature blocks
(extra -> 26, on-chain -> 30/22) *degraded* results. Boruta keeps only the
statistically-relevant subset, so it both completes the framework and may recover
some of that lost ground (it will not, on its own, manufacture a tradeable edge —
the ~52% direction ceiling is a market-efficiency property, not a feature bug).

Run:  python -m pipeline.feature_select --symbol BTCUSDT
"""

import os
import json
import argparse
from datetime import datetime

import numpy as np
import pandas as pd
from sklearn.ensemble import RandomForestClassifier

from .config import CONFIG, OUT_DIR, feature_list
from .dataset import load_frame


def boruta_select(df: pd.DataFrame, feats, target: str = "target_cls",
                  subsample: int = 80000, n_estimators: int = 150,
                  n_runs: int = 8, confirm_frac: float = 0.6, seed: int = 0):
    """Boruta shadow-feature selection on a single (training) frame.

    Returns (confirmed_features, ranking_df). ``ranking_df`` has the per-feature
    hit-rate (fraction of runs the feature beat the best shadow). A feature is
    confirmed if its hit-rate >= ``confirm_frac``.
    """
    rng = np.random.default_rng(seed)
    sub = df.dropna(subset=list(feats) + [target])
    if len(sub) > subsample:                      # selection doesn't need all rows
        sub = sub.iloc[rng.choice(len(sub), subsample, replace=False)]
    X = sub[feats].to_numpy(dtype=np.float32)
    y = sub[target].to_numpy(dtype=int)

    hits = np.zeros(len(feats))
    for r in range(n_runs):
        shadow = X.copy()
        for j in range(shadow.shape[1]):          # shuffle each shadow column
            rng.shuffle(shadow[:, j])
        rf = RandomForestClassifier(n_estimators=n_estimators, n_jobs=-1,
                                    max_depth=12, random_state=seed + r)
        rf.fit(np.hstack([X, shadow]), y)
        imp = rf.feature_importances_
        real_imp, shadow_imp = imp[:len(feats)], imp[len(feats):]
        hits += (real_imp > shadow_imp.max()).astype(float)   # beat BEST shadow

    hit_rate = hits / n_runs
    rank = (pd.DataFrame({"feature": list(feats), "hit_rate": hit_rate})
            .sort_values("hit_rate", ascending=False).reset_index(drop=True))
    confirmed = rank.loc[rank["hit_rate"] >= confirm_frac, "feature"].tolist()
    return confirmed, rank


def select_for_symbol(symbol: str, cfg: dict, **kw):
    """Load the full feature frame for a symbol and run Boruta on the TRAIN region
    only (excludes the walk-forward test folds). Returns (confirmed, ranking)."""
    base = dict(cfg)
    base.pop("selected_features", None)           # select from the FULL candidate set
    feats = feature_list(base)
    df = load_frame(symbol, base)

    test_frac = cfg.get("wf_folds", 2) * cfg.get("wf_test_frac", 0.10)
    cut = int(len(df) * (1.0 - test_frac))         # train region = before test folds
    train_df = df.iloc[:cut]
    print(f"  [select] {symbol}: {len(feats)} candidate features, "
          f"selecting on {len(train_df)} train rows (of {len(df)})")
    return boruta_select(train_df, feats, **kw)


def save_selection(selected: dict, ranks: dict, cfg: dict,
                   path: str = None) -> str:
    """Persist the Boruta result (chosen features + hit-rates + the candidate pool
    it chose from) to models_v2/selected_features.json so it survives restarts and
    is a citable artifact. Returns the path written."""
    mdir = os.path.join(OUT_DIR, f"{cfg.get('horizon', 1) * 5}min")
    path = path or os.path.join(mdir, "selected_features.json")
    os.makedirs(os.path.dirname(path), exist_ok=True)
    pool = feature_list({**cfg, "selected_features": None})
    payload = {
        "candidate_pool": pool,
        "use_extra_features": bool(cfg.get("use_extra_features")),
        "use_onchain": bool(cfg.get("use_onchain")),
        "horizon_min": cfg.get("horizon", 1) * 5,
        "saved_at": datetime.now().strftime("%Y-%m-%d %H:%M:%S"),
        "selected": {s: list(v) for s, v in selected.items()},
        "hit_rates": {s: dict(zip(r["feature"], r["hit_rate"].round(3)))
                      for s, r in ranks.items()},
    }
    with open(path, "w") as f:
        json.dump(payload, f, indent=2)
    return path


def update_selection(symbol: str, confirmed, rank: pd.DataFrame, cfg: dict,
                     path: str = None) -> str:
    """Merge ONE symbol's Boruta result into models_v2/selected_features.json
    (load → update this symbol → write back). Used by the automatic in-run
    selection so each per-symbol run keeps the shared file up to date."""
    mdir = os.path.join(OUT_DIR, f"{cfg.get('horizon', 1) * 5}min")
    path = path or os.path.join(mdir, "selected_features.json")
    os.makedirs(os.path.dirname(path), exist_ok=True)
    payload = {}
    if os.path.exists(path):
        try:
            payload = json.load(open(path))
        except Exception:
            payload = {}
    payload["candidate_pool"] = feature_list({**cfg, "selected_features": None})
    payload["use_extra_features"] = bool(cfg.get("use_extra_features"))
    payload["use_onchain"] = bool(cfg.get("use_onchain"))
    payload["horizon_min"] = cfg.get("horizon", 1) * 5
    payload["saved_at"] = datetime.now().strftime("%Y-%m-%d %H:%M:%S")
    payload.setdefault("selected", {})[symbol] = list(confirmed)
    payload.setdefault("hit_rates", {})[symbol] = dict(
        zip(rank["feature"], rank["hit_rate"].round(3)))
    with open(path, "w") as f:
        json.dump(payload, f, indent=2)
    return path


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--symbol", default="BTCUSDT")
    ap.add_argument("--all", action="store_true", help="select for every symbol + save JSON")
    ap.add_argument("--extra", action="store_true", help="include FEATURES_EXTRA candidates")
    ap.add_argument("--onchain", action="store_true", help="include FEATURES_ONCHAIN candidates")
    args = ap.parse_args()

    cfg = dict(CONFIG, use_extra_features=args.extra, use_onchain=args.onchain,
               horizon=12)
    symbols = ["BTCUSDT", "ETHUSDT", "XRPUSDT"] if args.all else [args.symbol]
    selected, ranks = {}, {}
    for sym in symbols:
        confirmed, rank = select_for_symbol(sym, cfg)
        selected[sym], ranks[sym] = confirmed, rank
        print(f"\n{sym} ranking (hit-rate = fraction of runs beating best shadow):")
        print(rank.to_string(index=False))
        print(f"CONFIRMED ({len(confirmed)}): {confirmed}")
    out = save_selection(selected, ranks, cfg)
    print(f"\nsaved -> {out}")


if __name__ == "__main__":
    main()
