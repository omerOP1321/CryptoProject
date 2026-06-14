"""
Sequence building, causal scaling, and walk-forward (rolling-origin) splits.

Walk-forward replaces the legacy single 80/10/10 chronological split: we slide a
train/val/test window across time and aggregate out-of-sample test predictions,
which is the honest way to estimate live performance and to detect drift.
"""

import os
import numpy as np
import pandas as pd

from .config import CONFIG, DATA_DIR, feature_list
from .features import compute_features, make_targets, merge_onchain


def load_frame(symbol: str, cfg: dict) -> pd.DataFrame:
    """Load raw CSV -> features -> targets -> drop warm-up/no-target rows.
    cfg['max_rows'] caps to the most recent N candles (fast experiments)."""
    feats = feature_list(cfg)
    path = os.path.join(DATA_DIR, f"{symbol}_5m_data.csv")
    df = pd.read_csv(path)
    df = compute_features(df, vol_window=cfg["vol_window"])
    if cfg.get("use_onchain"):
        df = merge_onchain(df, symbol)
    df = make_targets(df, cfg["horizon"], cfg["deadband_k"], cfg["vol_window"])
    keep = feats + ["target_ret", "target_cls", "close", "open_time",
                    "bb_lband", "bb_hband"]
    df = df[keep].dropna().reset_index(drop=True)
    if cfg.get("max_rows"):
        df = df.tail(int(cfg["max_rows"])).reset_index(drop=True)
    return df


def _sequences(feat_scaled, ret, cls, base_close, seq_len, step=1):
    """Window the rows. y is aligned to the LAST candle of each window, whose
    forward return / class is the supervised target. base_close is that candle's
    close (the price the prediction is made from)."""
    X, yr, yc, bc = [], [], [], []
    for i in range(0, len(feat_scaled) - seq_len + 1, step):
        j = i + seq_len - 1
        X.append(feat_scaled[i:i + seq_len])
        yr.append(ret[j]); yc.append(cls[j]); bc.append(base_close[j])
    return (np.asarray(X, dtype=np.float32), np.asarray(yr, dtype=np.float32),
            np.asarray(yc, dtype=np.int64), np.asarray(bc, dtype=np.float64))


def walk_forward_folds(df: pd.DataFrame, cfg: dict):
    """Yield dicts with scaled train/val/test sequences for each rolling fold.
    StandardScaler is fit on each fold's TRAIN slice only (no leakage)."""
    from sklearn.preprocessing import StandardScaler

    feats = feature_list(cfg)
    n = len(df)
    seq = cfg["seq_length"]
    train_step = max(1, int(cfg.get("train_step", 1)))
    test_sz = int(n * cfg["wf_test_frac"])
    val_sz = int(n * cfg["wf_val_frac"])
    folds = cfg["wf_folds"]
    if test_sz < seq + 5 or val_sz < seq + 5:
        folds = 1  # tiny data (e.g. smoke test): one fold

    feat = df[feats].values
    ret = df["target_ret"].values
    cls = df["target_cls"].values.astype(np.int64)
    base = df["close"].values
    times = df["open_time"].values

    # Place test folds at the end of the series, sliding backwards.
    for k in range(folds):
        test_end = n - k * test_sz
        test_start = test_end - test_sz
        val_start = test_start - val_sz
        train_end = val_start
        if train_end < seq + 10:
            break
        sc = StandardScaler().fit(feat[:train_end])
        sl = lambda a, b: slice(max(0, a), b)

        def build(a, b, step=1):
            return _sequences(sc.transform(feat[sl(a, b)]), ret[sl(a, b)],
                              cls[sl(a, b)], base[sl(a, b)], seq, step=step)

        def daterange(a, b):
            s = times[sl(a, b)]
            return (str(s[0])[:10], str(s[-1])[:10]) if len(s) else ("-", "-")

        yield {
            "fold": k,
            "scaler": sc,
            "train": build(0, train_end, train_step),  # subsample TRAIN only
            "val": build(val_start, test_start),       # val/test stay step=1 (honest)
            "test": build(test_start, test_end),
            "test_time": times[sl(test_start, test_end)][seq - 1:],
            "dates": {"train": daterange(0, train_end),
                      "val": daterange(val_start, test_start),
                      "test": daterange(test_start, test_end)},
        }
