/*
 * Investment-simulation engine (canonical, backend source of truth).
 *
 * The frontend NEVER recomputes these numbers — it only renders what this
 * module returns (Task 6 requirement: all calculation on the backend).
 *
 * Strategy modelled: long/short. At each *matured* prediction the strategy
 * takes a +1 (long) position when the model predicts the next close UP and a
 * -1 (short) position when it predicts DOWN. The trade return is
 *     pos * (actual - baseline) / baseline
 * and equity compounds across trades. Portfolio value = initialAmount * equity.
 *
 * ACADEMIC NOTE: no transaction fees, slippage or financing costs are applied.
 * The `fee` knob is kept for extensibility but defaults to 0 and the API never
 * sets it — current numbers are raw gross performance, as required.
 *
 * Maturation mirrors the dashboard's chart-utils.buildPredictionLog so the
 * Investment page is consistent with the Analytics page — including the candle
 * key convention (close time, not open time) and the per-model horizon: see
 * horizonOf below. Getting either wrong scores the model against the wrong
 * candle, which is silent and looks plausible.
 */

export const HORIZON_SEC = 300; // one 5-minute candle ahead (matches the dashboard)
export const HOURLY_HORIZON_SEC = 3600;

/**
 * Where a model's baseline and realised close sit relative to its journal
 * timestamp — the Deno mirror of chart-utils.horizonOffsets, and it must stay in
 * step with it or the Investment page and the Analytics page will report
 * different numbers for the same model.
 *
 *   5-minute models (legacy AND the v2 5-min challengers)
 *     entry.time is when the forecast was made; the target is the next candle.
 *       baseline = closeAt[t]           actual = closeAt[t + 300]
 *
 *   hourly models (trailing `_v2`)
 *     entry.time is the TARGET itself (the engine writes hour_key + 3600).
 *       baseline = closeAt[t - 3600]    actual = closeAt[t]
 *
 * Named for the horizon, not the generation: LSTM_v2_5m is a v2 model that is
 * NOT hourly, so the trailing-`_v2` test is what separates the two conventions.
 */
export function horizonOf(model: string): {
  base: number;
  actual: number;
  horizonSec: number;
} {
  return /_v2$/.test(model)
    ? { base: -HOURLY_HORIZON_SEC, actual: 0, horizonSec: HOURLY_HORIZON_SEC }
    : { base: 0, actual: HORIZON_SEC, horizonSec: HORIZON_SEC };
}

export interface Candle {
  time: number; // unix seconds
  o?: number;
  h?: number;
  l?: number;
  c: number; // close
}

export interface PredEntry {
  time: number;
  [model: string]: number | null;
}

export interface LogRow {
  time: number;
  baseline: number;
  actual: number;
  predicted: number;
  ret: number; // realised long/short return for this trade (fraction)
  correct: boolean; // directional call was right
}

export interface SimMetrics {
  model: string;
  trades: number;
  winningTrades: number;
  losingTrades: number;
  winRate: number | null; // %
  initialAmount: number;
  finalValue: number;
  profit: number; // $
  profitPct: number; // %  (== totalReturn)
  totalReturn: number; // % (alias, kept explicit for the UI)
  maxDrawdown: number; // % (0..100, positive number)
  sharpe: number | null; // annualised
  sortino: number | null; // annualised
  calmar: number | null; // annualised return / maxDrawdown
  volatility: number | null; // annualised %, std of trade returns
  valueAtRisk: number | null; // historical 95% VaR, % loss (positive number)
  maxConsecutiveLosses: number;
  profitFactor: number | null;
  // vs Buy & Hold
  vsBuyHold: number | null; // profitPct - buyHold.profitPct  (percentage points)
  // curves (downsampled by the router before returning to the client)
  equityCurve: Array<{ time: number; value: number }>;
  drawdownCurve: Array<{ time: number; dd: number }>;
}

