"""
Solution #1 test: does direction accuracy beat 50% at LONGER horizons?

Same small LSTM, same features, chronological 80/20 split. For each horizon H
(in 5-minute candles) we train to predict the log-return over the next H
candles and measure held-out directional accuracy (DIR) vs a coin flip.

  H=1   -> 5 minutes   (the deployed horizon)
  H=12  -> 1 hour
  H=48  -> 4 hours
  H=144 -> 12 hours

Offline only: local data/*.csv, CPU. Small data (~1400 candles) so long
horizons have few, overlapping test points -> treat p-values as optimistic.
"""
import numpy as np
import pandas as pd
import ta
import torch
import torch.nn as nn
from scipy.stats import binomtest
from sklearn.preprocessing import StandardScaler

SEED = 42
SEQ_LEN = 60
TRAIN_FRAC = 0.8
EPOCHS = 60
HORIZONS = [1, 12, 48, 144]
torch.manual_seed(SEED); np.random.seed(SEED)

FEATURES = ['log_ret', 'rsi', 'macd', 'bb_pband', 'bb_pband_change',
            'volume_z', 'ma_dist', 'mom_3', 'mom_5']


def build(df, H):
    df = df.sort_values('open_time').drop_duplicates('open_time').reset_index(drop=True)
    c = df['close']
    df['log_ret'] = np.log(c / c.shift(1))
    df['rsi'] = ta.momentum.rsi(c, 14) / 100.0
    df['macd'] = ta.trend.MACD(c).macd_diff()
    bb = ta.volatility.BollingerBands(c, 20, 2)
    df['bb_pband'] = bb.bollinger_pband()
    df['bb_pband_change'] = df['bb_pband'].diff()
    df['ma_dist'] = c / c.rolling(20).mean() - 1
    df['volume_z'] = (df['volume'] - df['volume'].rolling(20).mean()) / df['volume'].rolling(20).std()
    df['mom_3'] = c / c.shift(3) - 1
    df['mom_5'] = c / c.shift(5) - 1
    df['t_logret'] = np.log(c.shift(-H) / c)   # return over next H candles
    df['c_now'] = c
    df['c_fut'] = c.shift(-H)
    return df.dropna().reset_index(drop=True)


def seqs(df):
    X = df[FEATURES].values
    out_X, out_y, cur, fut = [], [], [], []
    for i in range(SEQ_LEN, len(df)):
        out_X.append(X[i - SEQ_LEN:i]); out_y.append(df['t_logret'].values[i])
        cur.append(df['c_now'].values[i]); fut.append(df['c_fut'].values[i])
    return (np.array(out_X), np.array(out_y, np.float32),
            np.array(cur, np.float32), np.array(fut, np.float32))


class LSTM(nn.Module):
    def __init__(self, n):
        super().__init__()
        self.l = nn.LSTM(n, 48, batch_first=True)
        self.h = nn.Linear(48, 1)

    def forward(self, x):
        o, _ = self.l(x)
        return self.h(o[:, -1]).squeeze(-1)


def dir_loss(pred, tgt):
    mse = nn.functional.mse_loss(pred, tgt)
    sign = torch.sigmoid(-10 * pred * tgt).mean()
    return mse + 0.5 * sign


def run(sym, H):
    df = build(pd.read_csv(f'data/{sym}_5m_data.csv'), H)
    X, y, cur, fut = seqs(df)
    if len(X) < 120:
        return None
    n = int(len(X) * TRAIN_FRAC)
    sc = StandardScaler().fit(X[:n].reshape(-1, X.shape[-1]))
    tr = sc.transform(X[:n].reshape(-1, X.shape[-1])).reshape(X[:n].shape)
    te = sc.transform(X[n:].reshape(-1, X.shape[-1])).reshape(X[n:].shape)
    Xtr = torch.tensor(tr, dtype=torch.float32); ytr = torch.tensor(y[:n])
    Xte = torch.tensor(te, dtype=torch.float32)

    m = LSTM(X.shape[-1]); opt = torch.optim.Adam(m.parameters(), 1e-3)
    for _ in range(EPOCHS):
        m.train(); opt.zero_grad()
        dir_loss(m(Xtr), ytr).backward(); opt.step()
    m.eval()
    with torch.no_grad():
        pred = m(Xte).numpy()

    c, f = cur[n:], fut[n:]
    pmove = np.sign(pred); amove = np.sign(f - c)
    mask = (pmove != 0) & (amove != 0)
    hits = int((pmove[mask] == amove[mask]).sum()); tot = int(mask.sum())
    p = binomtest(hits, tot, 0.5, alternative='greater').pvalue
    return dict(dir=hits / tot, n=tot, p=p)


if __name__ == '__main__':
    labels = {1: '5 min', 12: '1 hour', 48: '4 hours', 144: '12 hours'}
    print(f"{'coin':>4} {'horizon':>9} | {'DIR':>6} {'test n':>7} {'p-val':>7}")
    print('-' * 42)
    for sym in ['BTCUSDT', 'ETHUSDT', 'XRPUSDT']:
        for H in HORIZONS:
            r = run(sym, H)
            if r is None:
                print(f"{sym[:3]:>4} {labels[H]:>9} |   (too little data)")
                continue
            star = '*' if r['p'] < 0.05 else ' '
            print(f"{sym[:3]:>4} {labels[H]:>9} | {r['dir']*100:5.1f}% "
                  f"{r['n']:7d} {r['p']:7.3f}{star}")
        print()
