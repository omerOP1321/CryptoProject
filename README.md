# Binance Bitcoin Prediction Project

The main objective of this project is to build a full machine-learning pipeline that predicts future cryptocurrency prices (starting with Bitcoin).
The project begins with a reliable data-collection layer from the Binance API, and will include preprocessing, feature engineering (technical indicators), 
model training (LSTM / TFT Transformer / ARIMA), evaluation, and a live forecasting module.
---
## 📌 Features 
* Fetches historical candlestick (kline) data from Binance.
* Supports configurable symbol and interval (e.g., `BTCUSDT`, `5m`).
* Handles Binance API rate limits with retries.
* Uses automatic pagination in chunks of 1000 rows.
* Converts timestamps into `datetime`.
* Converts numeric columns to proper numeric types.
* Removes overlapping candles (duplicate timestamps).
* Saves final data as a CSV inside the `data/` directory.
---
## 📁 Project Structure 
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
## 📊 Data Collection 
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
## 🧼 Data Cleaning 
The loader applies minimal, safe cleaning:
* Duplicate candle removal (overlaps returned by Binance)
* Sorting candles by time
* Numeric type conversion
* Optional detection of missing candles (printed only)
Real price spikes are **not removed**, as they represent legitimate market behavior.
---
## 📦 Output 
Each row in the CSV contains:
* `open_time`, `close_time`
* `open`, `high`, `low`, `close`, `volume`
* `quote_asset_volume`
* `number_of_trades`
* `taker_buy_base_asset_volume`
* `taker_buy_quote_asset_volume`
---
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

- Sequence Length: `60`
- Prediction Horizon: `1 step ahead` (one 5-minute candle)
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
## 🧠 Model Training 
MODEL TRAINING
📁 Data Pipeline
Historical crypto OHLCV data (e.g. BTCUSDT / XRPUSDT)
Converted into supervised sequences using sliding windows:
X → past time-series window (samples × sequence × features)
y → target value (normalized indicator or future proxy)
Feature scaling is applied using StandardScaler for stable convergence.
🧠 Models
🔹 LSTM Model

A sequential neural network designed for time-series forecasting:

Stacked LSTM layers (e.g. 128 hidden units)
Fully connected regression head
Dropout regularization
Outputs single-step prediction
🔹 TFT (Temporal Fusion Transformer)

A hybrid attention-based architecture:

Variable Selection Network (VSN)
Dynamically selects important features per timestep
Positional Encoding
Injects temporal order information
Transformer Encoder
Captures long-range dependencies in price action
Final output: single regression value per sequence
⚙️ Training Setup
Optimizer: AdamW
Scheduler: ReduceLROnPlateau
Batch size: 16–64
Epochs: 25–30
Regularization: Dropout + Weight decay
📉 Loss Functions
LSTM
Directional Log-Cosh Loss
Penalizes:
Prediction error magnitude
Wrong market direction
TFT
Huber Loss
Robust to noise and outliers in financial time-series
🧪 Training Behavior
Models trained on rolling time windows
Validation loss monitored each epoch
Best checkpoint saved automatically
Early stopping used for LSTM (when applicable)

---
## 📈 Model Evaluation 🔍 Prediction Process
Model outputs normalized regression values (e.g. %B)
Predictions are mapped back to price space using Bollinger Bands:
Price = Lower Band + Prediction × (Upper Band - Lower Band)
📊 Metrics
RMSE

Measures average prediction error magnitude:

Lower = better fit
Evaluates regression accuracy
Directional Accuracy

Evaluates correctness of market direction:

Focuses on significant price movements
Example result: ~60% accuracy on strong moves
📈 Visualization
Candlestick charts (mplfinance)
Actual price movement
Predicted trend overlay
Training curves:
Train vs Validation loss
Prediction comparison:
Actual vs Predicted time series
⚠️ Key Observations
LSTM:
Stable but limited predictive power
Moderate directional accuracy
TFT:
More expressive architecture
Slightly more stable validation behavior
Still limited by noisy financial targets
🚀 Future Improvements
Predict log-returns instead of %B
Use trading-based loss (PnL optimization)
Add attention visualization for TFT
Convert pipeline into full backtesting engine

