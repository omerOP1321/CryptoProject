"""
Inference for the staged v2 (return + direction) models.

Produces a prediction in the SAME shape the live engine pushes to Supabase, so
swapping it into inference_orchestrator is mechanical once you've validated the
new models. Reconstruction is return-based (price = base * exp(pred_ret)), not
the legacy Bollinger-band mapping, and the trading signal comes from the
classifier (with a FLAT/abstain class) instead of a hand-tuned 0.1% threshold.

Load order mirrors training: same features, same seq_length, same scaler.
"""

import os
import json
import numpy as np
import torch

from .config import OUT_DIR, CLASS_NAMES
from .features import compute_features
from .models import LSTMDual, TFTDual

DEVICE = torch.device("cuda" if torch.cuda.is_available() else "cpu")


def load_model(model_type: str, symbol: str):
    tag = f"{model_type}_{symbol}"
    meta = json.load(open(os.path.join(OUT_DIR, f"meta_{tag}.json")))
    import joblib
    scaler = joblib.load(os.path.join(OUT_DIR, f"scaler_{tag}.pkl"))
    n_feat = len(meta["features"])
    if model_type == "lstm":
        model = LSTMDual(n_feat)
    else:
        model = TFTDual(n_feat)
    model.load_state_dict(torch.load(os.path.join(OUT_DIR, f"v2_{tag}.pth"), map_location=DEVICE))
    model.to(DEVICE).eval()
    return model, scaler, meta


def predict(df_raw, model, scaler, meta):
    """df_raw: recent OHLCV+order-flow candles (>= seq_length+warmup rows).
    Returns a production-style dict for one model."""
    feats = meta["features"]
    seq = meta["seq_length"]
    df = compute_features(df_raw).dropna()
    if len(df) < seq:
        return None
    base_price = float(df["close"].iloc[-1])
    window = scaler.transform(df[feats].tail(seq).values)
    x = torch.tensor(window, dtype=torch.float32).unsqueeze(0).to(DEVICE)
    with torch.no_grad():
        pred_ret, logits = model(x)
    pred_ret = float(pred_ret.item())
    probs = torch.softmax(logits, -1).cpu().numpy().ravel()
    cls = int(probs.argmax())
    signal = {0: "SHORT", 1: "NEUTRAL", 2: "LONG"}[cls]
    pred_price = base_price * np.exp(pred_ret)
    return {
        "val": pred_ret,
        "price": float(pred_price),
        "change_pct": (np.exp(pred_ret) - 1) * 100,
        "signal": signal,
        "class_probs": {CLASS_NAMES[i]: float(probs[i]) for i in range(len(CLASS_NAMES))},
        "horizon_min": meta["horizon"] * 5,
    }


if __name__ == "__main__":
    # quick local check against cached CSV
    import pandas as pd
    from .config import DATA_DIR
    for sym in ["BTCUSDT", "ETHUSDT", "XRPUSDT"]:
        for mt in ["lstm", "tft"]:
            try:
                m, sc, meta = load_model(mt, sym)
            except FileNotFoundError:
                continue
            df = pd.read_csv(os.path.join(DATA_DIR, f"{sym}_5m_data.csv"))
            out = predict(df, m, sc, meta)
            print(f"{sym} {mt}: {out['signal']:7s} change={out['change_pct']:+.3f}% "
                  f"probs={out['class_probs']} h={out['horizon_min']}m")
