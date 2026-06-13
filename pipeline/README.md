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

## How to run (Google Colab) — `pipeline/v2_train_colab.ipynb`

Self-contained (only `data/*.csv` needs to be on Drive — **not** the `pipeline/`
folder). It's an **experiment workbench**, not a run-all script:

- **First time / after restart:** run Cell 1 (setup) → 2 (engine code) → 3 (config) → 4 (run one experiment).
- **Iterate fast:** edit the knobs in **Cell 3**, re-run Cell 3 + Cell 4. Each
  experiment tests one model/coin/horizon with a default **fast** config
  (`max_rows=150k`, `wf_folds=1`, `epochs=8`, `train_step=2`).
- **Sweep** horizons / coins / feature-sets in Cell 5.
- **Deploy:** Cell 6 trains the full-quality 5-minute models for the dashboard.

Speed knobs (in `config.py`, overridable per run): `max_rows` (subsample recent
history), `train_step` (training-window stride), `wf_folds`, `epochs`,
`pred_batch` (batched inference — fixes the seq_length=120 OOM).
Feature lever: `use_extra_features=True` adds 8 causal features (volatility /
sustained order-flow / multi-timeframe) → 26 total.

> The notebook is generated from the `.py` modules in this folder, so keep the
> two in sync: if you change a module, regenerate the notebook (ask Claude) so
> the inlined copy matches what `infer.py` uses in production.

Prefer the CLI instead? On a machine that has the repo checked out (incl. `pipeline/`):

```bash
python -m pipeline.train --all                 # all coins x models, 5-min
for h in 1 3 6 12; do python -m pipeline.train --all --horizon $h; done  # sweep
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

## Live champion/challenger (already wired)

You do **not** need to change `inference_orchestrator` to compare. The v2
inference code is **inlined** there (classes + `compute_features_v2` +
`v2_load_model` / `v2_predict`), so as soon as `models_v2/` exists on Drive the
engine loads it and pushes `LSTM_v2` / `Transformer_v2` alongside the legacy
models. The dashboard shows both sets of cards (same ERR/DIR scoring) and chart
overlays. Until the artifacts exist, the engine runs legacy-only.

> The inlined defs in `inference_orchestrator` are copies of `features.py` /
> `models.py` / `infer.py`. If you change those modules, re-inline (ask Claude)
> so the live engine matches what trained the weights.

## Promoting (retiring the legacy models, only after validation)
1. Confirm `REAL EDGE: YES` (or at least a significant, cost-positive DIR) on the full-history run.
2. Let v2 run live for a while and confirm its dashboard ERR/DIR matches the offline OOS estimate.
3. Once v2 clearly wins, you can drop the legacy LSTM/TFT blocks and make v2 the default (keep ARIMA as a baseline).

> Expectation: even a fully-tuned model is unlikely to clear ~53–56% robust,
> cost-aware DIR at 5 min (the task is near-efficient — see the audit). The
> horizon sweep exists precisely to find whether 15–60 min is more learnable.
