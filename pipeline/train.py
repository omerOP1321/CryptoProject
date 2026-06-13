"""
Walk-forward trainer for the dual-head (return + direction) models.

For each coin x model:
  * train with joint loss = Huber(return) + w * CrossEntropy(class) over every
    walk-forward fold;
  * collect OUT-OF-SAMPLE test predictions across all folds;
  * score them honestly (price direction + significance + cost-aware edge,
    reusing eval_harness), comparing to a persistence baseline;
  * save the model trained on the most-recent fold + its scaler + metadata to
    models_v2/ (production models in models/ are never touched).

Run:  python -m pipeline.train --model lstm --symbol BTCUSDT
      python -m pipeline.train --all
      python -m pipeline.train --smoke           # tiny end-to-end run on local CSV
"""

import os
import sys
import csv
import json
import argparse
import numpy as np
import pandas as pd
import torch
import torch.nn as nn
from datetime import datetime

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

from pipeline.config import CONFIG, SYMBOLS, OUT_DIR, CLASS_NAMES, feature_list
from pipeline.dataset import load_frame, walk_forward_folds
from pipeline.models import LSTMDual, TFTDual

try:
    from scipy.stats import binomtest
    def _binom_p(k, n):
        return binomtest(k, n, 0.5, alternative="two-sided").pvalue if n else float("nan")
except Exception:
    def _binom_p(k, n):
        return float("nan")

DEVICE = torch.device("cuda" if torch.cuda.is_available() else "cpu")


def _make_model(model_type, n_features, cfg):
    if model_type == "lstm":
        return LSTMDual(n_features, cfg["lstm_hidden"], 2, cfg["dropout"])
    return TFTDual(n_features, cfg["tft_d_model"], cfg["tft_heads"],
                   cfg["tft_layers"], cfg["dropout"])


def _loader(arrs, bs, shuffle):
    X, yr, yc, bc = arrs
    ds = torch.utils.data.TensorDataset(
        torch.tensor(X), torch.tensor(yr), torch.tensor(yc))
    return torch.utils.data.DataLoader(ds, batch_size=bs, shuffle=shuffle)


def _train_one_fold(model, fold, cfg):
    huber = nn.HuberLoss(delta=1.0)
    ce = nn.CrossEntropyLoss()
    w = cfg["cls_loss_weight"]
    opt = torch.optim.AdamW(model.parameters(), lr=cfg["lr"], weight_decay=cfg["weight_decay"])
    sched = torch.optim.lr_scheduler.ReduceLROnPlateau(opt, factor=0.5, patience=3)

    tr = _loader(fold["train"], cfg["batch_size"], True)
    va = _loader(fold["val"], cfg["batch_size"], False)
    best, best_state, bad = np.inf, None, 0

    for epoch in range(cfg["epochs"]):
        model.train()
        for X, yr, yc in tr:
            X, yr, yc = X.to(DEVICE), yr.to(DEVICE), yc.to(DEVICE)
            opt.zero_grad()
            pr, pc = model(X)
            loss = huber(pr, yr) + w * ce(pc, yc)
            loss.backward(); opt.step()
        # validation
        model.eval(); vloss = 0.0; nb = 0
        with torch.no_grad():
            for X, yr, yc in va:
                X, yr, yc = X.to(DEVICE), yr.to(DEVICE), yc.to(DEVICE)
                pr, pc = model(X)
                vloss += (huber(pr, yr) + w * ce(pc, yc)).item(); nb += 1
        vloss = vloss / max(nb, 1)
        sched.step(vloss)
        if vloss < best - 1e-7:
            best, best_state, bad = vloss, {k: v.cpu().clone() for k, v in model.state_dict().items()}, 0
        else:
            bad += 1
            if bad >= cfg["patience"]:
                break
    if best_state:
        model.load_state_dict(best_state)
    return model, best


