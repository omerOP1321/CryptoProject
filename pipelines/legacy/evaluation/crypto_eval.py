"""
Shared evaluation + plotting for all Crypto models (LSTM / Transformer, any coin).

Two-step workflow:
  1) A trainer finishes, then SAVES a small results bundle:
         from crypto_eval import save_eval_bundle
         save_eval_bundle(BASE_DIR, SYMBOL, 'lstm', y_test, predictions, train_losses, val_losses)

  2) Later, in the separate EVAL notebook, pick a coin + model and generate the graphs
     WITHOUT retraining:
         from crypto_eval import generate
         generate('XRPUSDT', 'lstm')      # or ('ETHUSDT', 'transformer'), etc.

All graph code lives here in ONE place, so adding a new graph = edit this file once,
re-run the eval, and every model gets it.
"""

import os
import numpy as np
import pandas as pd
import matplotlib.pyplot as plt
from sklearn.metrics import mean_squared_error
import ta


# ----------------------------------------------------------------------
# Path helpers
# ----------------------------------------------------------------------
def _resolve_base_dir(base_dir=None):
    if base_dir:
        return base_dir
    colab = '/content/drive/MyDrive/CryptoProject'
    return colab if os.path.isdir(colab) else os.path.abspath(os.getcwd())


def _bundle_path(base_dir, symbol, model_type):
    d = os.path.join(base_dir, 'eval_bundles')
    os.makedirs(d, exist_ok=True)
    return os.path.join(d, f'{model_type}_{symbol}.npz')


# ----------------------------------------------------------------------
# Called by a trainer when it finishes
# ----------------------------------------------------------------------
def save_eval_bundle(base_dir, symbol, model_type, y_test, predictions,
                     train_losses, val_losses):
    path = _bundle_path(base_dir, symbol, model_type)
    np.savez(
        path,
        y_test=np.asarray(y_test).flatten(),
        predictions=np.asarray(predictions).flatten(),
        train_losses=np.asarray(train_losses),
        val_losses=np.asarray(val_losses),
    )
    print(f"✅ Saved eval bundle -> {path}")
    return path


# ----------------------------------------------------------------------
# Called by the EVAL notebook: pick coin + model, draw all graphs
# ----------------------------------------------------------------------
GRAPH_OPTIONS = {
    'Training Loss':        'loss',
    'Actual vs Predicted':  'prediction',
    'Directional Accuracy': 'direction',
    'Candle Chart':         'candles',
}

def generate(symbol, model_type='lstm', base_dir=None, target_name='Bollinger %B',
             graphs=None, n_plot=576):
    base_dir = _resolve_base_dir(base_dir)
    path = _bundle_path(base_dir, symbol, model_type)
    if not os.path.exists(path):
        raise FileNotFoundError(
            f"No eval bundle for {symbol} / {model_type} at:\n  {path}\n"
            f"Run that model's trainer first (it saves the bundle at the end)."
        )
    d = np.load(path)
    model_name = 'TFT' if model_type.lower() in ('transformer', 'tft') else 'LSTM'
    return evaluate_and_plot(
        symbol=symbol,
        y_test=d['y_test'],
        predictions=d['predictions'],
        train_losses=d['train_losses'],
        val_losses=d['val_losses'],
        base_dir=base_dir,
        model_name=model_name,
        target_name=target_name,
        graphs=graphs,
        n_plot=n_plot,
    )


# ----------------------------------------------------------------------
# The actual metrics + graphs (single source of truth)
# ----------------------------------------------------------------------
ALL_GRAPHS = ['loss', 'prediction', 'direction', 'candles']

