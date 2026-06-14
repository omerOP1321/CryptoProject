"""
Fetch daily ON-CHAIN metrics and cache them to data/{symbol}_onchain.csv.

Source: CoinMetrics *community* API (free, no API key, covers btc/eth/xrp).
    https://docs.coinmetrics.io/api/v4

This is the one input the experiment grid never tried: every run so far reshaped
the same OHLCV/order-flow data 50 ways and stayed pinned at 50-53% DIR. On-chain
metrics (active addresses, transaction count, transfer value, market cap -> NVT)
carry information that is *independent* of price/technicals, so they are the only
remaining lever with a non-trivial chance of moving direction accuracy.

Causality note: a daily metric for UTC day D summarizes the WHOLE day and is only
knowable after D closes. The leakage-safe alignment (shift +1 day) is handled in
features.merge_onchain(); this script only downloads the raw daily series.

Run:  python -m pipeline.fetch_onchain            # all symbols, full history
      python -m pipeline.fetch_onchain --symbol BTCUSDT
"""

import os
import csv
import time
import argparse
import urllib.request
import urllib.parse
import urllib.error
import json

from .config import SYMBOLS, DATA_DIR

API = "https://community-api.coinmetrics.io/v4/timeseries/asset-metrics"

# Binance trading pair -> CoinMetrics asset code.
ASSET = {"BTCUSDT": "btc", "ETHUSDT": "eth", "XRPUSDT": "xrp"}

# Daily community-tier metrics that exist for all three assets. NVT is derived
# later as CapMrktCurUSD / TxTfrValAdjUSD (a classic on-chain valuation signal).
METRICS = ["AdrActCnt", "TxCnt", "TxTfrValAdjUSD", "CapMrktCurUSD"]

START = "2017-01-01"


def _get(url: str, retries: int = 5) -> dict:
    """GET with exponential backoff. The community tier rate-limits paginated
    pulls (HTTP 403/429), so transient blocks are retried rather than fatal."""
    req = urllib.request.Request(url, headers={"User-Agent": "crypto-project/1.0"})
    for attempt in range(retries):
        try:
            with urllib.request.urlopen(req, timeout=60) as r:
                return json.loads(r.read().decode())
        except urllib.error.HTTPError as e:
            if e.code in (403, 429) and attempt < retries - 1:
                wait = 2 ** attempt
                print(f"    rate-limited ({e.code}); retrying in {wait}s")
                time.sleep(wait)
                continue
            raise


def fetch_symbol(symbol: str) -> int:
    """Download the full daily on-chain history for one symbol; write CSV.
    Returns the number of rows written."""
    asset = ASSET.get(symbol)
    if asset is None:
        print(f"  {symbol}: no CoinMetrics asset mapping, skipping")
        return 0

    params = {
        "assets": asset,
        "metrics": ",".join(METRICS),
        "frequency": "1d",
        "start_time": START,
        "page_size": 10000,
    }
    url = API + "?" + urllib.parse.urlencode(params)

    rows, page = [], 0
    while url:
        data = _get(url)
        rows.extend(data.get("data", []))
        url = data.get("next_page_url")        # community API paginates
        page += 1
        print(f"  {symbol}: page {page}, {len(rows)} rows so far")
        if url:
            time.sleep(1.0)                    # throttle to respect rate limits

    if not rows:
        print(f"  {symbol}: no data returned")
        return 0

    os.makedirs(DATA_DIR, exist_ok=True)
    out = os.path.join(DATA_DIR, f"{symbol}_onchain.csv")
    cols = ["date"] + METRICS
    with open(out, "w", newline="") as f:
        w = csv.DictWriter(f, fieldnames=cols)
        w.writeheader()
        for r in rows:
            w.writerow({"date": r["time"][:10],
                        **{m: r.get(m, "") for m in METRICS}})
    print(f"  {symbol}: wrote {len(rows)} daily rows -> {out}")
    return len(rows)


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--symbol", default=None, help="one symbol (default: all)")
    args = ap.parse_args()
    syms = [args.symbol] if args.symbol else SYMBOLS
    for s in syms:
        fetch_symbol(s)


if __name__ == "__main__":
    main()
