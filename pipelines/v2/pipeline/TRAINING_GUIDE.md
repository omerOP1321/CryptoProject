# v2 Training Guide — `v2_train_colab.ipynb`

A complete, verified manual for training the v2 crypto forecasting models from
scratch and getting the best one onto the website. Written for someone who has
never seen this project before. Every claim below was verified against the
actual notebook code (and against `serving/inference_orchestrator.py` for the
deployment section).

---

## 0. The big picture (read this first)

The system is a chain of four independent pieces. The notebook you are about to
use is only piece 2:

```
1. data_collection/data_fetch.ipynb   -> downloads 5-minute candles from Binance
                                         and writes {SYMBOL}_5m_data.csv to
                                         Google Drive: MyDrive/CryptoProject/data/

2. pipelines/v2/pipeline/v2_train_colab.ipynb   (THIS NOTEBOOK, run on Colab)
                                      -> trains models, writes artifacts to
                                         MyDrive/CryptoProject/models_v2/60min/

3. serving/inference_orchestrator.py  -> on startup, downloads the whole
                                         models_v2/60min/ folder from Drive,
                                         loads the models, and pushes live
                                         predictions to Supabase every cycle

4. Website (Vercel dashboard)         -> reads predictions from Supabase and
                                         displays v2 cards/overlays next to the
                                         legacy models
```

Key consequence: **"uploading the model to the website" means nothing more than
making sure the trained files are in `MyDrive/CryptoProject/models_v2/60min/`
on Google Drive and restarting the orchestrator.** If you train on Colab with
Drive mounted (the normal path), the notebook already writes them there — there
is no separate upload step.

What the models do: each model looks at the last 60 five-minute candles
(features derived from price, volume, and order flow) and predicts, 60 minutes
ahead, both (a) the log-return (a number) and (b) the direction as a 3-class
call: UP / FLAT / DOWN. The FLAT class is an "abstain — don't trade" signal.

There are two model architectures, trained per coin (BTC, ETH, XRP), giving
6 deliverable models total:

| Architecture | Class in code | Description |
|---|---|---|
| `lstm` | `LSTMDual` | 2-layer LSTM + attention + shared MLP, two heads (return + class) |
| `tft`  | `TFTDual`  | Simplified Temporal Fusion Transformer: variable-selection network + positional encoding + Transformer encoder, same two heads |

---

## 1. Prerequisites

Before opening the notebook, you need:

1. **A Google account with access to the project Drive folder**
   `MyDrive/CryptoProject/`. Everything (data in, models out) lives there.
2. **Fresh candle data on Drive.** The notebook expects these files to exist:
   - `data/BTCUSDT_5m_data.csv`
   - `data/ETHUSDT_5m_data.csv`
   - `data/XRPUSDT_5m_data.csv`

   If they are missing or stale, run `data_collection/data_fetch.ipynb`
   (Run All) first — it downloads/extends the CSVs from Binance.
3. **Google Colab with a GPU runtime.** Open the notebook in Colab, then
   `Runtime → Change runtime type → GPU (T4 is fine)`. Training works on CPU
   but is many times slower. Cell 1 prints `device = cuda` when the GPU is
   active — check that line.
4. No local installs needed — Cell 1 pip-installs everything
   (`ta`, `scikit-learn`, `torch`, `joblib`, `scipy`, `pandas`, `numpy`, `tqdm`).

---

## 2. Map of the notebook

**Naming note:** the cells carry labels in their first comment line
("Cell 1", "Cell 4.5", ...); because of the 2 markdown cells at the top and the
decimal-numbered optional cells, a label doesn't equal the physical position.
This guide always uses the **labels** (the notebook's top markdown cell now
contains the same map):

