# `pipeline/` — Redesigned forecasting pipeline (staged, not yet in production)

This is the staged implementation of the modeling items in
[`audit_report.md`](../audit_report.md)'s action plan. It is **kept separate from
the live system**: it reads the same `data/*.csv`, but writes new artifacts to
`models_v2/`. The deployed engine (`inference_orchestrator.py`, `models/*.pth`)
is untouched until you deliberately promote new models.

## What changed vs. the legacy pipeline

| Audit item | Legacy | This pipeline |
|---|---|---|
| #4 Target / objective | next-step Bollinger **%B** (regression only) | **H-step log-return** + **3-class direction head** (UP/FLAT/DOWN) trained jointly |
| #4 Signal | hand-tuned ±0.1% on reconstructed price | classifier with a **volatility dead-band** (abstains when uncertain) |
| #5 Validation | single 80/10/10 chronological split | **walk-forward** (rolling-origin), pooled out-of-sample scoring |
| #6 Features | 16 TA features | + **order flow** (`taker_buy_imb`, `trade_intensity`, `trade_size`) that were already collected but unused |
| #7 Horizon | fixed 5 min | `--horizon {1,3,6,12}` → 5/15/30/60 min |
| RC7 Leakage | global volume mean/std (look-ahead) | **causal rolling** normalization |
| RC1 Metric | %B directional accuracy (artifact) | honest **price direction + binomial p + cost-aware net bps** |

## Files
- `config.py` — all knobs (horizon, dead-band, walk-forward, model sizes).
- `features.py` — causal feature engineering + target/label generation. **Single source of truth for train and inference.**
- `dataset.py` — sequence building + walk-forward folds with train-only scaling.
- `models.py` — `LSTMDual` / `TFTDual` (return head + 3-class head).
- `train.py` — walk-forward trainer, honest OOS evaluation, saves `models_v2/`.
- `infer.py` — production-shaped prediction from a staged model.

## How to run (Google Colab, full history)

```python
# 1. Mount Drive so data/*.csv is the FULL history (not the local 1k-row cache)
from google.colab import drive; drive.mount('/content/drive')
%cd /content/drive/MyDrive/CryptoProject
!pip -q install ta scikit-learn torch joblib scipy

# 2. Train all coins x models at the deployed 5-min horizon
!python -m pipeline.train --all

# 3. Sweep the horizon to see where a real edge appears (audit item #7)
for h in [1, 3, 6, 12]:
    !python -m pipeline.train --all --horizon {h}
```

Each run prints, per fold and pooled across folds:
`DIR% (binomial p), ERR% vs persistence, net bps after cost`, and a
`REAL EDGE: YES/no` verdict (requires p<0.05, DIR>50%, and beating persistence
on ERR). **Only promote a model that earns `REAL EDGE: YES` on the full
history.**

## Verify locally first (no GPU, proves the code runs)
```bash
python -m pipeline.train --smoke        # tiny 2-epoch run on the cached CSV
python -m pipeline.infer                # produces a production-shaped prediction
```
(Smoke-test numbers are meaningless — only ~1k cached candles, 2 epochs — they
just confirm the pipeline executes end-to-end.)

## Promoting to production (only after validation)
1. Confirm `REAL EDGE: YES` (or at least a significant, cost-positive DIR) on the full-history run.
2. Copy the chosen `models_v2/v2_*.pth`, `scaler_*.pkl`, `meta_*.json` into `models/` under new names.
3. In `inference_orchestrator.py`, replace the LSTM/TFT load+predict+reconstruct
   blocks with `pipeline.infer.load_model` / `pipeline.infer.predict` (return-based
   reconstruction; signal from the classifier). Keep ARIMA as the baseline.
4. Re-point `eval_harness.py` at the new history and confirm the live scorecard
   matches the offline OOS estimate before trusting it.

> Expectation: even a fully-tuned model is unlikely to clear ~53–56% robust,
> cost-aware DIR at 5 min (the task is near-efficient — see the audit). The
> horizon sweep exists precisely to find whether 15–60 min is more learnable.