def _predict(model, arrs, batch_size=4096):
    """Batched inference. The old version pushed the whole test set to the GPU in
    one forward pass, which OOMs on large test folds / seq_length=120."""
    X = arrs[0]
    model.eval()
    prs, pcs = [], []
    with torch.no_grad():
        for i in range(0, len(X), batch_size):
            xb = torch.tensor(X[i:i + batch_size]).to(DEVICE)
            pr, pc = model(xb)
            prs.append(pr.cpu().numpy())
            pcs.append(pc.softmax(-1).cpu().numpy())
    return np.concatenate(prs), np.concatenate(pcs)


def _evaluate(pred_ret, prob_cls, fold_arrs, cost_bps=2.0):
    """Honest OOS scoring on a fold's test set.
    Direction from the classifier (argmax over DOWN/UP, FLAT = no trade).
    Reconstructed price = base * exp(pred_ret); ERR vs persistence (=base)."""
    _, yr, yc, base = fold_arrs
    actual_ret = yr
    actual_dir = np.sign(actual_ret)
    cls = prob_cls.argmax(1)             # 0 DOWN,1 FLAT,2 UP
    pred_dir = np.where(cls == 2, 1, np.where(cls == 0, -1, 0))

    trade = pred_dir != 0
    m = trade & (actual_dir != 0)
    hits = int(((pred_dir[m] > 0) == (actual_dir[m] > 0)).sum())
    n_dir = int(m.sum())
    dir_acc = hits / n_dir * 100 if n_dir else float("nan")

    recon = base * np.exp(pred_ret)
    actual_price = base * np.exp(actual_ret)
    err = np.mean(np.abs(recon - actual_price) / actual_price) * 100
    persist_err = np.mean(np.abs(base - actual_price) / actual_price) * 100

    # cost-aware edge: signed realized return on traded bars, minus round-trip cost
    signed = pred_dir[m] * actual_ret[m]
    gross_bps = float(np.mean(signed) * 1e4) if n_dir else float("nan")
    return {
        "n_test": len(yr), "n_trades": n_dir,
        "dir_acc": dir_acc, "dir_hits": hits, "binom_p": _binom_p(hits, n_dir),
        "err": float(err), "persist_err": float(persist_err),
        "gross_bps": gross_bps, "net_bps": gross_bps - cost_bps,
        "frac_flat": float(np.mean(cls == 1)),
    }


LOG_COLUMNS = [
    "timestamp", "model", "symbol", "horizon_min", "n_features", "use_extra",
    "seq_length", "max_rows", "wf_folds", "epochs", "train_step",
    "deadband_k", "cls_w", "lr", "dropout",
    "DIR", "p", "trades", "ERR", "persist_ERR", "net_bps", "real_edge",
]