---
## 🔍 Inference / Prediction
After training, the model is used to generate predictions on unseen test data.

The inference pipeline includes:

Loading the best saved model checkpoint
Switching the model to evaluation mode (model.eval())
Running forward passes without gradient computation (torch.no_grad())
📤 Prediction Flow
LSTM / TFT Output
The model outputs a continuous normalized value
Example: Bollinger %B (0 → 1 range)
Reconstruction to Price Space

Predictions are converted back into actual price values using Bollinger Bands:

Predicted Price = Lower Band + Prediction × (Upper Band - Lower Band)

This allows direct comparison with real market prices.

⚡ Batch Inference
Predictions are generated in batches to improve efficiency
Processed sequentially over the test dataset
Final output is a full time-series prediction aligned with timestamps
📊 Output Usage

The predictions are used for:

Price comparison plots (Actual vs Predicted)
Trading signal analysis
Directional accuracy evaluation
Strategy backtesting (optional extension)

---
## 💾 Model Saving & Loading 
Model Saving

During training, the best-performing model is automatically saved based on validation loss.

Saving Logic:
The model is saved whenever validation loss improves
Only the best checkpoint is kept
File Format:
.pth (PyTorch state_dict)
Example:
LSTM:
best_lstm_model_XRPUSDT.pth
TFT:
best_tft_vsn_BTCUSDT.pth
📦 What is Saved

Only the model weights (state_dict) are stored:

Model parameters
Learned weights and biases

Not saved:

Optimizer state (unless extended)
Training history
Scalers (must be handled separately if needed)
📥 Model Loading
Steps:
Recreate model architecture
Load saved weights
Switch to evaluation mode
Example:
model = TFTModel(...)
model.load_state_dict(torch.load(model_path))
model.eval()
⚠️ Important Notes
Architecture must be identical to training time
Model must be on same device (CPU/GPU) or moved accordingly
Missing scaler or preprocessing logic can break inference consistency
🚀 Best Practice (Recommended Upgrade)

To make inference fully production-ready, also save:

Feature scaler (StandardScaler)
Feature configuration
Sequence length
Training metadata (symbol, timeframe)

---
## 📉 Live Forecasting Script 
This project includes a real-time forecasting dashboard that visualizes AI predictions and market data using a web-based interface connected to a backend prediction engine via Supabase.

The forecasting system bridges the trained models (LSTM + Transformer) with a live UI for monitoring predictions in real time.

🔹 System Overview

The forecasting pipeline consists of:

A Python inference engine (Colab / backend) that:
Loads trained models (.pth files)
Generates predictions on latest market windows
Converts normalized outputs back into price estimates
Sends results to Supabase in structured JSON format
A web-based dashboard (HTML + JavaScript) that:
Fetches live prediction payloads from Supabase
Displays last price, predicted price, and expected change
Shows model comparison (LSTM vs Transformer)
Renders historical price + predictions on an interactive chart
🔹 Backend → Frontend Data Flow

The backend continuously updates a Supabase table:

Table: predictions

Each payload includes:

last_price → current market price
chosen_model → best performing model at runtime
predictions:
LSTM prediction
Transformer prediction
change_pct → expected percentage change
history → price history per timeframe (5m / 1h / 1d)
pred_history → historical model predictions for chart overlay
🔹 Frontend Dashboard Features

The dashboard (index.html) provides:

📊 Real-Time Metrics
Last market price
AI predicted price
Expected percentage change
Trading signal classification:
LONG (bullish move > +0.1%)
SHORT (bearish move < -0.1%)
NEUTRAL (no strong signal)
📈 Interactive Chart

Built with Chart.js, the visualization includes:

