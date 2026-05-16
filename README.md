# Binance Bitcoin Prediction Project

The main objective of this project is to build a full machine-learning pipeline that predicts future cryptocurrency prices (starting with Bitcoin).
The project begins with a reliable data-collection layer from the Binance API, and will include preprocessing, feature engineering (technical indicators), 
model training (LSTM/Random Forest Regressor,XGBoost Regressor),evaluation, and a live forecasting module.
---
## 📌 Features (Current)
* Fetches historical candlestick (kline) data from Binance.
* Supports configurable symbol and interval (e.g., `BTCUSDT`, `5m`).
* Handles Binance API rate limits with retries.
* Uses automatic pagination in chunks of 1000 rows.
* Converts timestamps into `datetime`.
* Converts numeric columns to proper numeric types.
* Removes overlapping candles (duplicate timestamps).
* Saves final data as a CSV inside the `data/` directory.
---
## 📁 Project Structure (Current & Future)
```
project/
│
├── data/                         # Stored CSV output
├── src/
│   ├── data_loader.py            # BinanceDataLoader (current)
│   ├── preprocessing.py          # (future)
│   ├── feature_engineering.py    # (future)
│   ├── model_training.py         # (future)
│   ├── inference.py              # (future)
│   └── utils/                    # Helpers (future)
│
└── README.md
```
---
## 📊 Data Collection (Current)
Example usage:
```python
from data_loader import BinanceDataLoader

loader = BinanceDataLoader(symbol="BTCUSDT", interval="5m")
df = loader.fetch_history(start_str="2017-09-09")
```
The script will download all kline data from the specified start date until now and save it under:
```
data/BTCUSDT_5m_data.csv
```
---
## 🧼 Data Cleaning (Current)
The loader applies minimal, safe cleaning:
* Duplicate candle removal (overlaps returned by Binance)
* Sorting candles by time
* Numeric type conversion
* Optional detection of missing candles (printed only)
Real price spikes are **not removed**, as they represent legitimate market behavior.
---
## 📦 Output (Current)
Each row in the CSV contains:
* `open_time`, `close_time`
* `open`, `high`, `low`, `close`, `volume`
* `quote_asset_volume`
* `number_of_trades`
* `taker_buy_base_asset_volume`
* `taker_buy_quote_asset_volume`
---
# 🔮 **Future Sections (Empty for now)**

## 🧹 Data Preprocessing

The preprocessing pipeline performs multiple cleaning and preparation steps on historical Binance BTCUSDT 5-minute candle data before feeding it into deep learning models.

### Preprocessing Steps

- Loaded historical OHLCV cryptocurrency data from CSV files
- Converted timestamps into chronological datetime format
- Sorted candles by time order
- Removed duplicate timestamps
- Forward-filled missing values and removed remaining NaNs
- Created train / validation / test splits using chronological order
- Applied feature normalization using `StandardScaler`
- Generated sliding-window sequences for sequential deep learning models

### Sequence Generation

The model uses fixed-length sliding windows for time-series forecasting:

- Sequence Length: `120`
- Prediction Horizon: `1 step ahead`
- Sliding Window Step Size: `5`

Generated datasets:
- `X_train`, `y_train`
- `X_val`, `y_val`
- `X_test`, `y_test`

The processed datasets are saved as NumPy arrays for efficient loading during model training.

---

## ⚙️ Feature Engineering

The project uses a combination of statistical, momentum, volatility, trend, volume, and cyclical time-based features designed for cryptocurrency forecasting.

### Engineered Features

#### 📈 Price & Momentum Features
- Log Returns (`log_ret`)
- Lagged Returns
- RSI (Relative Strength Index)
- RSI Momentum (`rsi_change`)
- RSI Acceleration (`rsi_accel`)

#### 📊 Trend Features
- MACD
- MACD Slope
- Moving Average Distance (`ma_dist`)
- ADX Trend Strength Indicator

#### 📉 Volatility Features
- Bollinger Band Percentage (`bb_pband`)
- Bollinger Band Percentage Change (`bb_pband_change`)

#### 📦 Volume Features
- Log-scaled Volume
- Volume Z-Score (`volume_z`)
- Volume Spike Detection (`vol_spike`)

#### 🕒 Time Encoding Features
To help transformer-based architectures learn periodic market behavior:

- Hour Sine Encoding (`hour_sin`)
- Hour Cosine Encoding (`hour_cos`)

### Target Generation

The prediction target is based on future Bollinger Band behavior:
- Future smoothed Bollinger Percentage Band values
- Multi-step shifted forecasting targets

This allows the model to learn short-term future market movement patterns rather than raw prices directly.

---

## 📊 Dataset Information

- Asset: `BTCUSDT`
- Timeframe: `5-minute candles`
- Total Processed Rows: `~909,000`
- Total Features: `14`

### Final Dataset Shapes

#### LSTM Dataset
- `X_train`: `(145523, 120, 14)`
- `X_test`: `(18170, 120, 14)`

The final tensors are optimized for sequence-based deep learning architectures such as:
- LSTM
- Transformer
- Temporal Fusion Transformer (TFT)

## ⚙️ Feature Engineering (Future)
* RSI
* MACD
* Bollinger Bands
* ADX
* volume features
* cyclical time encoding
* momentum features
* lagged returns
* moving average distance
---
## 🧠 Model Training (Future)
*(To be added later)*
---
## 📈 Model Evaluation (Future)
*(To be added later)*
---
## 🔍 Inference / Prediction (Future)
*(To be added later)*
---
## 💾 Model Saving & Loading (Future)
*(To be added later)*
---
## 📉 Live Forecasting Script (Future)
*(To be added later)*
---
## 🧪 Backtesting (Future)
*(To be added later)*
---
## 🛠️ Requirements
```
pandas
requests
```
Install with:
```bash
pip install pandas/ requests --no-warn-script-location
```
---
