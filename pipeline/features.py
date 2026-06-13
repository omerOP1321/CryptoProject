"""
Feature engineering — single source of truth for BOTH training and inference.

Every transform here is CAUSAL: a feature at time t uses only data up to and
including t. The legacy pipeline normalized volume with a global mean/std over
the whole series (including the test period) — that look-ahead leakage is fixed
here by using rolling statistics.
"""

import numpy as np
import pandas as pd
import ta

from .config import CONFIG

EPS = 1e-9


def _causal_z(series: pd.Series, window: int) -> pd.Series:
    """Rolling z-score using only past+current values (no future leakage)."""
    mean = series.rolling(window, min_periods=window // 4).mean()
    std = series.rolling(window, min_periods=window // 4).std()
    return (series - mean) / (std + EPS)


def compute_features(df: pd.DataFrame, vol_window: int = None) -> pd.DataFrame:
    """Add all model features + Bollinger bands (kept for reference/plots).
    Expects raw OHLCV + order-flow columns from the Binance kline CSV."""
    vol_window = vol_window or CONFIG["vol_window"]
    df = df.copy()
    df["open_time"] = pd.to_datetime(df["open_time"])
    df = df.sort_values("open_time").drop_duplicates("open_time").reset_index(drop=True)

    c = df["close"]
    df["log_ret"] = np.log(c / c.shift(1))

    df["rsi"] = ta.momentum.rsi(c, window=14) / 100.0
    df["rsi_change"] = df["rsi"].diff(3)
    df["rsi_accel"] = df["rsi_change"].diff(2)

    macd = ta.trend.MACD(c)
    macd_raw = macd.macd_diff()
    df["macd"] = (macd_raw - macd_raw.rolling(100).mean()) / (macd_raw.rolling(100).std() + EPS)
    df["macd_slope"] = macd.macd_diff().diff(2)

    bb = ta.volatility.BollingerBands(c, window=20, window_dev=2)
    df["bb_pband"] = bb.bollinger_pband()
    df["bb_pband_change"] = df["bb_pband"].diff(1)
    df["bb_hband"] = bb.bollinger_hband()
    df["bb_lband"] = bb.bollinger_lband()

    df["ma_20"] = c.rolling(20).mean()
    df["ma_dist"] = (c - df["ma_20"]) / (df["ma_20"] + EPS) * 10.0

    # --- Volume (CAUSAL z-score, was global-leaky before) ---
    log_vol = np.log(df["volume"] + 1)
    df["volume_z"] = _causal_z(log_vol, vol_window)
    vol_ma = log_vol.rolling(20).mean()
    df["vol_spike"] = (log_vol > (vol_ma * 2)).astype(float)

    adx = ta.trend.ADXIndicator(df["high"], df["low"], c, window=14)
    df["adx"] = adx.adx()

    hour = df["open_time"].dt.hour
    df["hour_sin"] = np.sin(2 * np.pi * hour / 24)
    df["hour_cos"] = np.cos(2 * np.pi * hour / 24)

    df["mom_3"] = c / c.shift(3) - 1
    df["mom_5"] = c / c.shift(5) - 1

    # --- Order-flow features (NEW: previously collected but unused) ---
    taker_buy = df.get("taker_buy_base_asset_volume")
    if taker_buy is not None:
        taker_buy = pd.to_numeric(taker_buy, errors="coerce")
        buy_frac = (taker_buy / (df["volume"] + EPS)).clip(0, 1)
        df["taker_buy_imb"] = 2 * buy_frac - 1.0          # [-1,1]
    else:
        df["taker_buy_imb"] = 0.0

    n_trades = pd.to_numeric(df.get("number_of_trades", np.nan), errors="coerce")
    df["trade_intensity"] = _causal_z(np.log(n_trades + 1), vol_window)

    quote_vol = pd.to_numeric(df.get("quote_asset_volume", np.nan), errors="coerce")
    avg_trade = np.log(quote_vol / (n_trades + EPS) + 1)
    df["trade_size"] = _causal_z(avg_trade, vol_window)

    # --- Extra features (used only when cfg['use_extra_features']; always computed
    #     here so inference can select whatever a model's meta lists). All causal. ---
    df["rv"] = _causal_z(df["log_ret"].rolling(12).std(), vol_window)
    tr = pd.concat([(df["high"] - df["low"]),
                    (df["high"] - c.shift()).abs(),
                    (df["low"] - c.shift()).abs()], axis=1).max(axis=1)
    df["atr_pct"] = (tr.rolling(14).mean() / (c + EPS)) * 100
    df["buy_imb_ma"] = df["taker_buy_imb"].rolling(12).mean()
    signed_vol = df["taker_buy_imb"] * np.log(df["volume"] + 1)
    df["cvd_z"] = _causal_z(signed_vol.rolling(48).sum(), vol_window)
    ema_f = c.ewm(span=12, adjust=False).mean()
    ema_s = c.ewm(span=48, adjust=False).mean()
    df["trend_mtf"] = (ema_f - ema_s) / (c + EPS) * 100
    rng = (df["high"] - df["low"])
    df["range_pos"] = ((c - df["low"]) / (rng + EPS)).clip(0, 1)
    df["dist_hi20"] = (c - df["high"].rolling(20).max()) / (c + EPS) * 100
    df["dist_lo20"] = (c - df["low"].rolling(20).min()) / (c + EPS) * 100

    return df


def make_targets(df: pd.DataFrame, horizon: int, deadband_k: float,
                 vol_window: int) -> pd.DataFrame:
    """Add the regression target (H-step log-return) and the 3-class label.

    target_ret  = log(close[t+H] / close[t])
    label       = UP   if ret >  +k*sigma_t
                  DOWN if ret <  -k*sigma_t
                  FLAT otherwise
    where sigma_t is a CAUSAL rolling std of 1-step log-returns scaled to the
    horizon (sqrt-time). The dead-band prevents the model from being graded on
    microscopic, untradeable moves.
    """
    df = df.copy()
    fwd_ret = np.log(df["close"].shift(-horizon) / df["close"])
    df["target_ret"] = fwd_ret

    sigma1 = df["log_ret"].rolling(vol_window, min_periods=vol_window // 4).std()
    sigma_h = sigma1 * np.sqrt(horizon)
    thr = deadband_k * sigma_h

    label = np.full(len(df), 1, dtype=float)  # FLAT
    label[fwd_ret > thr] = 2                   # UP
    label[fwd_ret < -thr] = 0                  # DOWN
    label[fwd_ret.isna() | thr.isna()] = np.nan
    df["target_cls"] = label
    return df
