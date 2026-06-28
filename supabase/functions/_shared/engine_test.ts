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

Deno.test("buildLog matures one candle ahead and computes long/short return", () => {
  const h = candles([100, 110, 99]); // closes at t0, t0+300, t0+600
  // Predict UP at t0 (pred>100): actual 110 -> correct, ret +0.10
  // Predict DOWN at t0+300 (pred<110): actual 99 -> correct, ret +(99-110)/110*-1
  const p = preds("M", [105, 100, 50]);
  const log = buildLog(p, h, "M");
  // last candle (t0+600) cannot mature -> only 2 rows
  assertEquals(log.length, 2);
  assertAlmostEquals(log[0].ret, 0.10, 1e-9);
  assert(log[0].correct);
  assertAlmostEquals(log[1].ret, (-1 * (99 - 110)) / 110, 1e-9);
  assert(log[1].correct);
});

Deno.test("buildLog skips FLAT, non-finite and out-of-range predictions", () => {
  const h = candles([100, 110, 120, 130]);
  const p = preds("M", [100, null, 200, 50]); // first is FLAT (==baseline)
  const log = buildLog(p, h, "M", -Infinity, Infinity);
  // FLAT dropped, null dropped, last cannot mature -> 1 row (the pred=200@t0+600)
  assertEquals(log.length, 1);
  assertAlmostEquals(log[0].ret, (120 - 130) > 0 ? 0 : (130 - 120) / 120, 1e-9);
});

Deno.test("buildLog respects the date window", () => {
  const h = candles([100, 110, 120, 130, 140]);
  const p = preds("M", [105, 115, 125, 135, 145]);
  const t0 = 1_000_000;
  const log = buildLog(p, h, "M", t0 + HORIZON_SEC, t0 + 2 * HORIZON_SEC);
  assertEquals(log.length, 2); // only predictions at t0+300 and t0+600
});

Deno.test("simulateModel: all-winning long run compounds to expected value", () => {
  const h = candles([100, 110, 121]); // +10% each step
  const p = preds("M", [105, 115]); // predict UP twice
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
