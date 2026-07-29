// Deno tests for the simulation engine.  Run:  deno test supabase/functions/
import { assert, assertAlmostEquals, assertEquals } from "jsr:@std/assert@1";
import {
  buildLog,
  buyHold,
  type Candle,
  HORIZON_SEC,
  type PredEntry,
  rankByProfit,
  simulateModel,
  simulatePortfolio,
  type SimMetrics,
} from "./engine.ts";

// Build a 5-minute candle series from a list of closes starting at t0.
function candles(closes: number[], t0 = 1_000_000): Candle[] {
  return closes.map((c, i) => ({ time: t0 + i * HORIZON_SEC, c }));
}
// One prediction per candle for `model`.
function preds(model: string, vals: Array<number | null>, t0 = 1_000_000): PredEntry[] {
  return vals.map((v, i) => ({ time: t0 + i * HORIZON_SEC, [model]: v } as PredEntry));
}

/*
 * Candle `time` is the OPEN time, and a prediction is stamped with the OPEN time
 * of the candle it forecasts. So a prediction at T is baselined on the close at
 * T (the candle that just closed) and realised against the close at T+300. That
 * means the very first prediction has no preceding candle to baseline against
 * and is correctly unscoreable — the fixtures below account for that.
 */
Deno.test("buildLog matures one candle ahead and computes long/short return", () => {
  const h = candles([100, 110, 99, 105]); // opens t0 .. t0+900
  const t0 = 1_000_000;
  //  @t0      : no close at t0 to baseline against  -> skipped
  //  @t0+300  : baseline 100, actual 110, pred UP   -> correct, ret +0.10
  //  @t0+600  : baseline 110, actual  99, pred DOWN -> correct, ret +0.10
  //  @t0+900  : realised candle still in progress   -> not matured
  const p = preds("M", [105, 105, 100, 50]);
  const log = buildLog(p, h, "M");
  assertEquals(log.length, 2);
  assertEquals(log[0].time, t0 + HORIZON_SEC);
  assertAlmostEquals(log[0].ret, 0.10, 1e-9);
  assert(log[0].correct);
  assertAlmostEquals(log[1].ret, (-1 * (99 - 110)) / 110, 1e-9);
  assert(log[1].correct);
});

Deno.test("buildLog skips FLAT, non-finite and out-of-range predictions", () => {
  const h = candles([100, 110, 120, 130, 140]);
  //  @t0      : unscoreable (no baseline)
  //  @t0+300  : FLAT (pred == baseline 100)      -> dropped
  //  @t0+600  : null                             -> dropped
  //  @t0+900  : baseline 120, actual 130, UP     -> kept
  //  @t0+1200 : realised candle in progress      -> not matured
  const p = preds("M", [105, 100, null, 200, 50]);
  const log = buildLog(p, h, "M", -Infinity, Infinity);
  assertEquals(log.length, 1);
  assertAlmostEquals(log[0].ret, (130 - 120) / 120, 1e-9);
});

Deno.test("buildLog scores an hourly _v2 model against the close an hour earlier", () => {
  // 14 candles: opens t0 .. t0+3900, so closes land at t0+300 .. t0+4200. The
  // target below must not be the last (still in progress) candle, hence the 14th.
  const closes = [100, 101, 102, 103, 104, 105, 106, 107, 108, 109, 110, 111, 120, 121];
  const h = candles(closes);
  const t0 = 1_000_000;
  // An hourly entry is stamped at its TARGET: baseline = close at T-3600,
  // actual = close at T. T = t0+3900 -> baseline close@t0+300 = 100, actual = 120.
  const p: PredEntry[] = [{ time: t0 + 3900, "LSTM_v2": 115 } as PredEntry];
  const log = buildLog(p, h, "LSTM_v2");
  assertEquals(log.length, 1);
  assertEquals(log[0].baseline, 100);
  assertEquals(log[0].actual, 120);
  assertAlmostEquals(log[0].ret, (120 - 100) / 100, 1e-9); // predicted UP, went up
  assert(log[0].correct);
});

Deno.test("buildLog treats a _v2_5m model as 5-minute, not hourly", () => {
  // Same fixture as the 5-minute test: the 5-min v2 challengers share the legacy
  // convention, so the trailing-_v2 hourly rule must NOT catch LSTM_v2_5m.
  const h = candles([100, 110, 99, 105]);
  const p = preds("LSTM_v2_5m", [105, 105, 100, 50]);
  const log = buildLog(p, h, "LSTM_v2_5m");
  assertEquals(log.length, 2);
  assertAlmostEquals(log[0].ret, 0.10, 1e-9);
});