export interface BuyHoldMetrics {
  initialAmount: number;
  finalValue: number;
  profit: number;
  profitPct: number;
  maxDrawdown: number;
  startPrice: number | null;
  endPrice: number | null;
  equityCurve: Array<{ time: number; value: number }>;
}

// Annualisation factor depends on how often the model actually trades: an hourly
// model takes 12x fewer positions than a 5-minute one, so scaling both by the
// 5-minute period count would inflate the hourly Sharpe/volatility by sqrt(12).
const periodsPerYear = (horizonSec: number) => (365 * 24 * 3600) / horizonSec;

/* ---------------------------------------------------------------- helpers */

function mean(a: number[]): number {
  return a.length ? a.reduce((s, v) => s + v, 0) / a.length : 0;
}

function stddev(a: number[]): number {
  if (a.length < 2) return 0;
  const m = mean(a);
  return Math.sqrt(a.reduce((s, v) => s + (v - m) * (v - m), 0) / a.length);
}

/** Historical Value-at-Risk: the loss at the (1-conf) quantile of returns. */
function historicalVaR(rets: number[], conf = 0.95): number | null {
  if (!rets.length) return null;
  const sorted = rets.slice().sort((x, y) => x - y);
  const idx = Math.max(0, Math.min(sorted.length - 1, Math.floor((1 - conf) * sorted.length)));
  const q = sorted[idx];
  return q < 0 ? -q * 100 : 0; // express as a positive % loss
}

/* ----------------------------------------------------- prediction log */

/**
 * Build the matured trade log for one model, restricted to [fromSec, toSec].
 * Mirrors chart-utils.buildPredictionLog maturation, but also records the
 * realised long/short return so the simulator stays free of price lookups.
 */
export function buildLog(
  predHist: PredEntry[],
  hist5m: Candle[],
  model: string,
  fromSec = -Infinity,
  toSec = Infinity,
): LogRow[] {
  if (!Array.isArray(predHist) || !Array.isArray(hist5m) || hist5m.length === 0) return [];
  // Keyed by the candle's CLOSE time (payload candles carry their OPEN time), so
  // closeAt.get(x) is "the price at x". chart-utils.js keys it the same way, and
  // the two must match or the Investment page and the Analytics page disagree.
  const closeAt = new Map<number, number>();
  for (const c of hist5m) closeAt.set(c.time + HORIZON_SEC, c.c);
  const lastCandleTime = hist5m[hist5m.length - 1].time;

  const off = horizonOf(model);
  const out: LogRow[] = [];
  for (const entry of predHist) {
    const raw = entry[model];
    const pred = Number(raw);
    if (raw === null || raw === undefined || !Number.isFinite(pred)) continue;
    const t = Number(entry.time);
    if (!Number.isFinite(t) || t < fromSec || t > toSec) continue;
    // Matured only when the realised candle has FULLY CLOSED, i.e. its open time
    // is strictly before the last, in-progress candle. Same guard as
    // chart-utils.buildPredictionLog.
    if (t + off.actual - HORIZON_SEC >= lastCandleTime) continue;

    const baseline = closeAt.get(t + off.base);
    const actual = closeAt.get(t + off.actual);
    if (baseline === undefined || baseline <= 0 || actual === undefined || actual <= 0) continue;

    const predDir = pred - baseline;
    const actMove = actual - baseline;
    if (predDir === 0) continue; // FLAT prediction => no position taken

    const pos = predDir > 0 ? 1 : -1;
    const ret = (pos * actMove) / baseline;
    out.push({
      time: t,
      baseline,
      actual,
      predicted: pred,
      ret,
      correct: actMove !== 0 ? pos * actMove > 0 : false,
    });
  }
  out.sort((a, b) => a.time - b.time); // chronological for compounding
  return out;
}

/* --------------------------------------------------------- core simulate */

/**
 * Compound a sequence of per-trade returns into portfolio metrics.
 * `times` aligns 1:1 with `rets` and seeds the equity/drawdown curve x-axis.
 */