def _log_experiment(cfg, model_type, symbol, feats, s):
    """Append one row to models_v2/experiments_log.csv (on Drive, so it survives
    runtime restarts) and regenerate a best-first leaderboard experiments_log.md.
    Runs automatically from run(), so every experiment is captured with its full
    config -> you can track progress and see exactly what produced the best model."""
    os.makedirs(OUT_DIR, exist_ok=True)
    log_csv = os.path.join(OUT_DIR, "experiments_log.csv")
    row = {
        "timestamp": datetime.now().strftime("%Y-%m-%d %H:%M:%S"),
        "model": model_type, "symbol": symbol, "horizon_min": cfg["horizon"] * 5,
        "n_features": len(feats), "use_extra": int(bool(cfg.get("use_extra_features"))),
        "seq_length": cfg["seq_length"], "max_rows": cfg.get("max_rows"),
        "wf_folds": cfg["wf_folds"], "epochs": cfg["epochs"],
        "train_step": cfg.get("train_step", 1), "deadband_k": cfg["deadband_k"],
        "cls_w": cfg["cls_loss_weight"], "lr": cfg["lr"], "dropout": cfg["dropout"],
        "DIR": round(s["dir"], 2), "p": round(s["p"], 4), "trades": s["trades"],
        "ERR": round(s["err"], 4), "persist_ERR": round(s["persist"], 4),
        "net_bps": (round(s["net"], 2) if s["net"] == s["net"] else ""),  # nan -> blank
        "real_edge": s["edge"],
    }
    exists = os.path.exists(log_csv)
    with open(log_csv, "a", newline="") as f:
        w = csv.DictWriter(f, fieldnames=LOG_COLUMNS)
        if not exists:
            w.writeheader()
        w.writerow(row)
    # rebuild a sorted, human-readable leaderboard (no external deps)
    try:
        df = pd.read_csv(log_csv)
        df["_edge"] = (df["real_edge"] == "YES").astype(int)
        df["_net"] = pd.to_numeric(df["net_bps"], errors="coerce").fillna(-9999)
        df = df.sort_values(["_edge", "_net", "DIR"], ascending=False).drop(columns=["_edge", "_net"])
        full = df[df["max_rows"].isna()]
        hdr = list(df.columns)
        def table(d):
            out = ["| " + " | ".join(hdr) + " |", "|" + "|".join(["---"] * len(hdr)) + "|"]
            for _, r in d.iterrows():
                out.append("| " + " | ".join("" if pd.isna(r[h]) else str(r[h]) for h in hdr) + " |")
            return "\n".join(out)
        md = [f"# Experiments leaderboard (auto-generated)\n",
              f"_{len(df)} runs, updated {row['timestamp']}. Sorted best-first: "
              f"REAL EDGE, then net bps, then DIR._\n",
              "## Full-history runs (max_rows blank = decisive)\n",
              (table(full) if len(full) else "_none yet — set MAX_ROWS=None for a decisive run._"),
              "\n## All runs (incl. fast/partial-window probes)\n", table(df)]
        with open(os.path.join(OUT_DIR, "experiments_log.md"), "w") as f:
            f.write("\n".join(md))
    except Exception as e:
        print(f"   (leaderboard rebuild skipped: {e})")
    print(f"   logged -> {log_csv}  ({'appended' if exists else 'created'}; run #{_count(log_csv)})")


def _count(path):
    try:
        with open(path) as f:
            return sum(1 for _ in f) - 1
    except Exception:
        return "?"


