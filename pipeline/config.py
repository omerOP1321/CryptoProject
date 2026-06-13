"""
Central configuration for the redesigned forecasting pipeline.

This pipeline is the staged successor to the live %B models. It is intentionally
kept SEPARATE from the production artifacts (best_lstm_model_*.pth, etc.) so the
currently-deployed engine is untouched until you deliberately promote new models.

Key design changes vs. the legacy pipeline (see audit_report.md):
  * Target is the H-step log-return, not next-step Bollinger %B.
  * A classification head (UP / FLAT / DOWN with a volatility dead-band) is
    trained jointly with the return regressor, so the model optimizes the thing
    we actually deploy (price direction).
  * Order-flow features (taker buy/sell imbalance, trade intensity/size) that
    were already collected but unused are added.
  * Volume / order-flow normalization is CAUSAL (rolling), removing the global
    look-ahead leakage in the legacy preprocessing.
  * Walk-forward (rolling-origin) validation replaces the single chronological
    split, giving an honest out-of-sample estimate.
"""

import os

BASE_DIR = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
DATA_DIR = os.path.join(BASE_DIR, "data")
# Staged artifacts go here, NOT in models/, so production is never overwritten.
OUT_DIR = os.path.join(BASE_DIR, "models_v2")

SYMBOLS = ["BTCUSDT", "ETHUSDT", "XRPUSDT"]

CONFIG = {
    # --- target / horizon ---
    "horizon": 1,          # candles ahead (1=5m, 3=15m, 6=30m, 12=60m). Sweep this.
    "seq_length": 60,      # input window length (candles)
    "deadband_k": 0.33,    # FLAT if |return| < deadband_k * rolling return-vol
    "vol_window": 288,     # ~1 day of 5m candles, for causal vol / normalization
    # --- training ---
    "batch_size": 128,
    "epochs": 50,
    "patience": 6,
    "lr": 1e-3,
    "weight_decay": 1e-4,
    "cls_loss_weight": 1.0,   # weight of classification loss vs. regression (Huber)
    "dropout": 0.2,
    # --- model sizes ---
    "lstm_hidden": 64,
    "tft_d_model": 32,
    "tft_heads": 4,
    "tft_layers": 2,
    # --- walk-forward ---
    "wf_folds": 5,         # number of rolling test folds
    "wf_test_frac": 0.10,  # each test fold = this fraction of the series
    "wf_val_frac": 0.10,   # validation block right before each test fold
    # --- smoke test (tiny run on local cached CSV to prove the code executes) ---
    "smoke": False,
}

# Base + order-flow feature set. Order-flow block is the new, previously-unused
# information. Everything is causal (no future leakage).
FEATURES = [
    "log_ret", "rsi", "rsi_change", "rsi_accel",
    "macd", "macd_slope", "bb_pband_change", "ma_dist",
    "volume_z", "vol_spike", "adx",
    "hour_sin", "hour_cos", "mom_3", "mom_5",
    # --- order flow (NEW) ---
    "taker_buy_imb",   # 2*taker_buy_frac - 1  in [-1,1]; >0 = aggressive buying
    "trade_intensity", # causal z-score of log(number_of_trades)
    "trade_size",      # causal z-score of log(quote_volume / number_of_trades)
]

CLASS_NAMES = ["DOWN", "FLAT", "UP"]  # indices 0,1,2