export function simulateReturns(
  model: string,
  rets: number[],
  times: number[],
  initialAmount: number,
  buyHoldPct: number | null,
  fee = 0,
): SimMetrics {
  const n = rets.length;
  const netRets = fee ? rets.map((r) => r - fee) : rets;
  const PERIODS_PER_YEAR = periodsPerYear(horizonOf(model).horizonSec);

  let equity = 1, peak = 1, maxDd = 0;
  let wins = 0, losses = 0, gains = 0, lossSum = 0;
  let consec = 0, maxConsec = 0;
  const equityCurve: Array<{ time: number; value: number }> = [];
  const drawdownCurve: Array<{ time: number; dd: number }> = [];

  for (let i = 0; i < n; i++) {
    const r = netRets[i];
    equity *= 1 + r;
    if (equity > peak) peak = equity;
    const dd = peak > 0 ? (peak - equity) / peak : 0;
    if (dd > maxDd) maxDd = dd;
    if (r > 0) {
      wins++; gains += r; consec = 0;
    } else {
      losses++; lossSum += -r; consec++;
      if (consec > maxConsec) maxConsec = consec;
    }
    equityCurve.push({ time: times[i], value: initialAmount * equity });
    drawdownCurve.push({ time: times[i], dd: dd * 100 });
  }

  const m = mean(netRets);
  const sd = stddev(netRets);
  const downside = netRets.filter((r) => r < 0);
  const downsideDev = Math.sqrt(
    downside.reduce((s, r) => s + r * r, 0) / (netRets.length || 1),
  );
  const finalValue = initialAmount * equity;
  const profitPct = (equity - 1) * 100;
  // Geometric annualised return, from the realised compounded equity.
  const annReturn = n > 0 ? (Math.pow(equity, PERIODS_PER_YEAR / n) - 1) * 100 : 0;

  return {
    model,
    trades: n,
    winningTrades: wins,
    losingTrades: losses,
    winRate: n ? (wins / n) * 100 : null,
    initialAmount,
    finalValue,
    profit: finalValue - initialAmount,
    profitPct,
    totalReturn: profitPct,
    maxDrawdown: maxDd * 100,
    sharpe: sd > 0 ? (m / sd) * Math.sqrt(PERIODS_PER_YEAR) : null,
    sortino: downsideDev > 0 ? (m / downsideDev) * Math.sqrt(PERIODS_PER_YEAR) : null,
    calmar: maxDd > 0 ? annReturn / (maxDd * 100) : null,
    volatility: sd > 0 ? sd * Math.sqrt(PERIODS_PER_YEAR) * 100 : null,
    valueAtRisk: historicalVaR(netRets, 0.95),
    maxConsecutiveLosses: maxConsec,
    profitFactor: lossSum > 0 ? gains / lossSum : gains > 0 ? Infinity : null,
    vsBuyHold: buyHoldPct === null ? null : profitPct - buyHoldPct,
    equityCurve,
    drawdownCurve,
  };
}

/** Convenience: simulate one model directly from its trade log. */
export function simulateModel(
  model: string,
  log: LogRow[],
  initialAmount: number,
  buyHoldPct: number | null,
  fee = 0,
): SimMetrics {
  return simulateReturns(
    model,
    log.map((r) => r.ret),
    log.map((r) => r.time),
    initialAmount,
    buyHoldPct,
    fee,
  );
}

/* ----------------------------------------------------------- Buy & Hold */