Market price history line
LSTM prediction history (dashed line)
Transformer prediction history (dashed line)
“NEXT” projected price point

Supports multiple resolutions:

5m (high-frequency view)
1h (medium-term view)
1d (long-term trend view)
🔄 Live Updates
Polls Supabase every 30 seconds
Automatically updates:
Metrics panel
Chart rendering
Latest prediction snapshot
Scrollable chart for historical context
🔹 UI Architecture
Frontend stack:
HTML5 + CSS3 (dark trading UI theme)
Vanilla JavaScript
Chart.js for visualization
Supabase JS client for real-time data fetching
Backend integration:
Supabase Realtime Database (polling-based)
Python inference engine pushes updates
🔹 Key Logic (Simplified Flow)
Fetch latest prediction payload from Supabase
Extract:
Market price
Model predictions
Historical series
Update UI metrics
Rebuild chart datasets
Render updated visualization
Repeat every 30 seconds
🔹 Signal Logic

Trading signal is derived from predicted percentage change:

change_pct > 0.1% → LONG 🟢
change_pct < -0.1% → SHORT 🔴
otherwise → NEUTRAL ⚪
🔹 Purpose

This script enables:

Live monitoring of AI trading models
Comparison between LSTM and Transformer forecasts
Visual validation of model behavior in real market conditions
Demonstration of end-to-end ML pipeline (training → inference → UI)

---
## 🧪 Backtesting 
In this project, backtesting is implemented as an evaluation process on historical test data to simulate model performance on unseen market sequences.

The trained models (LSTM and Transformer) are tested on a held-out dataset representing past market data, preserving chronological order.

🔹 Evaluation Process
The model is evaluated on the test set only
No shuffling is applied to preserve time order
Each prediction is generated based on previous sequence windows
Predictions are compared directly to actual market values
🔹 Price Reconstruction

Since the model predicts a normalized target (e.g. Bollinger %B), the final price is reconstructed using:

Bollinger Bands (upper and lower bounds)
Scaling predicted values back into price domain

This allows comparison between:

Actual closing prices
Predicted reconstructed prices
🔹 Outputs

The backtesting process produces:

RMSE (Root Mean Squared Error) on test set
Directional accuracy on significant price movements (when applicable)
Visual comparison plots:
Actual vs predicted price
Candlestick chart with prediction overlay
Training vs validation loss curves (for model stability analysis)
🔹 Purpose

This backtesting approach is used to:

Evaluate model performance on unseen historical data
Validate prediction quality before deployment
Compare LSTM and Transformer models under identical conditions
🔹 Key Constraint
The evaluation strictly uses historical data only
No future information is used during prediction
Same preprocessing pipeline is applied as in training

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

This project is built in Python and relies on deep learning, time-series processing, and technical analysis libraries.

🔹 Core Dependencies
torch – Deep learning framework for LSTM and Transformer models
numpy – Numerical computations and array manipulation
pandas – Data loading and preprocessing of OHLCV data
scikit-learn – Feature scaling and evaluation metrics (e.g. RMSE)
matplotlib – Plotting training curves and prediction results
mplfinance – Candlestick chart visualization
ta – Technical indicators (e.g. Bollinger Bands)
🔹 Full Installation Command
pip install torch ta mplfinance scikit-learn matplotlib pandas numpy
🔹 Optional Environment Support
Google Colab (recommended for GPU training)
Used for model training and evaluation
Supports Google Drive mounting for saving models and datasets
🔹 Hardware Requirements
Minimum:
Python 3.9+
8GB RAM
CPU-only execution possible (slower)
Recommended:
NVIDIA GPU (CUDA support)
Google Colab Pro / local GPU machine for faster training
🔹 Data Requirements

The project expects preprocessed datasets stored as .npy files:

X_train.npy, y_train.npy
X_val.npy, y_val.npy
X_test.npy, y_test.npy

And raw market data:

*_5m_data.csv containing OHLCV candles
---