| Label | Purpose | When to run | Depends on |
|---|---|---|---|
| Cell 1 — SETUP | pip installs, imports, mounts Drive, defines `BASE_DIR`/`DATA_DIR`/`OUT_DIR` | Once per session (and after every runtime restart) | nothing |
| Cell 1.5 — FETCH ON-CHAIN | Downloads daily CoinMetrics data to `data/{SYMBOL}_onchain.csv` | Only if you will set `USE_ONCHAIN = True`; skips files that already exist | Cell 1 |
| Cell 2 — ENGINE | Defines everything: `CONFIG`, feature engineering, dataset/walk-forward, Boruta selection, both model classes, the trainer `run()`, logging, and inference helpers | Once per session; re-run only if you edit it | Cell 1 |
| Cell 3 — CONFIG | Sets `MODEL`, `SYMBOL`, `HORIZON`, speed knobs, feature switches; builds the `CFG` dict | Every time you change an experiment parameter | Cell 2 (uses `CONFIG`) |
| Cell 4 — RUN ONE EXPERIMENT | `run(MODEL, SYMBOL, CFG)` — trains, evaluates, logs, saves | After each Cell 3 edit | Cells 1–3 |
| Cell 4.5 — FEATURE SELECTION (Boruta) | Runs Boruta per coin, fills `SELECTED{}`, saves `selected_features.json` | Optional; only for *manual* feature selection (see §4) | Cells 1–3 |
| Cell 4.6 — LOAD saved selection | Reloads `SELECTED{}` from Drive after a restart | Instead of re-running Cell 4.5 | Cells 1–3 |
| Cell 5 — FULL GRID SWEEP | All 24 combos: {lstm,tft} × {BTC,ETH,XRP} × {5,15,30,60 min} | Optional exploration | Cells 1–3 |
| Cell 6 — LEADERBOARD | Displays every logged experiment, best first | Any time | Cell 1 only |
| Cell 6.5 — HORIZON SWEEP | Cheap LSTM-only probe of one or more horizons across all coins | Optional, before committing to Cell 7 | Cells 1–3 |
| Cell 6.6 — QUICK AUTO-SELECT TEST | Fast full-history LSTM check of the current CFG on all 3 coins | Optional sanity check before Cell 7 | Cells 1–3 |
| Cell 6.7 — THREE-WAY FEATURE COMPARISON | full pool vs Boruta-confirmed vs top-10, per coin (9 runs, ~45 min) | Optional feature-set research | Cells 1–3 |
| Cell 7 — TRAIN THE 6 DELIVERABLE MODELS | Full-history, 3-fold, 12-epoch training of tft+lstm for all 3 coins at 60 min; resumable | The production run (~1.5–2 h on GPU) | Cells 1–3 |
| Cell 8 — INFERENCE TEST | Loads every saved 60-min model and prints a live-style signal | After Cell 7, as a smoke check | Cells 1, 2, 7 artifacts |

### The minimal paths

- **Quick experiment:** Cell 1 → Cell 2 → Cell 3 → Cell 4.
- **Produce and deploy the 6 website models:** Cell 1 → Cell 2 → Cell 3 →
  Cell 7 → Cell 8 (verify) → restart orchestrator.
- **After any runtime restart:** you must re-run Cell 1, Cell 2, Cell 3 before
  anything else — all definitions live in RAM and are lost on restart. Trained
  artifacts and the experiment log are on Drive and survive.

Everything else (1.5, 4.5, 4.6, 5, 6.x) is optional tooling around those two
paths.

---

## 3. Step 1 — Prepare the environment (Cell 1)

Run Cell 1. It will:

1. Install the Python packages.
2. Ask you to authorize Google Drive — approve it.
3. Set `BASE_DIR = /content/drive/MyDrive/CryptoProject`,
   `DATA_DIR = .../data`, `OUT_DIR = .../models_v2`.
4. Assert that `data/` exists and print the CSV files it found, the device
   (`cuda` or `cpu`), and the path of the experiment log.

**Check the printout:** you want `device = cuda` and all three
`*_5m_data.csv` files listed. If `data/` is missing it raises an
AssertionError — go back to Prerequisites step 2.

