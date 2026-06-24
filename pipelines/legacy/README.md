# `pipelines/legacy/` — Original (legacy) forecasting pipeline

The **first-generation** modeling workflow. It produces the production weights in
the repo-root `models/` folder that the live engine (`serving/`) serves today.

This pipeline is notebook-driven and runs on **Google Colab** (GPU). It reads the
shared candle data in the repo-root `data/` folder.

## Layout

```
legacy/
├── preprocessing/        # build model-ready sequences from data/*.csv
│   ├── lstm/             # preprocessing_{BTC,ETH,XRP}_LSTM.ipynb
│   └── transformer/      # preprocessing_{BTC,ETH,XRP}_transformer.ipynb
├── training/             # train the models -> repo-root models/
│   ├── lstm/             # lstm_trainer_{BTC,ETH,XRP}.ipynb
│   └── transformer/      # transformer_trainer_{BTC,ETH,XRP}.ipynb
└── evaluation/
    ├── crypto_eval.py    # shared eval + plotting; trainers save a bundle via save_eval_bundle()
    └── eval_graphs.ipynb # render the saved evaluation bundles
```

## Flow

```
data/*.csv  →  preprocessing/  →  training/  →  models/  →  served by serving/
```

## Notes

- The trainer notebooks import the shared module with
  `sys.path.append(BASE_DIR); from crypto_eval import save_eval_bundle`, where
  `BASE_DIR` is the project root (your Google Drive root on Colab, or the working
  directory locally). Keep `crypto_eval.py` reachable on that path when training.
- This is the **legacy** approach. The redesigned pipeline lives in
  [`../v2/`](../v2/README.md) and writes to `models_v2/`. Both run **alongside**
  each other in the live engine (champion vs. challenger).
- The honest re-evaluation that motivated the redesign is in
  [`../../docs/audit_report.md`](../../docs/audit_report.md).
