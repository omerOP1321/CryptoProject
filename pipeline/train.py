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
import json
import argparse
import numpy as np
import torch
import torch.nn as nn

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

from pipeline.config import CONFIG, FEATURES, SYMBOLS, OUT_DIR, CLASS_NAMES
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


def _predict(model, arrs):
    X = torch.tensor(arrs[0]).to(DEVICE)
    model.eval()
    with torch.no_grad():
        pr, pc = model(X)
    return pr.cpu().numpy(), pc.softmax(-1).cpu().numpy()


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


def run(model_type, symbol, cfg):
    print(f"\n{'='*64}\n{symbol}  {model_type.upper()}  "
          f"(horizon={cfg['horizon']*5}m, seq={cfg['seq_length']})\n{'='*64}")
    df = load_frame(symbol, cfg)
    print(f"  rows after features/targets: {len(df)}  | features: {len(FEATURES)}")
    cls_counts = df["target_cls"].value_counts().to_dict()
    print(f"  class balance: " + ", ".join(f"{CLASS_NAMES[int(k)]}={int(v)}" for k, v in sorted(cls_counts.items())))

    agg, last_fold = [], None
    for fold in walk_forward_folds(df, cfg):
        if len(fold["train"][0]) < 20 or len(fold["test"][0]) < 5:
            continue
        model = _make_model(model_type, len(FEATURES), cfg).to(DEVICE)
        model, vloss = _train_one_fold(model, fold, cfg)
        pr, pc = _predict(model, fold["test"])
        res = _evaluate(pr, pc, fold["test"])
        res["fold"] = fold["fold"]; res["val_loss"] = vloss
        agg.append(res); last_fold = (model, fold)
        print(f"  fold {fold['fold']}: test n={res['n_test']:4d} trades={res['n_trades']:4d} "
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
    mean_net = np.mean([r["net_bps"] for r in agg])
    beats = "YES" if (pooled_p < 0.05 and pooled_dir > 50 and mean_err < mean_persist) else "no"
    print(f"  --> POOLED OOS: DIR={pooled_dir:.1f}% (p={pooled_p:.3f}, {tot_hits}/{tot_trades}) "
          f"ERR={mean_err:.4f}% vs persist {mean_persist:.4f}%  net={mean_net:+.1f}bps  "
          f"REAL EDGE: {beats}")

    # save the most-recent-fold model as the staged candidate
    os.makedirs(OUT_DIR, exist_ok=True)
    model, fold = last_fold
    import joblib
    tag = f"{model_type}_{symbol}"
    torch.save(model.state_dict(), os.path.join(OUT_DIR, f"v2_{tag}.pth"))
    joblib.dump(fold["scaler"], os.path.join(OUT_DIR, f"scaler_{tag}.pkl"))
    meta = {"symbol": symbol, "model_type": model_type, "features": FEATURES,
            "horizon": cfg["horizon"], "seq_length": cfg["seq_length"],
            "deadband_k": cfg["deadband_k"], "class_names": CLASS_NAMES,
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
