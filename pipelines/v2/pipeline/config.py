"""
Central configuration for the redesigned forecasting pipeline.

This pipeline is the staged successor to the live %B models. It is intentionally
kept SEPARATE from the production artifacts (best_lstm_model_*.pth, etc.) so the
currently-deployed engine is untouched until you deliberately promote new models.

Key design changes vs. the legacy pipeline (see docs/audit_report.md):
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

# pipelines/v2/pipeline/ -> repo root is three levels up
BASE_DIR = os.path.abspath(os.path.join(os.path.dirname(__file__), "..", "..", ".."))
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
    # --- fast-experiment knobs (cut run time when you're only checking direction) ---
    "max_rows": None,      # cap to most recent N candles (None = full history). e.g. 150000 ~ last ~1.4yr
    "train_step": 1,       # stride for TRAINING windows (1=all; 4 => 4x fewer train samples, val/test stay 1)
    "pred_batch": 4096,    # batch size for inference (fixes the seq_length=120 OOM)
    # --- feature set ---
    "use_extra_features": False,  # True => add the FEATURES_EXTRA block (volatility / order-flow / MTF)
    "use_onchain": False,         # True => add FEATURES_ONCHAIN (daily on-chain, leakage-safe +1d shift)
    "auto_select": False,         # True => Boruta feature selection runs INSIDE run() (train region only)
    # --- smoke test (tiny run on local cached CSV to prove the code executes) ---
    "smoke": False,
}

# Base + order-flow feature set. Everything is causal (no future leakage).
FEATURES_BASE = [
    "log_ret", "rsi", "rsi_change", "rsi_accel",
    "macd", "macd_slope", "bb_pband_change", "ma_dist",
    "volume_z", "vol_spike", "adx",
    "hour_sin", "hour_cos", "mom_3", "mom_5",
    # --- order flow ---
    "taker_buy_imb",   # 2*taker_buy_frac - 1  in [-1,1]; >0 = aggressive buying
    "trade_intensity", # causal z-score of log(number_of_trades)
    "trade_size",      # causal z-score of log(quote_volume / number_of_trades)
]

# Optional extra block (enabled via cfg['use_extra_features']) — volatility,
# sustained order-flow, multi-timeframe trend, candle geometry. The lever to
# test whether richer features help (audit improvement #6). All causal.
FEATURES_EXTRA = [
    "rv",          # realized vol (1h rolling std of log_ret), causal z-scored
    "atr_pct",     # ATR(14) / close * 100
    "buy_imb_ma",  # sustained taker-buy imbalance (rolling mean)
    "cvd_z",       # cumulative volume delta over a window, causal z-scored
    "trend_mtf",   # multi-timeframe trend: (EMA12 - EMA48)/close
    "range_pos",   # where close sits in the candle range [0,1]
    "dist_hi20",   # distance to 20-bar high (breakout proximity)
    "dist_lo20",   # distance to 20-bar low
]

# Optional on-chain block (enabled via cfg['use_onchain']). Daily blockchain
# metrics from CoinMetrics (see fetch_onchain.py), aligned to the 5m grid with a
# +1-day shift so a day's metric is only used AFTER it closes (no look-ahead).
# This is the only input family carrying signal INDEPENDENT of price/technicals,
# hence the last untried lever after the horizon/coin/feature grid stalled at ~52%.
FEATURES_ONCHAIN = [
    "onch_adr_z",    # causal z-score (90d) of log(active addresses)
    "onch_adr_chg",  # 7-day log-change of active addresses (network growth)
    "onch_tx_z",     # causal z-score (90d) of log(transaction count)
    "onch_nvt_z",    # causal z-score (90d) of NVT = market_cap / transfer_value
]

# Backward-compatible default (the base set).
FEATURES = FEATURES_BASE

def feature_list(cfg):
    """The feature columns a run uses. If cfg['selected_features'] is set (by the
    Boruta feature-selection stage), that explicit subset wins. Otherwise the set
    is built from the base block + cfg['use_extra_features'] + cfg['use_onchain'].
    """
    if cfg.get("selected_features"):
        return list(cfg["selected_features"])
    feats = list(FEATURES_BASE)
    if cfg.get("use_extra_features"):
        feats += FEATURES_EXTRA
    if cfg.get("use_onchain"):
        feats += FEATURES_ONCHAIN
    return feats

CLASS_NAMES = ["DOWN", "FLAT", "UP"]  # indices 0,1,2