Then run Cell 2. It produces no interesting output — it just defines ~40 KB of
engine code (config, features, dataset, models, trainer, inference). If you
ever edit Cell 2, re-run it and then re-run Cell 4/7 — nothing picks up the
edit automatically.

*(Cell 1.5 — only needed if you plan to experiment with on-chain features.
The final deployable run, Cell 7, has on-chain switched OFF because it hurt
performance in testing, so most users can skip Cell 1.5 entirely.)*

---

## 4. Step 2 — Understand the data pipeline (what happens when you train)

You don't run these steps by hand — `run()` does all of it — but you need to
know the order to reason about results:

1. **Load** `data/{SYMBOL}_5m_data.csv` (raw Binance klines: OHLCV +
   `quote_asset_volume`, `number_of_trades`, `taker_buy_base_asset_volume`).
2. **Feature engineering** (`compute_features`): computes ALL features (base +
   extra) causally — every feature at time *t* uses only data up to *t*.
   Volume/order-flow features use rolling z-scores, never global statistics
   (the legacy pipeline's look-ahead leak is fixed here).
3. **(Optional) on-chain merge:** daily CoinMetrics metrics joined onto the 5-min
   grid with a +1-day shift so today's candle never sees today's (incomplete)
   daily metric.
4. **Targets** (`make_targets`):
   - `target_ret` = log-return H candles ahead.
   - `target_cls` = UP if the return exceeds +k·σ, DOWN if below −k·σ, FLAT
     otherwise, where σ is the causal rolling volatility scaled to the horizon
     and k = `deadband_k` (0.33). The dead-band stops the model being graded on
     microscopic, untradeable moves.
5. **Drop warm-up rows** (NaNs from rolling windows) and optionally cap to the
   most recent `max_rows` candles.
6. **Walk-forward splits** (`walk_forward_folds`): instead of one train/test
   split, the test window slides backwards from the end of the series
   (`wf_folds` folds, each `wf_test_frac`=10% of the data, with a 10%
   validation block before it). The feature scaler (StandardScaler) is fit on
   each fold's TRAIN slice only — no leakage. The last `horizon` rows of the
   train and validation blocks are **purged** (dropped), because a window
   ending there carries a label from inside the next block (López de Prado
   2018, ch. 7). Disable with `PURGE = False`.
7. **Sequencing:** rows are windowed into sequences of `seq_length`=60 candles;
   the target belongs to the last candle of each window.
8. **Training:** joint loss = Huber(predicted return) + `cls_loss_weight` ×
   CrossEntropy(direction class, with inverse-frequency class weights and
   label smoothing 0.05), AdamW with linear warmup → cosine LR decay,
   global-norm gradient clipping (1.0), mixed precision on CUDA, early
   stopping on validation loss (`patience`=6). Runs are seeded (`SEED`) for
   reproducibility. The research basis for each technique is tabulated in the
   notebook's legend cell.
9. **Evaluation:** out-of-sample test predictions from all folds are pooled and
   scored (see §7).
10. **Saving + logging:** the **fold-0 model** (the one trained on the largest,
    most-recent window), its scaler, and a metadata JSON go to
    `models_v2/{horizon×5}min/`; one row is appended to
    `models_v2/experiments_log.csv` and the markdown leaderboard is rebuilt.
    With `PLOTS = True`, each run also renders loss curves, the pooled
    out-of-sample equity curve (cumulative net bps), and a confusion matrix.

---

## 5. Step 3 — Select features

### Where features are defined

All in Cell 2 (top section, mirroring `pipelines/v2/pipeline/config.py`):

- **`FEATURES_BASE` — 18 features, always on:**
  `log_ret`, `rsi`, `rsi_change`, `rsi_accel`, `macd`, `macd_slope`,
  `bb_pband_change`, `ma_dist`, `volume_z`, `vol_spike`, `adx`, `hour_sin`,
  `hour_cos`, `mom_3`, `mom_5`, plus order flow: `taker_buy_imb`,
  `trade_intensity`, `trade_size`.
- **`FEATURES_EXTRA` — 8 more, switched by `USE_EXTRA_FEATURES` in Cell 3:**
  `rv` (realized vol), `atr_pct`, `buy_imb_ma`, `cvd_z`, `trend_mtf`,
  `range_pos`, `dist_hi20`, `dist_lo20`. Total 26.
- **`FEATURES_ONCHAIN` — 4 more, switched by `USE_ONCHAIN` in Cell 3:**
  `onch_adr_z`, `onch_adr_chg`, `onch_tx_z`, `onch_nvt_z`. Total 30.
  Requires Cell 1.5 to have been run once; **if the on-chain CSVs are missing,
  these features are silently filled with 0.0** (a warning is printed — watch
  for it).

The function `feature_list(cfg)` resolves what a run actually uses, with this
precedence: an explicit `cfg['selected_features']` list wins; otherwise base
(+ extra if on) (+ on-chain if on).

### Three ways to control the feature set

1. **Switches (simplest):** edit `USE_EXTRA_FEATURES` / `USE_ONCHAIN` in
   Cell 3, re-run Cell 3 + Cell 4.
2. **Automatic Boruta (`AUTO_SELECT = True` in Cell 3, the default):** inside
   every `run()`, a Boruta selection is executed for that coin: 8 random-forest
   fits on an 80k-row sample of the *training region only*; a feature is kept
   if its importance beats the best shuffled "shadow" copy in ≥60% of runs.
   The confirmed subset is used for training, cached in-session per
   (coin, pool, horizon), and saved to
   `models_v2/{h}min/selected_features.json`. This adds a few minutes per coin.
3. **Manual list:** set `CFG['selected_features'] = [...]` after running
   Cell 3, then run Cell 4. Cells 4.5/4.6 exist to produce such lists
   (`SELECTED[symbol]`) explicitly, e.g.
   `CFG['selected_features'] = SELECTED[SYMBOL]`.

### Adding a brand-new feature

Two edits in Cell 2: compute the column inside `compute_features()` (keep it
causal — rolling/shifted only, no global statistics), and add its name to
`FEATURES_BASE` or `FEATURES_EXTRA`. Re-run Cell 2, then Cell 3 + 4.
**Also make the same edits in `pipelines/v2/pipeline/features.py`/`config.py`
and in the inlined copy inside `serving/inference_orchestrator.py`** — the
notebook is a generated inline copy of those modules, and inference must
compute the exact same features (see the warning in `pipelines/v2/README.md`).

### ⚠️ On-chain features and deployment

The inference path (`predict()` in Cell 2, and the orchestrator's inlined copy)
computes technical features only — it does **not** merge on-chain data. A model
whose metadata lists `onch_*` features will crash at inference with a missing-
column error. This is consistent with Cell 7 keeping `USE_ONCHAIN_FINAL = False`.
**Never deploy a model trained with on-chain features** unless you first extend
the inference code.

---

## 6. Step 4 — Choose the model, Step 5 — Train

### Quick experiments (Cells 3 + 4)

Cell 3 is an **interactive Colab form** — dropdowns, sliders, and checkboxes
appear next to the code (outside Colab it behaves as plain Python). Change a
value, re-run Cell 3, then Cell 4. The knobs:

| Knob | Values | Meaning |
|---|---|---|
| `MODEL` | `'lstm'` / `'tft'` | which architecture |
| `SYMBOL` | `'BTCUSDT'` / `'ETHUSDT'` / `'XRPUSDT'` | which coin |
| `HORIZON` | 1 / 3 / 6 / 12 | candles ahead = 5 / 15 / 30 / 60 minutes |
| `FULL_HISTORY` / `MAX_ROWS` | checkbox / integer | `FULL_HISTORY` unchecked = cap to the most recent `MAX_ROWS` candles; checked = full history. **Only full-history runs are decisive** |
| `WF_FOLDS` | 1–5 | walk-forward folds; 1 = fastest, 3–5 = robust |
| `EPOCHS` / `TRAIN_STEP` | — | fewer epochs / larger stride = faster, noisier |
| `USE_EXTRA_FEATURES`, `USE_ONCHAIN`, `AUTO_SELECT` | bool | feature levers (§5) |
| `SEED`, `PURGE`, `CLASS_WEIGHTS`, `LABEL_SMOOTHING`, `GRAD_CLIP`, `AMP`, `PLOTS` | — | training-engine levers; the defaults are the research-backed settings — leave them unless you're ablating |

Rough timings on a Colab T4 (derived from the notebook's own comments and ETA
math; scale with data size, folds, and epochs):

| Run type | Approx. time |
|---|---|
| One fast experiment (`MAX_ROWS=150k`, 1 fold, 8 epochs) | a few minutes |
| One full-history LSTM run (2 folds, 8 epochs, `train_step=2`) | ~5 min (Cell 6.7 does 9 of these in ~45 min) |
| Boruta selection | ~2–5 min per coin |
| Cell 5 full grid (24 fast runs) | ~1–2 h with the fast CFG |
| Cell 7 deliverable run (6 models, full history, 3 folds, 12 epochs) | **~1.5–2 h total (~15–20 min per model)** |

LSTM vs TFT: comparable parameter counts (hidden 64 vs d_model 32, 2 layers
each); the TFT is somewhat slower per epoch due to the variable-selection
network and attention, and can be less stable on small feature sets. Neither is
universally better here — that is exactly what the experiment log is for
(compare them per coin on the leaderboard). Historically both hover around
50–52% direction accuracy at short horizons; 60 min is the product horizon
because it tested most learnable.

### The deliverable run (Cell 7)

Cell 7 trains all 6 website models in one go: BTC/ETH/XRP × TFT/LSTM at
`PRODUCT_HORIZON = 12` (60 min), full history, 3 folds, 12 epochs, extra
features ON, on-chain OFF, per-coin Boruta auto-selection ON.

- It is **resumable**: each finished model is recorded in
  `models_v2/60min/deploy_done.json`; if Colab disconnects, just re-run
  Cell 1 → 2 → 3 → 7 and it skips the completed ones.
- To force a full retrain, delete `models_v2/60min/deploy_done.json` from
  Drive.
- The `SKIP` set (default `set()`) lets you force-skip specific (coin, model)
  pairs; normally leave it empty — finished pairs are auto-skipped via
  `deploy_done.json`.

---

## 7. Step 6 — Evaluate results and pick the best model

### The metrics (printed per fold and pooled; logged per run)

| Metric | Meaning | Good looks like |
|---|---|---|
| `DIR` | Direction accuracy on bars where the model actually traded (predicted UP or DOWN; FLAT = abstain) | > 50% (50% = coin flip) |
| `p` | Two-sided binomial p-value of that hit count | < 0.05 (edge is statistically real, not luck) |
| `trades` | Number of traded bars pooled across folds | more = more reliable p |
| `ERR` vs `persist_ERR` | Mean absolute % error of the reconstructed price vs. the "price doesn't move" baseline | `ERR < persist_ERR` |
| `net_bps` | Mean signed return per trade in basis points, **minus 2 bps round-trip cost** | > 0 (tradeable after costs) |
| `mcc` | Matthews correlation over all 3 classes (UP/FLAT/DOWN) — robust to class imbalance, unlike accuracy | > 0 (0 = no skill) |
| `sharpe` | Per-trade Sharpe ratio (mean/std of signed returns on traded bars; not annualized) | > 0, higher = steadier edge |
| `seed` | The run's random seed — same config + same seed reproduces the run | — |
| `REAL EDGE` | `YES` only if all three hold: p < 0.05 AND DIR > 50% AND ERR < persist_ERR | YES |

### How to compare runs

Every `run()` automatically appends a row (full config + results) to
`models_v2/experiments_log.csv` on Drive and rebuilds
`models_v2/experiments_log.md`. Run **Cell 6** at any time to see the
leaderboard, sorted best-first by: REAL EDGE, then `net_bps`, then `DIR`.

Rules of thumb, straight from the notebook's own guidance:

- **Only trust rows where `max_rows` is blank** (full history). Fast probes
  with `MAX_ROWS=150k` are for direction-finding only.
- A model is worth deploying if it earns `REAL EDGE: YES` — or at minimum a
  significant, cost-positive DIR — on the full-history run.
- Expect modest numbers: ~51–52% DIR is normal at short horizons; this market
  is near-efficient. A claimed 60% DIR on a fast probe is almost certainly
  noise — re-run with `MAX_ROWS=None` and more folds before believing it.

There is no automated "promote the single best model" step: the product ships
all 6 models (both architectures per coin) and the dashboard compares them
live. Your job before deploying is to confirm on the leaderboard that the
Cell 7 runs are sane (DIR near or above 50%, ERR not far above persistence),
and to investigate anything anomalous before promoting.

---

## 8. Step 7 — Export, Step 8 — Deploy to the website

### What gets saved, and where

At the end of every `run()`, three files per (model, coin) are written to
`MyDrive/CryptoProject/models_v2/{horizon×5}min/` — for the deliverable run
that is `models_v2/60min/`:

| File | Contents | Needed in production? |
|---|---|---|
| `v2_{model}_{SYMBOL}.pth` | PyTorch weights (e.g. `v2_lstm_BTCUSDT.pth`) | **Yes** |
| `scaler_{model}_{SYMBOL}.pkl` | The fold's fitted StandardScaler (joblib) | **Yes** — inference must scale features identically |
| `meta_{model}_{SYMBOL}.json` | Feature list, horizon, seq_length, deadband, class names, pooled OOS scores | **Yes** — inference reads the feature list and shapes from here |

A full deliverable set is therefore **18 files** (3 coins × 2 models × 3
files). Also in `models_v2/`: `experiments_log.csv/.md` (bookkeeping),
`60min/selected_features.json` and `60min/deploy_done.json` (training-side
records) — the orchestrator does not need these, but they ride along harmlessly.

### Verify before deploying

Run **Cell 8**. It loads every saved 60-min model and prints one live-style
signal per model, e.g.
`BTCUSDT lstm: LONG +0.123% probs={DOWN:0.21, FLAT:0.31, UP:0.48} h=60m feats=14`.
All 6 models should print without errors. A `FileNotFoundError` for a
model means its Cell 7 run didn't finish — check `deploy_done.json` and re-run
Cell 7. (Cell 8 is hard-coded to `horizon_min=60`; if you ever change
`PRODUCT_HORIZON`, update Cell 8 too.)

### Deployment mechanics (verified in `serving/inference_orchestrator.py`)

- The orchestrator has the v2 model/feature/inference code **inlined** — it
  needs only the artifacts, not this notebook or the `pipeline/` folder.
- On startup it downloads **the entire `models_v2/60min/` Drive folder**
  (`V2_HORIZON_MIN = 60` in the orchestrator; must match your
  `PRODUCT_HORIZON × 5`), loads all six models, and pushes their predictions
  to Supabase as `LSTM_v2` / `Transformer_v2` alongside the legacy models.
- The Vercel dashboard reads Supabase — no website-side change is needed.

So the deploy procedure is:

1. Confirm the 18 files exist in `MyDrive/CryptoProject/models_v2/60min/`
   (they will, if Cell 7 ran on Colab with Drive mounted; if you trained
   anywhere else, copy the 18 files into that exact Drive folder).
2. Restart the inference orchestrator (`serving/run_engine.bat` /
   `run_engine.command`, or re-run `serving/inference_orchestrator.ipynb`).
   It re-downloads the folder on init.
3. Check its startup log: it prints how many v2 artifacts it loaded, and warns
   "No v2 artifacts found" if the folder was empty.
4. Open the dashboard and confirm the `LSTM_v2` / `Transformer_v2` cards
   appear and update.

New models **overwrite** old ones file-by-file (same filenames). If you want a
rollback point, copy the current `models_v2/60min/` to a backup folder on
Drive before re-running Cell 7.

---

## 9. Known issues, stale cells, and recommended cleanup (all verified)

1. **The `pipeline/*.py` modules lag the notebook.** The notebook's training
   engine was upgraded on 2026-07-18 (fold-0 deploy fix, purged walk-forward,
   AdamW+cosine, AMP, class weights, label smoothing, MCC/Sharpe logging), but
   `train.py` / `dataset.py` in `pipelines/v2/pipeline/` still have the old
   code — including the old bug where the *oldest* fold's model was saved.
   Deployment is unaffected (the orchestrator inlines only `features.py` /
   `models.py` / `infer.py`, which did not change), but don't train via
   `python -m pipeline.train` until the modules are re-synced.
2. **Cells 4.5/4.6 are redundant for normal use:** with `AUTO_SELECT = True`
   (the Cell 3 default), Boruta already runs inside every `run()`. Note that
   Cell 7 **never** reads the `SELECTED` dict or the saved JSON — it always
   runs its own fresh per-coin Boruta. Cells 4.5/4.6 only matter for Cell 4
   runs where you explicitly set `CFG['selected_features']`, or for inspecting
   rankings.
3. **Stale line in `pipelines/v2/README.md`:** "Deploy: Cell 6 trains the
   full-quality 5-minute models" — deployment training is Cell 7, at 60 min.

*(Cleanup applied 2026-07-18: removed an unlabeled duplicate experiment cell
and the one-off "Cell 6.8" XRP check; cleared the stale `SKIP` set in Cell 7;
corrected the wrong "Cell 7 auto-uses SELECTED" comment in Cell 4.5; fixed the
stale horizon comment in Cell 6.5 and the feature-count print in Cell 3; the
notebook's top markdown cell now carries the full cell-map legend.)*

*(Engine upgrade applied 2026-07-18: fold-0 deploy save — fixes the
oldest-fold bug; purged walk-forward joins; AdamW + warmup→cosine LR;
mixed precision; gradient clipping; class-weighted + label-smoothed CE;
seeded runs; MCC + per-trade Sharpe added to the log, leaderboard, and
`meta_*.json`; the old `experiments_log.csv` is migrated in place to the new
columns automatically on the first logged run; Cell 3 is now an interactive
Colab form; diagnostic plots after every run. Model architectures, features,
and artifact formats are unchanged — existing deployed models and the
orchestrator's inlined inference code remain fully compatible.)*

---

## 10. Common mistakes checklist

- ❌ Trusting a `MAX_ROWS=150_000` result. Fast probes are for triage only;
  decisive numbers need `MAX_ROWS = None`.
- ❌ Forgetting to re-run Cell 3 after editing it (the `CFG` dict is built when
  the cell runs, not when you type).
- ❌ Editing Cell 2 (engine) and re-running only Cell 4 — re-run Cell 2 first.
- ❌ Setting `USE_ONCHAIN = True` without running Cell 1.5 — on-chain features
  silently become all-zeros (only a printed warning tells you).
- ❌ Leaving an old `deploy_done.json` on Drive (or a populated `SKIP` set in
  Cell 7) — both silently skip training.
- ❌ Running on a CPU runtime (check Cell 1's `device =` printout).
- ❌ Training with stale CSVs — re-run `data_fetch.ipynb` first so the models
  see recent candles (especially important given issue #1 in §9).
- ❌ Changing `PRODUCT_HORIZON` without updating `V2_HORIZON_MIN` in
  `serving/inference_orchestrator.py` and `horizon_min=60` in Cell 8.
- ❌ Deploying a model trained with on-chain features (inference can't compute
  them — it will crash; see §5).
- ❌ Changing feature code in the notebook only — keep `pipeline/*.py` and the
  inlined copies in `inference_orchestrator` in sync, or live predictions will
  be computed from different features than the weights were trained on.
