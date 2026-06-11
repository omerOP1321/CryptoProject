#!/usr/bin/env python
# coding: utf-8

# In[1]:


import os
import json
from getpass import getpass

# --- Supabase & Drive Setup ---
try:
    from google.colab import drive
    drive.mount('/content/drive')
    BASE_DIR = '/content/drive/MyDrive/CryptoProject'
except ImportError:
    BASE_DIR = os.path.dirname(os.path.abspath(__file__)) if '__file__' in globals() else os.getcwd()

os.makedirs(BASE_DIR, exist_ok=True)
CREDS_FILE = os.path.join(BASE_DIR, 'supabase_creds.json')

if not os.path.exists(CREDS_FILE):
    print("Supabase credentials not found. Let's set them up.")
    print("Get these from Supabase Dashboard -> Project Settings -> API")
    url = input("Enter Supabase Project URL: ").strip()
    key = getpass("Enter Supabase SERVICE_ROLE Key (for Python backend): ").strip()
    with open(CREDS_FILE, 'w') as f:
        json.dump({'url': url, 'key': key}, f)
    print(f"\n✅ Saved credentials to {CREDS_FILE}. Your colleagues can run this and enter their own keys without changing the code!")
else:
    print(f"✅ Supabase credentials found at {CREDS_FILE}")

# Install requirements
try:
    get_ipython().run_line_magic('pip', 'install ta supabase')
except NameError:
    pass


# In[2]:


import os
import sys
import time
import json
import requests
import signal
import warnings
import io
from supabase import create_client, Client
import pandas as pd
import numpy as np
import torch
import torch.nn as nn
import ta
import math
from datetime import datetime
from sklearn.preprocessing import StandardScaler
from statsmodels.tsa.arima.model import ARIMA

# Google Drive API Client imports
try:
    from googleapiclient.discovery import build
    from googleapiclient.http import MediaIoBaseDownload
    from google_auth_oauthlib.flow import InstalledAppFlow
    from google.auth.transport.requests import Request
    from google.oauth2.credentials import Credentials
except ImportError:
    pass

# --- 1. Cloud & Path Configuration ---
try:
    from google.colab import drive
    drive.mount('/content/drive')
    DRIVE_BASE_DIR = '/content/drive/MyDrive/CryptoProject'
    print("✅ Running in Google Colab (Drive Mounted).")
except ImportError:
    try:
        DRIVE_BASE_DIR = os.path.dirname(os.path.abspath(__file__))
    except NameError:
        DRIVE_BASE_DIR = os.getcwd()
    print(f"✅ Running locally. Base directory: {DRIVE_BASE_DIR}")

# GPU Configuration
DEVICE = torch.device("cuda" if torch.cuda.is_available() else "cpu")
print(f"✅ Utilizing Compute Device: {DEVICE}")

# File Paths
MODEL_DIR = os.path.join(DRIVE_BASE_DIR, 'models')
DATA_DIR = os.path.join(DRIVE_BASE_DIR, 'data')

# Supabase Configuration
CREDS_FILE = os.path.join(DRIVE_BASE_DIR, 'supabase_creds.json')
os.makedirs(DATA_DIR, exist_ok=True)

if os.path.exists(CREDS_FILE):
    with open(CREDS_FILE, 'r') as f:
        creds = json.load(f)
    supabase: Client = create_client(creds['url'], creds['key'])
else:
    print(f"⚠️ WARNING: {CREDS_FILE} not found. Will not push to database.")
    supabase = None

# --- Constants ---
COINS = [
    ('BTCUSDT', 1),
    ('ETHUSDT', 2),
    ('XRPUSDT', 3)
]
INTERVAL = '5m'
SEQ_LENGTH = 60  # must match training (preprocessing notebooks use SEQ_LENGTH = 60)
BASE_URL = "https://api.binance.com/api/v3/klines"

# --- 2. Model Architectures ---

class LSTMModel(nn.Module):
    def __init__(self, input_size, hidden_size=128, num_layers=2, dropout=0.1):
        super(LSTMModel, self).__init__()
        self.hidden_dim = hidden_size
        self.num_layers = num_layers
        self.lstm = nn.LSTM(input_size, hidden_size, num_layers, batch_first=True, dropout=dropout)
        self.fc = nn.Linear(hidden_size, 1)

    def forward(self, x):
        h0 = torch.zeros(self.num_layers, x.size(0), self.hidden_dim).to(x.device)
        c0 = torch.zeros(self.num_layers, x.size(0), self.hidden_dim).to(x.device)
        out, _ = self.lstm(x, (h0, c0))
        out = self.fc(out[:, -1, :])
        return out

class Attention(nn.Module):
    def __init__(self, hidden_dim):
        super(Attention, self).__init__()
        self.attention = nn.Linear(hidden_dim, 1, bias=False)

    def forward(self, lstm_out):
        import torch.nn.functional as F
        attn_weights = F.softmax(self.attention(lstm_out), dim=1)
        context = torch.sum(attn_weights * lstm_out, dim=1)
        return context, attn_weights