def run(model_type, symbol, cfg):
    feats = feature_list(cfg)
    print(f"\n{'='*70}\n{symbol}  {model_type.upper()}  "
          f"(horizon={cfg['horizon']*5}m, seq={cfg['seq_length']}, "
          f"features={len(feats)}{'+extra' if cfg.get('use_extra_features') else ''}, "
          f"train_step={cfg.get('train_step',1)}, folds={cfg['wf_folds']}, "
          f"max_rows={cfg.get('max_rows')})\n{'='*70}")
    df = load_frame(symbol, cfg)
    print(f"  data: {len(df)} rows  {str(df['open_time'].iloc[0])[:10]} -> {str(df['open_time'].iloc[-1])[:10]}")
    cls_counts = df["target_cls"].value_counts().to_dict()
    print(f"  class balance: " + ", ".join(f"{CLASS_NAMES[int(k)]}={int(v)}" for k, v in sorted(cls_counts.items())))

    pred_batch = int(cfg.get("pred_batch", 4096))
    agg, last_fold = [], None
    for fold in walk_forward_folds(df, cfg):
        if len(fold["train"][0]) < 20 or len(fold["test"][0]) < 5:
            continue
        model = _make_model(model_type, len(feats), cfg).to(DEVICE)
        model, vloss = _train_one_fold(model, fold, cfg)
        pr, pc = _predict(model, fold["test"], batch_size=pred_batch)
        res = _evaluate(pr, pc, fold["test"])
        res["fold"] = fold["fold"]; res["val_loss"] = vloss
        agg.append(res); last_fold = (model, fold)
        d = fold["dates"]
        print(f"  fold {fold['fold']}: train {d['train'][0]}..{d['train'][1]} "
              f"test {d['test'][0]}..{d['test'][1]} | "
              f"n={res['n_test']} trades={res['n_trades']} "
              f"DIR={res['dir_acc']:5.1f}% (p={res['binom_p']:.3f}) "
              f"ERR={res['err']:.4f}% vs persist {res['persist_err']:.4f}% "
              f"net={res['net_bps']:+.1f}bps")

    if not agg:
        print("  !! not enough data for any fold")
        return None

    # pooled OOS summary
    tot_hits = sum(r["dir_hits"] for r in agg)
    tot_trades = sum(r["n_trades"] for r in agg)
    pooled_dir = tot_hits / tot_trades * 100 if tot_trades else float("nan")
    pooled_p = _binom_p(tot_hits, tot_trades)
    mean_err = np.mean([r["err"] for r in agg])
    mean_persist = np.mean([r["persist_err"] for r in agg])
    mean_net = np.nanmean([r["net_bps"] for r in agg])  # folds with 0 trades are nan
    beats = "YES" if (pooled_p < 0.05 and pooled_dir > 50 and mean_err < mean_persist) else "no"
    print(f"  --> POOLED OOS: DIR={pooled_dir:.1f}% (p={pooled_p:.3f}, {tot_hits}/{tot_trades}) "
          f"ERR={mean_err:.4f}% vs persist {mean_persist:.4f}%  net={mean_net:+.1f}bps  "
          f"REAL EDGE: {beats}")

    # automatic experiment log (config + result) -> Drive
    _log_experiment(cfg, model_type, symbol, feats,
                    {"dir": pooled_dir, "p": pooled_p, "trades": tot_trades,
                     "err": mean_err, "persist": mean_persist, "net": mean_net, "edge": beats})

    # save the most-recent-fold model as the staged candidate
    os.makedirs(OUT_DIR, exist_ok=True)
    model, fold = last_fold
    import joblib
    tag = f"{model_type}_{symbol}"
    torch.save(model.state_dict(), os.path.join(OUT_DIR, f"v2_{tag}.pth"))
    joblib.dump(fold["scaler"], os.path.join(OUT_DIR, f"scaler_{tag}.pkl"))
    meta = {"symbol": symbol, "model_type": model_type, "features": feats,
            "horizon": cfg["horizon"], "seq_length": cfg["seq_length"],
            "deadband_k": cfg["deadband_k"], "class_names": CLASS_NAMES,
            "use_extra_features": bool(cfg.get("use_extra_features")),
            "pooled_dir": pooled_dir, "pooled_p": pooled_p,
            "mean_err": mean_err, "mean_persist_err": mean_persist}
    with open(os.path.join(OUT_DIR, f"meta_{tag}.json"), "w") as f:
        json.dump(meta, f, indent=2)
    print(f"  saved -> models_v2/v2_{tag}.pth (+ scaler, meta)")
    return meta


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--model", choices=["lstm", "tft"], default="lstm")
    ap.add_argument("--symbol", default="BTCUSDT")
    ap.add_argument("--all", action="store_true", help="every coin x model")
    ap.add_argument("--horizon", type=int, default=None, help="override horizon (candles)")
    ap.add_argument("--smoke", action="store_true", help="tiny fast run to prove the code executes")
    args = ap.parse_args()

    cfg = dict(CONFIG)
    if args.horizon:
        cfg["horizon"] = args.horizon
    if args.smoke:
        cfg.update(seq_length=20, epochs=2, wf_folds=2, vol_window=96,
                   wf_test_frac=0.15, wf_val_frac=0.15, batch_size=64, smoke=True)

    combos = ([(m, s) for m in ("lstm", "tft") for s in SYMBOLS] if args.all
              else [(args.model, args.symbol)])
    for m, s in combos:
        run(m, s, cfg)


if __name__ == "__main__":
    main()