Deno.test("buildLog respects the date window", () => {
  const h = candles([100, 110, 120, 130, 140]);
  const p = preds("M", [105, 115, 125, 135, 145]);
  const t0 = 1_000_000;
  const log = buildLog(p, h, "M", t0 + HORIZON_SEC, t0 + 2 * HORIZON_SEC);
  assertEquals(log.length, 2); // only predictions at t0+300 and t0+600
});

Deno.test("simulateModel: all-winning long run compounds to expected value", () => {
  const h = candles([100, 110, 121, 133.1]); // +10% each step
  // First entry is unscoreable (no baseline); the next two mature as +10% each.
  const p = preds("M", [105, 105, 115, 125]);
  const log = buildLog(p, h, "M");
  const m = simulateModel("M", log, 1000, null);
  assertEquals(m.trades, 2);
  assertEquals(m.winningTrades, 2);
  assertEquals(m.losingTrades, 0);
  assertAlmostEquals(m.finalValue, 1000 * 1.1 * 1.1, 1e-6); // 1210
  assertAlmostEquals(m.profitPct, 21, 1e-6);
  assertEquals(m.maxDrawdown, 0);
  assertEquals(m.maxConsecutiveLosses, 0);
  assert(m.winRate === 100);
});

Deno.test("simulateModel: drawdown and consecutive losses tracked", () => {
  // returns: +0.1, -0.1, -0.1
  const m = simulateReturnsHelper([0.1, -0.1, -0.1], 1000);
  assertEquals(m.losingTrades, 2);
  assertEquals(m.maxConsecutiveLosses, 2);
  assert(m.maxDrawdown > 0);
  assert((m.valueAtRisk ?? 0) > 0);
});

// small helper to exercise simulateReturns through the public model path
function simulateReturnsHelper(rets: number[], amt: number): SimMetrics {
  const log = rets.map((r, i) => ({
    time: i,
    baseline: 100,
    actual: 100 * (1 + r),
    predicted: 100,
    ret: r,
    correct: r > 0,
  }));
  return simulateModel("H", log, amt, null);
}

Deno.test("buyHold computes passive return and drawdown", () => {
  const h = candles([100, 120, 90, 150]);
  const bh = buyHold(h, -Infinity, Infinity, 1000);
  assertAlmostEquals(bh.finalValue, 1500, 1e-6); // 100 -> 150
  assertAlmostEquals(bh.profitPct, 50, 1e-6);
  assertAlmostEquals(bh.maxDrawdown, 25, 1e-6); // 120 -> 90 = 25% drop
});

Deno.test("vsBuyHold is the spread in percentage points", () => {
  const h = candles([100, 110, 121]);
  const p = preds("M", [105, 115]);
  const log = buildLog(p, h, "M");
  const bh = buyHold(h, -Infinity, Infinity, 1000);
  const m = simulateModel("M", log, 1000, bh.profitPct);
  assertAlmostEquals(m.vsBuyHold!, m.profitPct - bh.profitPct, 1e-6);
});

Deno.test("rankByProfit orders highest profit first (and smallest loss first)", () => {
  const mk = (model: string, pct: number) => ({ model, profitPct: pct } as SimMetrics);
  const ranked = rankByProfit([mk("a", -5), mk("b", 10), mk("c", -1)]);
  assertEquals(ranked.map((r) => r.model), ["b", "c", "a"]);
});

Deno.test("simulatePortfolio blends sleeves by weight", () => {
  const h = candles([100, 110, 121]);
  const logA = buildLog(preds("A", [105, 115]), h, "A");
  const logB = buildLog(preds("B", [95, 105]), h, "B"); // predicts DOWN -> loses on up moves
  const port = simulatePortfolio(
    [{ model: "A", weight: 0.5 }, { model: "B", weight: 0.5 }],
    { A: logA, B: logB },
    1000,
    null,
  );
  // A sleeve ends at 1.21, B sleeve ends at ~0.81 -> blended between the two
  assert(port.finalValue < 1000 * 1.21 && port.finalValue > 1000 * 0.81);
  assert(port.model.includes("% A") && port.model.includes("% B"));
});
