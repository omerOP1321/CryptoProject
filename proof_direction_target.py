"""
Proof script: is the legacy "lag-1" behaviour fixable by changing the target?

Trains a small LSTM two ways on the SAME features / split and compares
held-out directional accuracy (DIR) against a coin flip:

  A) LEGACY target  -> Bollinger %B one step ahead (what the deployed models use)
  B) DIRECTION target -> next-candle log-return, plus a direction-aware loss

For each we measure DIR on a chronological hold-out set and run a one-sided
binomial test vs p=0.5. If B does not clear 50% significantly, a retrain
removes the cosmetic lag but buys no real edge -- which is the honest answer.

Offline only: uses local data/*.csv, CPU, no Drive / checkpoints touched.
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
EPOCHS = 40
torch.manual_seed(SEED); np.random.seed(SEED)

FEATURES = ['log_ret', 'rsi', 'macd', 'bb_pband', 'bb_pband_change',
            'volume_z', 'ma_dist', 'mom_3', 'mom_5']


def build(df):
    df = df.sort_values('open_time').drop_duplicates('open_time').reset_index(drop=True)
    c = df['close']
    df['log_ret'] = np.log(c / c.shift(1))
    df['rsi'] = ta.momentum.rsi(c, 14) / 100.0
    df['macd'] = ta.trend.MACD(c).macd_diff()
    bb = ta.volatility.BollingerBands(c, 20, 2)
    df['bb_pband'] = bb.bollinger_pband()
    df['bb_pband_change'] = df['bb_pband'].diff()
    df['bb_l'] = bb.bollinger_lband(); df['bb_h'] = bb.bollinger_hband()
    df['ma_dist'] = c / c.rolling(20).mean() - 1
    df['volume_z'] = (df['volume'] - df['volume'].rolling(20).mean()) / df['volume'].rolling(20).std()
    df['mom_3'] = c / c.shift(3) - 1
    df['mom_5'] = c / c.shift(5) - 1
    # targets
    df['t_pctb'] = df['bb_pband'].shift(-1)              # LEGACY target
    df['t_logret'] = np.log(c.shift(-1) / c)            # DIRECTION target
    return df.dropna().reset_index(drop=True)


def seqs(df, target):
    X, y, meta = [], [], []
    f = df[FEATURES].values
    t = df[target].values
    close, bl, bh = df['close'].values, df['bb_l'].values, df['bb_h'].values
    for i in range(SEQ_LEN, len(df) - 1):
        X.append(f[i - SEQ_LEN:i]); y.append(t[i])
        meta.append((close[i], close[i + 1], bl[i], bh[i]))  # cur, next, bands@i
    return np.array(X), np.array(y, np.float32), np.array(meta, np.float32)


class LSTM(nn.Module):
    def __init__(self, n):
        super().__init__()
        self.l = nn.LSTM(n, 48, batch_first=True)
        self.h = nn.Linear(48, 1)

    def forward(self, x):
        o, _ = self.l(x)
        return self.h(o[:, -1]).squeeze(-1)


def dir_loss(pred, tgt):
    """MSE + soft penalty for getting the sign of the move wrong."""
    mse = nn.functional.mse_loss(pred, tgt)
    sign = torch.sigmoid(-10 * pred * tgt).mean()  # ~1 when signs disagree
    return mse + 0.5 * sign


def train_eval(sym, target, loss_fn, reconstruct):
    df = build(pd.read_csv(f'data/{sym}_5m_data.csv'))
    X, y, meta = seqs(df, target)
    n = int(len(X) * TRAIN_FRAC)
    sc = StandardScaler().fit(X[:n].reshape(-1, X.shape[-1]))
    tr = sc.transform(X[:n].reshape(-1, X.shape[-1])).reshape(X[:n].shape)
    te = sc.transform(X[n:].reshape(-1, X.shape[-1])).reshape(X[n:].shape)
    Xtr = torch.tensor(tr, dtype=torch.float32); ytr = torch.tensor(y[:n])
    Xte = torch.tensor(te, dtype=torch.float32)

    m = LSTM(X.shape[-1]); opt = torch.optim.Adam(m.parameters(), 1e-3)
    for _ in range(EPOCHS):
        m.train(); opt.zero_grad()
        loss = loss_fn(m(Xtr), ytr); loss.backward(); opt.step()
    m.eval()
    with torch.no_grad():
        pred = m(Xte).numpy()

    cur, nxt, bl, bh = meta[n:, 0], meta[n:, 1], meta[n:, 2], meta[n:, 3]
    pred_price = reconstruct(pred, cur, bl, bh)
    pmove = np.sign(pred_price - cur); amove = np.sign(nxt - cur)
    mask = (pmove != 0) & (amove != 0)
    hits = int((pmove[mask] == amove[mask]).sum()); tot = int(mask.sum())
    dir_acc = hits / tot
    p = binomtest(hits, tot, 0.5, alternative='greater').pvalue
    rmse = float(np.sqrt(np.mean((pred_price - nxt) ** 2)))
    naive_rmse = float(np.sqrt(np.mean((cur - nxt) ** 2)))
    corr = float(np.corrcoef(pred_price, cur)[0, 1])
    return dict(dir=dir_acc, n=tot, p=p, rmse=rmse, naive=naive_rmse, corr=corr)


if __name__ == '__main__':
    print(f"{'coin':>4} {'setup':>10} | {'DIR':>6} {'n':>4} {'p-val':>7} "
          f"{'RMSE':>9} {'naive':>9} {'corr@last':>9}")
    print('-' * 72)
    for sym in ['BTCUSDT', 'ETHUSDT', 'XRPUSDT']:
        # A) legacy: predict %B, reconstruct via current bands
        a = train_eval(sym, 't_pctb', nn.functional.mse_loss,
                       lambda p, c, bl, bh: bl + p * (bh - bl))
        # B) direction: predict log-return, reconstruct price = c*exp(ret)
        b = train_eval(sym, 't_logret', dir_loss,
                       lambda p, c, bl, bh: c * np.exp(p))
        for name, r in [('legacy %B', a), ('direction', b)]:
            star = '*' if r['p'] < 0.05 else ' '
            print(f"{sym[:3]:>4} {name:>10} | {r['dir']*100:5.1f}% {r['n']:4d} "
                  f"{r['p']:7.3f}{star} {r['rmse']:9.2f} {r['naive']:9.2f} {r['corr']:9.3f}")
        print()