class LSTMModel_ETH(nn.Module):
    def __init__(self, input_size, hidden_size=64, num_layers=2, dropout=0.1):
        super(LSTMModel_ETH, self).__init__()
        self.hidden_dim = hidden_size
        self.num_layers = num_layers
        self.lstm = nn.LSTM(input_size, hidden_size, num_layers, batch_first=True, dropout=dropout)
        self.attention = Attention(hidden_dim=hidden_size)
        self.fc1 = nn.Linear(hidden_size, 32)
        self.dropout = nn.Dropout(dropout)
        self.fc2 = nn.Linear(32, 1)

    def forward(self, x):
        import torch.nn.functional as F
        h0 = torch.zeros(self.num_layers, x.size(0), self.hidden_dim).to(x.device)
        c0 = torch.zeros(self.num_layers, x.size(0), self.hidden_dim).to(x.device)
        lstm_out, _ = self.lstm(x, (h0, c0))
        context, _ = self.attention(lstm_out)
        out = F.relu(self.fc1(context))
        out = self.dropout(out)
        out = self.fc2(out)
        # No sigmoid: trainers predict Bollinger %B unbounded (matches current checkpoints)
        return out

class LSTMModel_XRP(nn.Module):
    def __init__(self, input_size, hidden_size=128, num_layers=2, dropout=0.1):
        super(LSTMModel_XRP, self).__init__()
        self.hidden_dim = hidden_size
        self.num_layers = num_layers
        self.lstm = nn.LSTM(input_size, hidden_size, num_layers, batch_first=True, dropout=dropout)
        self.norm = nn.LayerNorm(hidden_size * 2)
        self.head = nn.Sequential(
            nn.Linear(hidden_size * 2, 128),
            nn.ReLU(),
            nn.Dropout(dropout),
            nn.Linear(128, 1)
        )

    def forward(self, x):
        h0 = torch.zeros(self.num_layers, x.size(0), self.hidden_dim).to(x.device)
        c0 = torch.zeros(self.num_layers, x.size(0), self.hidden_dim).to(x.device)
        out, _ = self.lstm(x, (h0, c0))
        out_last = out[:, -1, :]
        out_mean = out.mean(dim=1)
        feat = torch.cat([out_last, out_mean], dim=-1)
        feat = self.norm(feat)
        return self.head(feat)

class GLU(nn.Module):
    def __init__(self, input_size):
        super().__init__()
        self.fc = nn.Linear(input_size, input_size * 2)
        self.sigmoid = nn.Sigmoid()
    def forward(self, x):
        x = self.fc(x)
        content, gate = torch.chunk(x, 2, dim=-1)
        return content * self.sigmoid(gate)

class GRN(nn.Module):
    def __init__(self, input_size, hidden_size, output_size=None, dropout=0.1):
        super().__init__()
        output_size = output_size or input_size
        self.fc1 = nn.Linear(input_size, hidden_size)
        self.fc2 = nn.Linear(hidden_size, output_size)
        self.glu = GLU(output_size)
        self.layer_norm = nn.LayerNorm(output_size)
        self.dropout = nn.Dropout(dropout)
        self.skip = nn.Linear(input_size, output_size) if input_size != output_size else nn.Identity()
    def forward(self, x):
        residual = self.skip(x)
        x = torch.relu(self.fc1(x))
        x = self.fc2(x)
        x = self.dropout(x)
        x = self.glu(x)
        return self.layer_norm(residual + x)