/** Passive benchmark: buy the asset at the first close in range, hold to last. */
export function buyHold(
  hist5m: Candle[],
  fromSec: number,
  toSec: number,
  initialAmount: number,
): BuyHoldMetrics {
  const inRange = hist5m
    .filter((c) => c.time >= fromSec && c.time <= toSec && c.c > 0)
    .sort((a, b) => a.time - b.time);
  if (inRange.length < 2) {
    return {
      initialAmount,
      finalValue: initialAmount,
      profit: 0,
      profitPct: 0,
      maxDrawdown: 0,
      startPrice: inRange[0]?.c ?? null,
      endPrice: inRange[inRange.length - 1]?.c ?? null,
      equityCurve: [],
    };
  }
  const start = inRange[0].c;
  let peak = start, maxDd = 0;
  // Cap the curve length so the payload stays small on long ranges.
  const step = Math.max(1, Math.floor(inRange.length / 400));
  const curve: Array<{ time: number; value: number }> = [];
  for (let i = 0; i < inRange.length; i++) {
    const px = inRange[i].c;
    if (px > peak) peak = px;
    const dd = (peak - px) / peak;
    if (dd > maxDd) maxDd = dd;
    if (i % step === 0 || i === inRange.length - 1) {
      curve.push({ time: inRange[i].time, value: initialAmount * (px / start) });
    }
  }
  const end = inRange[inRange.length - 1].c;
  const finalValue = initialAmount * (end / start);
  return {
    initialAmount,
    finalValue,
    profit: finalValue - initialAmount,
    profitPct: (end / start - 1) * 100,
    maxDrawdown: maxDd * 100,
    startPrice: start,
    endPrice: end,
    equityCurve: curve,
  };
}

/* --------------------------------------------- portfolio allocation blend */

export interface Allocation {
  model: string;
  weight: number; // 0..1, weights across the basket should sum to 1
}

/**
 * Blend several models into one portfolio. Capital is split by weight and each
 * sleeve compounds independently on its own model's trades; the portfolio value
 * at any time is the sum of sleeves. We rebuild a combined return series on the
 * union of trade timestamps so the standard metrics apply to the basket too.
 */
export function simulatePortfolio(
  alloc: Allocation[],
  logs: Record<string, LogRow[]>,
  initialAmount: number,
  buyHoldPct: number | null,
  fee = 0,
): SimMetrics {
  // Per-sleeve running equity, advanced in timestamp order across all sleeves.
  const events: Array<{ time: number; model: string; ret: number }> = [];
  for (const a of alloc) {
    if (a.weight <= 0) continue;
    for (const row of logs[a.model] || []) {
      events.push({ time: row.time, model: a.model, ret: row.ret - fee });
    }
  }
  events.sort((x, y) => x.time - y.time);

  const sleeveEquity: Record<string, number> = {};
  for (const a of alloc) sleeveEquity[a.model] = 1;
  const weightOf: Record<string, number> = {};
  for (const a of alloc) weightOf[a.model] = a.weight;

  let prevValue = initialAmount;
  const rets: number[] = [];
  const times: number[] = [];
  for (const ev of events) {
    sleeveEquity[ev.model] *= 1 + ev.ret;
    // Total portfolio value = sum over sleeves of weight*initial*sleeveEquity.
    let value = 0;
    for (const a of alloc) value += a.weight * initialAmount * sleeveEquity[a.model];
    rets.push(prevValue > 0 ? value / prevValue - 1 : 0);
    times.push(ev.time);
    prevValue = value;
  }

  const label = alloc
    .filter((a) => a.weight > 0)
    .map((a) => `${Math.round(a.weight * 100)}% ${a.model}`)
    .join(" + ");
  return simulateReturns(label || "Portfolio", rets, times, initialAmount, buyHoldPct, 0);
}

/* ------------------------------------------------------------- ranking */

/**
 * Rank models highest-profit-first. If everyone lost money the natural sort
 * already puts the smallest loss first, satisfying 6.3 without special-casing.
 */
export function rankByProfit(results: SimMetrics[]): SimMetrics[] {
  return results.slice().sort((a, b) => b.profitPct - a.profitPct);
}

/** Drop curves to keep saved/leaderboard payloads small. */
export function stripCurves(m: SimMetrics): Omit<SimMetrics, "equityCurve" | "drawdownCurve"> {
  const { equityCurve: _e, drawdownCurve: _d, ...rest } = m;
  return rest;
}