def evaluate_and_plot(symbol, y_test, predictions, train_losses, val_losses,
                      base_dir, model_name='LSTM', target_name='Bollinger %B',
                      n_plot=576, graphs=None):
    graphs = set(graphs) if graphs else set(ALL_GRAPHS)
    y_test = np.asarray(y_test).flatten()
    predictions = np.asarray(predictions).flatten()
    train_losses = np.asarray(train_losses).flatten() if train_losses is not None else np.array([])
    val_losses = np.asarray(val_losses).flatten() if val_losses is not None else np.array([])

    # ---------------- Metrics ----------------
    rmse = np.sqrt(mean_squared_error(y_test, predictions))
    corr = np.corrcoef(predictions, y_test)[0, 1]
    base_rmse = np.sqrt(mean_squared_error(y_test[1:], y_test[:-1]))
    base_corr = np.corrcoef(y_test[:-1], y_test[1:])[0, 1]
    improvement = (base_rmse - rmse) / base_rmse * 100
    corr_gain = corr - base_corr

    # Directional accuracy: does the predicted move match the actual move
    # (between consecutive test points). 50% = coin flip.
    actual_dir = np.sign(np.diff(y_test))
    pred_dir = np.sign(np.diff(predictions))
    mask = actual_dir != 0
    dir_acc = (pred_dir[mask] == actual_dir[mask]).mean() * 100 if mask.sum() else float('nan')

    print(f"\n--- Results ({symbol} {model_name}, target: {target_name}) ---")
    print(f"{'':22}{'MODEL':>12}{'PERSISTENCE':>14}")
    print(f"{'RMSE':22}{rmse:>12.6f}{base_rmse:>14.6f}")
    print(f"{'Correlation':22}{corr:>12.3f}{base_corr:>14.3f}")
    print(f"\nRMSE vs persistence baseline: {improvement:+.1f}%")
    print(f"Correlation GAIN over pure copying: {corr_gain:+.3f}")
    print(f"Directional accuracy: {dir_acc:.1f}%  (50% = coin flip)")
    if corr < 0.1:
        print(">> Correlation near zero: NOT really predicting.")
    elif corr_gain > 0.05 and improvement > 2:
        print(">> Model BEATS persistence and adds REAL value beyond copying.")
    elif improvement > -2:
        print(">> Roughly matches persistence - mostly copies the last value.")
    else:
        print(">> Worse than persistence.")

    # ---------------- 1) Training loss curve ----------------
    if 'loss' in graphs and train_losses.size:
        plt.figure(figsize=(10, 5))
        plt.plot(train_losses, label='Train Loss')
        plt.plot(val_losses, label='Validation Loss')
        plt.title(f'{symbol} {model_name} ({target_name}) Training Process')
        plt.xlabel('Epochs'); plt.ylabel('Loss')
        plt.legend(); plt.grid(True, alpha=0.3); plt.tight_layout(); plt.show()

    # ---------------- 2) Actual vs Predicted ----------------
    if 'prediction' in graphs:
        k = min(n_plot, len(y_test))
        plt.figure(figsize=(14, 7))
        plt.plot(y_test[:k], label=f'Actual {target_name}', color='blue', alpha=0.7)
        plt.plot(predictions[:k], label=f'Predicted {target_name}', color='red', linewidth=1.2)
        plt.title(f'{symbol} {model_name} Prediction Performance ({target_name})\n'
                  f'RMSE={rmse:.5f} | Corr={corr:.2f} | vs baseline {improvement:+.1f}%')
        plt.xlabel('Time Steps (5m intervals)'); plt.ylabel(target_name)
        plt.legend(); plt.grid(True, alpha=0.3); plt.tight_layout(); plt.show()

    # ---------------- 3) Directional accuracy bar ----------------
    if 'direction' in graphs:
        plt.figure(figsize=(5, 5))
        bars = plt.bar(['Model', 'Coin flip'], [dir_acc, 50.0], color=['#2a9d8f', '#bbbbbb'])
        plt.axhline(50, color='gray', linestyle='--', linewidth=0.8)
        plt.ylim(0, 100); plt.ylabel('Directional Accuracy (%)')
        plt.title(f'{symbol} {model_name} Directional Accuracy')
        for b in bars:
            plt.text(b.get_x() + b.get_width() / 2, b.get_height() + 1,
                     f'{b.get_height():.1f}%', ha='center', va='bottom')
        plt.tight_layout(); plt.show()

    # ---------------- 4) Reconstructed price (candles) ----------------
    if 'candles' not in graphs:
        return {'rmse': rmse, 'corr': corr, 'improvement': improvement,
                'corr_gain': corr_gain, 'dir_acc': dir_acc}
    csv_path = os.path.join(base_dir, 'data', f'{symbol}_5m_data.csv')
    try:
        import mplfinance as mpf
        df_raw = pd.read_csv(csv_path)
        bb = ta.volatility.BollingerBands(df_raw['close'], window=20, window_dev=2)
        upper = bb.bollinger_hband().values
        lower = bb.bollinger_lband().values
        test_offset = len(df_raw) - len(predictions)
        df_c = df_raw.iloc[test_offset:].copy()
        df_c['open_time'] = pd.to_datetime(df_c['open_time'])
        df_c = df_c.set_index('open_time')
        pred_price = lower[test_offset:] + (predictions * (upper[test_offset:] - lower[test_offset:]))
        df_c['Predicted_Close'] = pd.Series(pred_price, index=df_c.index).rolling(3).mean().bfill()
        df_plot = df_c.head(n_plot)
        ap = mpf.make_addplot(df_plot['Predicted_Close'], type='line', color='red',
                              linestyle='--', width=1.5, panel=0)
        mpf.plot(df_plot, type='candle', style='yahoo', addplot=ap, volume=True,
                 title=f'{symbol} {model_name} Prediction vs Actual\nRMSE ({target_name}): {rmse:.5f}',
                 ylabel='Price (USDT)', figsize=(14, 8), tight_layout=True)
    except Exception as e:
        print(f"(Candle plot skipped: {e})")

    return {'rmse': rmse, 'corr': corr, 'improvement': improvement,
            'corr_gain': corr_gain, 'dir_acc': dir_acc}