class VariableSelectionNetwork(nn.Module):
    def __init__(self, input_dim, num_vars, d_model, dropout=0.1):
        super().__init__()
        self.d_model = d_model
        self.num_vars = num_vars
        self.grns = nn.ModuleList([GRN(input_dim // num_vars, d_model, d_model, dropout) for _ in range(num_vars)])
        self.selector_grn = GRN(input_dim, d_model, num_vars, dropout)
        self.softmax = nn.Softmax(dim=-1)
    def forward(self, x):
        weights = self.softmax(self.selector_grn(x))
        var_outputs = []
        chunk_size = x.shape[-1] // self.num_vars
        for i in range(self.num_vars):
            var_x = x[..., i*chunk_size : (i+1)*chunk_size]
            var_outputs.append(self.grns[i](var_x))
        var_outputs = torch.stack(var_outputs, dim=-1)
        selected_output = torch.sum(var_outputs * weights.unsqueeze(-2), dim=-1)
        return selected_output

class PositionalEncoding(nn.Module):
    def __init__(self, d_model, max_len=5000):
        super().__init__()
        pe = torch.zeros(max_len, d_model)
        position = torch.arange(0, max_len, dtype=torch.float).unsqueeze(1)
        div_term = torch.exp(torch.arange(0, d_model, 2).float() * (-math.log(10000.0) / d_model))
        pe[:, 0::2] = torch.sin(position * div_term)
        pe[:, 1::2] = torch.cos(position * div_term)
        self.register_buffer('pe', pe.unsqueeze(0))
    def forward(self, x):
        return x + self.pe[:, :x.size(1), : ]

class TFTModel(nn.Module):
    def __init__(self, input_dim, num_vars, d_model=64, nhead=4, num_layers=2, dropout=0.1):
        super().__init__()
        self.vsn = VariableSelectionNetwork(input_dim, num_vars, d_model, dropout)
        self.pos_encoder = PositionalEncoding(d_model)
        encoder_layers = nn.TransformerEncoderLayer(d_model, nhead, d_model*4, dropout, batch_first=True)
        self.transformer = nn.TransformerEncoder(encoder_layers, num_layers)
        self.fc = nn.Linear(d_model, 1)
    def forward(self, x):
        x = self.vsn(x)
        x = self.pos_encoder(x)
        x = self.transformer(x)
        return self.fc(x[:, -1, :])


# --- 3. Global State ---
df_hist_dict = {}
scalers_dict = {}
models_lstm = {}
models_tft = {}

# Default features (9 features)
LSTM_FEATURES = [
    'log_ret', 'rsi', 'rsi_change', 'rsi_accel', 'macd', 'macd_slope',
    'bb_pband_change', 'volume', 'ma_dist'
]

# Transformer / TFT features (16 features)
TFT_FEATURES = [
    'log_ret', 'rsi', 'rsi_change', 'rsi_accel', 'macd', 'macd_slope',
    'bb_pband_change', 'volume', 'ma_dist', 'volume_z', 'vol_spike', 'adx',
    'hour_sin', 'hour_cos', 'mom_3', 'mom_5'
]


# --- 4. Core Functions ---

# --- Google Drive API Helpers ---
SCOPES = ['https://www.googleapis.com/auth/drive.readonly']

def get_drive_service():
    creds = None
    base_dir = DRIVE_BASE_DIR if (DRIVE_BASE_DIR and os.path.exists(DRIVE_BASE_DIR)) else os.getcwd()
    
    token_path = os.path.join(base_dir, 'token.json')
    creds_path = os.path.join(base_dir, 'credentials.json')
    
    if os.path.exists(token_path):
        try:
            creds = Credentials.from_authorized_user_file(token_path, SCOPES)
        except Exception as e:
            print(f"   -> ⚠️ Failed to load token.json: {e}")
            creds = None
            
    if not creds or not creds.valid:
        if creds and creds.expired and creds.refresh_token:
            try:
                creds.refresh(Request())
            except Exception as e:
                print(f"   -> ⚠️ Token refresh failed: {e}")
                creds = None
        if not creds:
            if not os.path.exists(creds_path):
                print(f"\n⚠️ Google Drive credentials.json not found at {creds_path}!")
                print("To run locally and fetch models from Drive, please:")
                print("1. Go to Google Cloud Console -> APIs & Services -> Credentials")
                print("2. Create an OAuth client ID (Desktop Application) and download the JSON file.")
                print(f"3. Rename it to 'credentials.json' and place it in: {base_dir}\n")
                return None
                
            try:
                flow = InstalledAppFlow.from_client_secrets_file(creds_path, SCOPES)
                creds = flow.run_local_server(port=0)
            except Exception as e:
                print(f"   -> ❌ Google Drive Authentication failed: {e}")
                return None
            
        try:
            with open(token_path, 'w') as token:
                token.write(creds.to_json())
        except Exception as e:
            print(f"   -> ⚠️ Failed to save token.json: {e}")
            
    try:
        return build('drive', 'v3', credentials=creds)
    except Exception as e:
        print(f"   -> ❌ Failed to build Google Drive client: {e}")
        return None

def download_file_from_drive(service, filename, local_dest_path):
    if service is None:
        return False
    try:
        query = f"name = '{filename}' and trashed = false"
        results = service.files().list(q=query, spaces='drive', fields='files(id, name, modifiedTime)').execute()
        items = results.get('files', [])
        
        if not items:
            print(f"   -> ⚠️ File '{filename}' not found in Google Drive.")
            return False
            
        items = sorted(items, key=lambda x: x['modifiedTime'], reverse=True)
        file_id = items[0]['id']
        
        print(f"   -> Downloading '{filename}' from Google Drive (ID: {file_id})...")
        request = service.files().get_media(fileId=file_id)
        fh = io.BytesIO()
        downloader = MediaIoBaseDownload(fh, request)
        done = False
        while not done:
            status, done = downloader.next_chunk()
            
        os.makedirs(os.path.dirname(local_dest_path), exist_ok=True)
        with open(local_dest_path, 'wb') as f:
            f.write(fh.getvalue())
        print(f"   -> Successfully downloaded and saved to '{local_dest_path}'.")
        return True
    except Exception as e:
        print(f"   -> ❌ Failed to download '{filename}' from Drive: {e}")
        return False

def fetch_missing_history(symbol, start_time_dt):
    print(f"   -> Gap detected. Fetching missing historical candles since {start_time_dt}...")
    start_ms = int(start_time_dt.timestamp() * 1000)
    end_ms = int(datetime.now().timestamp() * 1000)
    
    all_dfs = []
    current_start = start_ms
    
    while current_start < end_ms:
        params = {
            'symbol': symbol,
            'interval': INTERVAL,
            'limit': 1000,
            'startTime': current_start
        }
        try:
            response = requests.get(BASE_URL, params=params, timeout=10)
            if response.status_code == 200:
                data = response.json()
                if not data:
                    break
                cols = ['open_time', 'open', 'high', 'low', 'close', 'volume',
                        'close_time', 'quote_asset_volume', 'number_of_trades',
                        'taker_buy_base_asset_volume', 'taker_buy_quote_asset_volume', 'ignore']
                df = pd.DataFrame(data, columns=cols)
                numeric_cols = ['open', 'high', 'low', 'close', 'volume']
                df[numeric_cols] = df[numeric_cols].apply(pd.to_numeric)
                df['open_time'] = pd.to_datetime(df['open_time'], unit='ms')
                all_dfs.append(df)
                
                last_close_ms = data[-1][6]
                current_start = last_close_ms + 1
                time.sleep(0.1)
            else:
                print(f"      -> ⚠️ Error fetching historical chunk: {response.text}")
                break
        except Exception as e:
            print(f"      -> ⚠️ Request failed: {e}")
            break
            
    if all_dfs:
        return pd.concat(all_dfs)
    return pd.DataFrame()

def fetch_latest_data(symbol, interval=INTERVAL, limit=1000):
    params = {'symbol': symbol, 'interval': interval, 'limit': limit}
    response = requests.get(BASE_URL, params=params, timeout=10)
    if response.status_code == 200:
        data = response.json()
        cols = ['open_time', 'open', 'high', 'low', 'close', 'volume',
                'close_time', 'quote_asset_volume', 'number_of_trades',
                'taker_buy_base_asset_volume', 'taker_buy_quote_asset_volume', 'ignore']
        df = pd.DataFrame(data, columns=cols)
        numeric_cols = ['open', 'high', 'low', 'close', 'volume']
        df[numeric_cols] = df[numeric_cols].apply(pd.to_numeric)
        df['open_time'] = pd.to_datetime(df['open_time'], unit='ms')
        return df
    else:
        raise Exception(f"Failed to fetch data from Binance: {response.text}")

def calculate_features(df):
    df = df.copy()
    df['log_ret'] = np.log(df['close'] / df['close'].shift(1))

    df['rsi'] = ta.momentum.rsi(df['close'], window=14) / 100.0
    df['rsi_change'] = df['rsi'].diff(periods=3)
    df['rsi_accel'] = df['rsi_change'].diff(periods=2)

    macd = ta.trend.MACD(df['close'])
    macd_raw = macd.macd_diff()
    df['macd'] = (macd_raw - macd_raw.rolling(window=100).mean()) / (macd_raw.rolling(window=100).std() + 1e-9)
    df['macd_diff'] = macd.macd_diff()
    df['macd_slope'] = df['macd_diff'].diff(periods=2)

    bb = ta.volatility.BollingerBands(df['close'], window=20, window_dev=2)
    df['bb_pband'] = bb.bollinger_pband()
    df['bb_pband_change'] = df['bb_pband'].diff(periods=1)
    df['bb_hband'] = bb.bollinger_hband()
    df['bb_lband'] = bb.bollinger_lband()

    df['volume_raw'] = df['volume']
    df['volume'] = np.log(df['volume'] + 1)
    df['volume'] = (df['volume'] - df['volume'].mean()) / (df['volume'].std() + 1e-9)

    df['vol_ma'] = df['volume'].rolling(window=20).mean()
    df['vol_std'] = df['volume'].rolling(window=20).std()
    df['volume_z'] = (df['volume'] - df['vol_ma']) / (df['vol_std'] + 1e-9)
    df['vol_spike'] = (df['volume'] > (df['vol_ma'] * 2)).astype(float)

    df['ma_20'] = df['close'].rolling(window=20).mean()
    df['ma_dist'] = (df['close'] - df['ma_20']) / (df['ma_20'] + 1e-9) * 10.0

    adx = ta.trend.ADXIndicator(df['high'], df['low'], df['close'], window=14)
    df['adx'] = adx.adx()

    df['hour'] = df['open_time'].dt.hour
    df['hour_sin'] = np.sin(2 * np.pi * df['hour'] / 24)
    df['hour_cos'] = np.cos(2 * np.pi * df['hour'] / 24)

    # Momentum features
    df['mom_3'] = df['close'] / df['close'].shift(3) - 1
    df['mom_5'] = df['close'] / df['close'].shift(5) - 1

    return df.dropna()


def infer_arima(close_series):
    with warnings.catch_warnings():
        warnings.simplefilter("ignore")
        try:
            model = ARIMA(close_series, order=(2, 1, 0))
            model_fit = model.fit()
            forecast = model_fit.forecast(steps=3)
            return float(forecast.iloc[-1])
        except Exception as e:
            print(f"   -> ARIMA fitting failed: {e}")
            return None

def initialize():
    global df_hist_dict, scalers_dict, models_lstm, models_tft

    # 0. Sync models and historical data from Google Drive over the network if running locally and credentials exist
    is_colab = False
    try:
        import google.colab
        is_colab = True
    except ImportError:
        pass

    if not is_colab:
        base_dir = DRIVE_BASE_DIR if (DRIVE_BASE_DIR and os.path.exists(DRIVE_BASE_DIR)) else os.getcwd()
        creds_path = os.path.join(base_dir, 'credentials.json')
        if os.path.exists(creds_path):
            print("\n[Init] Local run & credentials.json detected. Connecting to Google Drive API...")
            service = get_drive_service()
            if service is not None:
                print("   -> Connected! Fetching latest models & historical data from Google Drive...")
                for symbol, db_id in COINS:
                    # 1. Download model checkpoints
                    lstm_file = f'best_lstm_model_{symbol}.pth'
                    tft_file = f'best_tft_vsn_{symbol}.pth'
                    
                    local_lstm_path = os.path.join(MODEL_DIR, lstm_file)
                    local_tft_path = os.path.join(MODEL_DIR, tft_file)
                    
                    if not os.path.exists(local_lstm_path):
                        download_file_from_drive(service, lstm_file, local_lstm_path)
                    if not os.path.exists(local_tft_path):
                        download_file_from_drive(service, tft_file, local_tft_path)

                    # 2. Download historical data CSV if missing
                    csv_file = f'{symbol}_5m_data.csv'
                    local_csv_path = os.path.join(DATA_DIR, csv_file)
                    if not os.path.exists(local_csv_path):
                        print(f"   -> Local historical data for {symbol} not found. Downloading from Google Drive...")
                        download_file_from_drive(service, csv_file, local_csv_path)
            else:
                print("   -> ⚠️ Google Drive API service could not be initialized.")
        else:
            print("\n[Init] Running locally. credentials.json not found in project directory.")
            print("       -> Will attempt to load already cached models and data locally.")

    print("\n[Init] Loading models into memory & moving to GPU...")
    
    # 1. Load LSTM models for each symbol
    for symbol, db_id in COINS:
        lstm_path = os.path.join(MODEL_DIR, f'best_lstm_model_{symbol}.pth')
        if not os.path.exists(lstm_path):
            lstm_path = os.path.join(MODEL_DIR, 'best_lstm_model.pth')
            
        if os.path.exists(lstm_path):
            try:
                state_dict = torch.load(lstm_path, map_location=DEVICE)
                input_size = state_dict['lstm.weight_ih_l0'].shape[1]
                hidden_size = state_dict['lstm.weight_hh_l0'].shape[1]
                print(f"   -> Detected LSTM checkpoint for {symbol} (path: {os.path.basename(lstm_path)}) input size: {input_size} features, hidden size: {hidden_size}.")
                
                # Check architecture based on state_dict keys
                if 'attention.attention.weight' in state_dict:
                    print(f"      -> Instantiating LSTMModel_ETH (Attention + MLP) for {symbol}")
                    model_lstm = LSTMModel_ETH(input_size=input_size, hidden_size=hidden_size)
                elif 'norm.weight' in state_dict:
                    print(f"      -> Instantiating LSTMModel_XRP (LayerNorm + MLP) for {symbol}")
                    model_lstm = LSTMModel_XRP(input_size=input_size, hidden_size=hidden_size)
                else:
                    print(f"      -> Instantiating standard LSTMModel for {symbol}")
                    model_lstm = LSTMModel(input_size=input_size, hidden_size=hidden_size)

                model_lstm.load_state_dict(state_dict)
                model_lstm.to(DEVICE)
                model_lstm.eval()
                models_lstm[symbol] = (model_lstm, input_size)
                print(f"   -> LSTM model for {symbol} loaded on {DEVICE}.")
            except Exception as e:
                print(f"   -> Failed to load LSTM model for {symbol}: {e}")
        else:
            print(f"   -> ⚠️ No LSTM model found for {symbol} (checked specific & global).")

    # 2. Load TFT models for each symbol
    for symbol, db_id in COINS:
        tft_path = os.path.join(MODEL_DIR, f'best_tft_vsn_{symbol}.pth')
        if not os.path.exists(tft_path):
            tft_path = os.path.join(MODEL_DIR, 'best_tft_vsn.pth')
            
        if os.path.exists(tft_path):
            try:
                state_dict = torch.load(tft_path, map_location=DEVICE)
                d_model = state_dict['pos_encoder.pe'].shape[-1]
                num_vars = state_dict['vsn.selector_grn.layer_norm.weight'].shape[0]
                tft_features_subset = TFT_FEATURES[:num_vars]
                
                print(f"   -> Detected TFT checkpoint for {symbol} (path: {os.path.basename(tft_path)}) with d_model: {d_model}, num_vars: {num_vars}")
                model_tft = TFTModel(input_dim=num_vars, num_vars=num_vars, d_model=d_model)
                model_tft.load_state_dict(state_dict)
                model_tft.to(DEVICE)
                model_tft.eval()
                models_tft[symbol] = (model_tft, num_vars, tft_features_subset)
                print(f"   -> Transformer model for {symbol} loaded on {DEVICE}.")
            except Exception as e:
                print(f"   -> Failed to load TFT model for {symbol}: {e}")
        else:
            print(f"   -> ⚠️ No Transformer model found for {symbol} (checked specific & global).")

    # 3. Fit scalers
    for symbol, db_id in COINS:
        csv_path = os.path.join(DATA_DIR, f'{symbol}_5m_data.csv')
        print(f"\n[Init] Loading historical data for {symbol} ({csv_path})...")
        if os.path.exists(csv_path):
            df_hist = pd.read_csv(csv_path)
            df_hist['open_time'] = pd.to_datetime(df_hist['open_time'])
            
            # Check for gap between last row in CSV and current time
            if not df_hist.empty:
                last_time = df_hist['open_time'].iloc[-1]
                time_diff = datetime.now() - last_time
                if time_diff.total_seconds() > 600:
                    df_missing = fetch_missing_history(symbol, last_time)
                    if not df_missing.empty:
                        df_hist = pd.concat([df_hist, df_missing]).drop_duplicates(subset=['open_time'], keep='last').sort_values('open_time')
                        # Save the updated history back to CSV to preserve it
                        df_hist.to_csv(csv_path, index=False)
                        print(f"      -> Synced {len(df_missing)} missing candles and updated local CSV.")

            df_hist_dict[symbol] = df_hist
            print(f"   -> Loaded {len(df_hist)} historical rows.")

            print(f"   -> Fitting scalers for {symbol}... (this takes a moment)")
            df_full_feat = calculate_features(df_hist)
            train_end = int(len(df_full_feat) * 0.8)
            df_train = df_full_feat.iloc[:train_end]

            # Determine the features to fit based on the loaded LSTM model
            lstm_info = models_lstm.get(symbol)
            if lstm_info is not None:
                _, input_size = lstm_info
                lstm_features_subset = TFT_FEATURES[:input_size]
            else:
                lstm_features_subset = LSTM_FEATURES # fallback

            tft_info = models_tft.get(symbol)
            if tft_info is not None:
                _, num_vars, tft_features_subset = tft_info
            else:
                tft_features_subset = TFT_FEATURES[:14] # fallback

            lstm_scaler = StandardScaler()
            tft_scaler = StandardScaler()
            lstm_scaler.fit(df_train[lstm_features_subset])
            tft_scaler.fit(df_train[tft_features_subset])
            scalers_dict[symbol] = (lstm_scaler, tft_scaler, lstm_features_subset, tft_features_subset)
            print(f"      -> Scalers fitted (LSTM features: {len(lstm_features_subset)}, TFT features: {len(tft_features_subset)}).")
        else:
            print(f"   -> ⚠️ No historical data found for {symbol}! Will initialize from live fetch.")
            df_hist = fetch_latest_data(symbol, limit=1000)
            df_hist_dict[symbol] = df_hist
            df_hist.to_csv(csv_path, index=False)
            print(f"      -> Fetched and cached {len(df_hist)} latest candles.")

def save_data_to_drive():
    for symbol, df_hist in df_hist_dict.items():
        if df_hist is not None and not df_hist.empty:
            csv_path = os.path.join(DATA_DIR, f'{symbol}_5m_data.csv')
            print(f"🛑 [Session End] Saving updated historical data for {symbol}...")
            df_hist.to_csv(csv_path, index=False)
            print(f"✅ Save complete! {len(df_hist)} rows written to {csv_path}.")

def push_to_supabase(results, db_id):
    if not supabase:
        return
    print(f"   -> 🌐 Pushing updates to Supabase (id: {db_id})...")
    try:
        response = supabase.table('predictions').upsert({"id": db_id, "payload": results}).execute()
        print(f"   -> ✅ Successfully pushed to Supabase! Response data: {response.data}")
    except Exception as e:
        print(f"   -> ❌ Supabase push failed: {e}")

def signal_handler(sig, frame):
    save_data_to_drive()
    sys.exit(0)

# Register Graceful Shutdown
signal.signal(signal.SIGINT, signal_handler)
signal.signal(signal.SIGTERM, signal_handler)

# --- 5. Main Loop ---

def run_inference(symbol, db_id):
    global df_hist_dict
    print(f"\n[{datetime.now().strftime('%Y-%m-%d %H:%M:%S')}] Fetching latest data for {symbol}...")

    # Fetch existing prediction history from Supabase to append to it
    existing_history = []
    if supabase:
        try:
            res = supabase.table('predictions').select('payload').eq('id', db_id).execute()
            if res.data and res.data[0].get('payload'):
                existing_history = res.data[0]['payload'].get('prediction_history', [])
        except Exception as e:
            print(f"   -> Failed to fetch existing prediction history: {e}")

    df_hist = df_hist_dict[symbol]
    # 1. Fetch & Append Data
    df_new = fetch_latest_data(symbol)
    if df_hist.empty:
        df_hist = df_new
    else:
        df_hist = pd.concat([df_hist, df_new]).drop_duplicates(subset=['open_time'], keep='last').sort_values('open_time')

    df_hist_dict[symbol] = df_hist

    # 2. Calculate Features
    df_recent = df_hist.tail(1500).copy()
    df_features = calculate_features(df_recent)

    if len(df_features) < SEQ_LENGTH:
        print("   -> ⏳ Not enough data for inference yet.")
        return

    last_price = float(df_features['close'].iloc[-1])
    results = {
        "timestamp": str(df_features['open_time'].iloc[-1]),
        "last_price": last_price,
        "predictions": {},
        "prediction_history": existing_history
    }

    l_band = df_features['bb_lband'].iloc[-1]
    h_band = df_features['bb_hband'].iloc[-1]

    # Load cached scalers
    scaler_info = scalers_dict.get(symbol)
    if scaler_info is not None:
        lstm_scaler, tft_scaler, lstm_features_subset, tft_features_subset = scaler_info
    else:
        print("   -> ⚠️ Scalers not fitted. Fitting on the fly on available history...")
        lstm_info = models_lstm.get(symbol)
        if lstm_info is not None:
            _, input_size = lstm_info
            lstm_features_subset = TFT_FEATURES[:input_size]
        else:
            lstm_features_subset = LSTM_FEATURES
        
        tft_info = models_tft.get(symbol)
        if tft_info is not None:
            _, num_vars, tft_features_subset = tft_info
        else:
            tft_features_subset = TFT_FEATURES[:14]

        lstm_scaler = StandardScaler()
        tft_scaler = StandardScaler()
        lstm_scaler.fit(df_features[lstm_features_subset])
        tft_scaler.fit(df_features[tft_features_subset])
        scalers_dict[symbol] = (lstm_scaler, tft_scaler, lstm_features_subset, tft_features_subset)

    # 4. Infer LSTM
    lstm_info = models_lstm.get(symbol)
    if lstm_info is not None:
        lstm_model_obj, input_size = lstm_info
        seq_lstm = df_features[lstm_features_subset].tail(SEQ_LENGTH).values
        input_lstm = torch.tensor(lstm_scaler.transform(seq_lstm), dtype=torch.float32).unsqueeze(0).to(DEVICE)
        with torch.no_grad():
            pred_val = lstm_model_obj(input_lstm).item()

        # All LSTM trainers use TARGET_COL = 'target_pctb' (Bollinger %B), so the
        # band reconstruction applies to every coin.
        pred_price_lstm = l_band + (pred_val * (h_band - l_band))

        results["predictions"]["LSTM"] = {
            "val": pred_val,
            "price": pred_price_lstm,
            "change_pct": (pred_price_lstm - last_price) / last_price * 100
        }

    # 5. Infer Transformer
    tft_info = models_tft.get(symbol)
    if tft_info is not None:
        tft_model_obj, num_vars, tft_features_subset = tft_info
        seq_tft = df_features[tft_features_subset].tail(SEQ_LENGTH).values
        input_tft = torch.tensor(tft_scaler.transform(seq_tft), dtype=torch.float32).unsqueeze(0).to(DEVICE)
        with torch.no_grad():
            pred_bb = tft_model_obj(input_tft).item()

        pred_price_tft = l_band + (pred_bb * (h_band - l_band))
        results["predictions"]["Transformer"] = {
            "val": pred_bb,
            "price": pred_price_tft,
            "change_pct": (pred_price_tft - last_price) / last_price * 100
        }

    # 6. Infer ARIMA (Runs on Close series directly)
    pred_price_arima = infer_arima(df_features['close'].tail(SEQ_LENGTH))
    if pred_price_arima is not None:
        results["predictions"]["ARIMA"] = {
            "val": pred_price_arima,
            "price": pred_price_arima,
            "change_pct": (pred_price_arima - last_price) / last_price * 100
        }

    # 7. Decide Consensus: average the model prices into an Ensemble entry.
    # (Picking the largest |change| just rewards the most extreme model.)
    if results["predictions"]:
        prices = [p["price"] for p in results["predictions"].values()]
        ens_price = float(np.mean(prices))
        results["predictions"]["Ensemble"] = {
            "val": ens_price,
            "price": ens_price,
            "change_pct": (ens_price - last_price) / last_price * 100
        }
        results["chosen_model"] = "Ensemble"
    else:
        results["chosen_model"] = "None"

    # Update Prediction History
    try:
        last_time_dt = df_features['open_time'].iloc[-1]
        target_time = int(last_time_dt.timestamp() + 900)  # +15 minutes (3 candles)

        new_entry = {
            "time": target_time,
            "LSTM": results["predictions"]["LSTM"]["price"] if "LSTM" in results["predictions"] else None,
            "ARIMA": results["predictions"]["ARIMA"]["price"] if "ARIMA" in results["predictions"] else None,
            "Transformer": results["predictions"]["Transformer"]["price"] if "Transformer" in results["predictions"] else None
        }

        history_list = results.get("prediction_history", [])
        history_df = pd.DataFrame(history_list)
        if not history_df.empty:
            # Drop entries where time or value keys might be completely null
            history_df = pd.concat([history_df, pd.DataFrame([new_entry])])
        else:
            history_df = pd.DataFrame([new_entry])

        history_df = history_df.drop_duplicates(subset=['time'], keep='last').sort_values('time')
        # Prune entries older than 7 days - they fall off the chart and bloat the payload
        cutoff = int(datetime.now().timestamp()) - 7 * 24 * 3600
        history_df = history_df[history_df['time'] >= cutoff]
        raw_history = history_df.tail(500).to_dict('records')
        cleaned_history = []
        for entry in raw_history:
            cleaned_entry = {}
            for k, v in entry.items():
                if isinstance(v, float) and math.isnan(v):
                    cleaned_entry[k] = None
                else:
                    cleaned_entry[k] = v
            cleaned_history.append(cleaned_entry)
        results["prediction_history"] = cleaned_history
    except Exception as e:
        print(f"   -> Failed to update prediction history: {e}")

    # 8. Add History Aggregation (OHLC format for Candlestick charts with UNIX timestamp in seconds)
    try:
        # 5m: Last 500 candles
        h5 = df_hist.tail(500)[['open_time', 'open', 'high', 'low', 'close']].copy()
        h5['time'] = h5['open_time'].astype('datetime64[s]').astype(np.int64)
        hist_5m = h5[['time', 'open', 'high', 'low', 'close']].rename(
            columns={'open':'o', 'high':'h', 'low':'l', 'close':'c'}
        ).to_dict('records')

        # 1h: Last 30 days resampled
        df_res_1h = df_hist.set_index('open_time').resample('1h').agg({
            'open': 'first', 'high': 'max', 'low': 'min', 'close': 'last'
        }).dropna().reset_index()
        h1h = df_res_1h.tail(720).copy()
        h1h['time'] = h1h['open_time'].astype('datetime64[s]').astype(np.int64)
        hist_1h = h1h[['time', 'open', 'high', 'low', 'close']].rename(
            columns={'open':'o', 'high':'h', 'low':'l', 'close':'c'}
        ).to_dict('records')

        # 1d: Full history resampled (Format 'YYYY-MM-DD' for TradingView)
        df_res_1d = df_hist.set_index('open_time').resample('1d').agg({
            'open': 'first', 'high': 'max', 'low': 'min', 'close': 'last'
        }).dropna().reset_index()
        h1d = df_res_1d.copy()
        h1d['time'] = h1d['open_time'].dt.strftime('%Y-%m-%d')
        hist_1d = h1d[['time', 'open', 'high', 'low', 'close']].rename(
            columns={'open':'o', 'high':'h', 'low':'l', 'close':'c'}
        ).to_dict('records')

        results['history'] = {
            "5m": hist_5m,
            "1h": hist_1h,
            "1d": hist_1d
        }
    except Exception as e:
        print(f"   -> History aggregation failed: {e}")

    # 9. Push to Supabase
    push_to_supabase(results, db_id)

    if results["chosen_model"] != "None":
        best = results['predictions'][results['chosen_model']]
        print(f"   -> AI Prediction [{results['chosen_model']}]: ${best['price']:.2f} ({best['change_pct']:+.2f}%)")

if __name__ == "__main__":
    print("========================================")
    print("   🚀 Crypto AI Prediction Cloud Engine 🚀")
    print("========================================")
    print("Press Ctrl+C to stop the engine and save data safely to Drive.")

    initialize()

    while True:
        for symbol, db_id in COINS:
            try:
                run_inference(symbol, db_id)
            except Exception as e:
                print(f"⚠️ Error during inference for {symbol}: {e}")
            time.sleep(5)  # Sleep between coins to prevent API throttling

        print("\n   -> Sleeping for 5 minutes...\n")
        time.sleep(300)

