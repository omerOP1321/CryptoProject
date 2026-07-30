/*
 * Unit tests for website/chart-utils.js
 * Run with:  node --test website/tests/
 */
const { test } = require('node:test');
const assert = require('node:assert');
const ChartUtils = require('../chart-utils.js');

const { toMs, filterSanePoints, insertGapBreaks, computeModelErrors, computeModelStats, splitAtGaps, recentFocusRange } = ChartUtils;
const { horizonOffsets } = ChartUtils;
const { findOutages, formatOutage } = ChartUtils;
const { buildPredictionLog, regressionMetrics, classificationMetrics, pesaranTimmermann, rollingMetrics, regimeBreakdown, tradingSim } = ChartUtils;

// The zero-sample shape of computeModelStats. Kept in one place: it grew a dirHits
// count and a dirCI interval when the confidence display was added, and three separate
// literals would drift apart the next time it changes.
const EMPTY_STATS = {
    avgError: null, errorCount: 0, dirAccuracy: null, dirCount: 0,
    dirHits: 0,
    dirCI: { low: null, high: null, point: null, n: 0, z: 1.96,
             straddlesChance: true, beatsChance: false, belowChance: false }
};

// ----------------------------------------------------- recentFocusRange

test('recentFocusRange shows the last focusBars + rightOffset for a long series', () => {
    // 288 candles (24h of 5m), focus 48 (4h), 5 bars of right padding
    assert.deepStrictEqual(recentFocusRange(288, 48, 5), { from: 240, to: 292 });
});

test('recentFocusRange clamps "from" to 0 when fewer candles than focusBars', () => {
    // 12 candles (1H), focus window 48 -> show all from 0
    assert.deepStrictEqual(recentFocusRange(12, 48, 5), { from: 0, to: 16 });
});

test('recentFocusRange returns null for empty data', () => {
    assert.strictEqual(recentFocusRange(0, 48, 5), null);
    assert.strictEqual(recentFocusRange(undefined, 48, 5), null);
});

test('recentFocusRange applies defaults for focusBars and rightOffset', () => {
    // default focusBars 48, rightOffset 0
    assert.deepStrictEqual(recentFocusRange(100), { from: 52, to: 99 });
});

// -------------------------------------------------------- splitAtGaps

// ----------------------------------------------------- findOutages

test('findOutages returns nothing for an unbroken 5-min series', () => {
    const h = [];
    for (let i = 0; i < 50; i++) h.push({ time: 1784000000 + i * 300 });
    assert.deepStrictEqual(findOutages(h, 3600), []);
});

test('findOutages ignores a hiccup shorter than the threshold', () => {
    // 15-minute break: real, but not worth labelling as an outage.
    const h = [{ time: 1784000000 }, { time: 1784000300 }, { time: 1784001200 }];
    assert.deepStrictEqual(findOutages(h, 3600), []);
});

test('findOutages reports the real 2026-07-12..15 egress outage', () => {
    // Last point before the restriction and first one after it.
    const h = [{ time: 1784162400 }, { time: 1784451300 }];
    assert.deepStrictEqual(findOutages(h, 3600), [
        { fromSec: 1784162400, toSec: 1784451300, durationSec: 288900 }
    ]);
});

test('findOutages finds every gap and tolerates unsorted input', () => {
    const h = [{ time: 1784010000 }, { time: 1784000000 }, { time: 1784003600 }];
    const out = findOutages(h, 3600);
    assert.strictEqual(out.length, 2);
    assert.deepStrictEqual(out.map(o => o.fromSec), [1784000000, 1784003600]);
});

test('findOutages survives junk input', () => {
    assert.deepStrictEqual(findOutages(null, 3600), []);
    assert.deepStrictEqual(findOutages([], 3600), []);
    assert.deepStrictEqual(findOutages([{ time: 'x' }, { time: 1784000000 }], 3600), []);
});

test('formatOutage renders the units a reader expects', () => {
    assert.strictEqual(formatOutage(288900), '3.3 days');   // the real outage
    assert.strictEqual(formatOutage(7200), '2h');
    assert.strictEqual(formatOutage(900), '15min');
});

// ----------------------------------------------------- splitAtGaps

test('splitAtGaps keeps contiguous data as one segment', () => {
    const pts = [{ time: 0, value: 1 }, { time: 300, value: 2 }, { time: 600, value: 3 }];
    assert.deepStrictEqual(splitAtGaps(pts, 900 * 1000), [pts]);
});

test('splitAtGaps splits at every gap', () => {
    const pts = [
        { time: 0, value: 1 }, { time: 300, value: 2 },
        { time: 50000, value: 3 },
        { time: 100000, value: 4 }, { time: 100300, value: 5 },
    ];
    const segs = splitAtGaps(pts, 900 * 1000);
    assert.strictEqual(segs.length, 3);
    assert.deepStrictEqual(segs[0].map(p => p.time), [0, 300]);
    assert.deepStrictEqual(segs[1].map(p => p.time), [50000]);
    assert.deepStrictEqual(segs[2].map(p => p.time), [100000, 100300]);
});

test('splitAtGaps handles empty and single-point inputs', () => {
    assert.deepStrictEqual(splitAtGaps([], 1000), []);
    assert.deepStrictEqual(splitAtGaps([{ time: 5, value: 1 }], 1000), [[{ time: 5, value: 1 }]]);
});

test('splitAtGaps works with daily date-string times', () => {
    const pts = [{ time: '2026-06-01', value: 1 }, { time: '2026-06-20', value: 2 }];
    const segs = splitAtGaps(pts, 3 * 86400 * 1000);
    assert.strictEqual(segs.length, 2);
});

// ---------------------------------------------------------------- toMs

test('toMs converts unix seconds to ms', () => {
    assert.strictEqual(toMs(1000), 1000000);
});

test('toMs parses YYYY-MM-DD date strings', () => {
    assert.strictEqual(toMs('2026-06-11'), Date.parse('2026-06-11'));
});

// ---------------------------------------------------- filterSanePoints

test('filterSanePoints keeps points near the market price', () => {
    const nearestClose = () => 100;
    const pts = [{ time: 1, value: 101 }, { time: 2, value: 99 }];
    assert.deepStrictEqual(filterSanePoints(pts, nearestClose, 100), pts);
});

test('filterSanePoints drops outliers beyond tolerance', () => {
    const nearestClose = () => 100;
    const pts = [
        { time: 1, value: 100.5 },  // 0.5% off - keep
        { time: 2, value: 120 },    // 20% off - drop (legacy garbage)
        { time: 3, value: 200 },    // 100% off - drop
    ];
    const out = filterSanePoints(pts, nearestClose, 100);
    assert.deepStrictEqual(out.map(p => p.time), [1]);
});

test('filterSanePoints falls back to fallbackPrice when no candle matches', () => {
    const nearestClose = () => undefined;
    const pts = [{ time: 1, value: 102 }, { time: 2, value: 150 }];
    const out = filterSanePoints(pts, nearestClose, 100);
    assert.deepStrictEqual(out.map(p => p.time), [1]);
});

test('filterSanePoints drops NaN/invalid values and handles empty input', () => {
    const nearestClose = () => 100;
    assert.deepStrictEqual(filterSanePoints([], nearestClose, 100), []);
    const pts = [{ time: 1, value: NaN }, { time: 2, value: null }, { time: 3, value: 100 }];
    assert.deepStrictEqual(filterSanePoints(pts, nearestClose, 100).map(p => p.time), [3]);
});

test('filterSanePoints rejects everything when reference price is invalid', () => {
    const nearestClose = () => undefined;
    const pts = [{ time: 1, value: 100 }];
    assert.deepStrictEqual(filterSanePoints(pts, nearestClose, 0), []);
    assert.deepStrictEqual(filterSanePoints(pts, nearestClose, NaN), []);
});

test('filterSanePoints honors a custom tolerance', () => {
    const nearestClose = () => 100;
    const pts = [{ time: 1, value: 108 }];
    assert.strictEqual(filterSanePoints(pts, nearestClose, 100, 0.05).length, 0);
    assert.strictEqual(filterSanePoints(pts, nearestClose, 100, 0.10).length, 1);
});

// ----------------------------------------------------- insertGapBreaks

test('insertGapBreaks leaves contiguous data untouched', () => {
    const pts = [{ time: 0, value: 1 }, { time: 300, value: 2 }, { time: 600, value: 3 }];
    assert.deepStrictEqual(insertGapBreaks(pts, 900 * 1000, false), pts);
});

test('insertGapBreaks inserts a whitespace item across a gap', () => {
    const pts = [{ time: 0, value: 1 }, { time: 5000, value: 2 }];
    const out = insertGapBreaks(pts, 900 * 1000, false);
    assert.strictEqual(out.length, 3);
    // whitespace item: has a time, no value -> chart renders a break
    assert.strictEqual(out[1].time, 1);
    assert.strictEqual('value' in out[1], false);
    assert.deepStrictEqual(out[2], pts[1]);
});

test('insertGapBreaks handles multiple gaps', () => {
    const pts = [
        { time: 0, value: 1 }, { time: 300, value: 2 },     // contiguous
        { time: 50000, value: 3 },                           // gap 1
        { time: 100000, value: 4 },                          // gap 2
    ];
    const out = insertGapBreaks(pts, 900 * 1000, false);
    assert.strictEqual(out.length, 6);
    assert.strictEqual(out.filter(p => !('value' in p)).length, 2);
});

test('insertGapBreaks handles empty and single-point datasets', () => {
    assert.deepStrictEqual(insertGapBreaks([], 1000, false), []);
    const single = [{ time: 5, value: 1 }];
    assert.deepStrictEqual(insertGapBreaks(single, 1000, false), single);
});

test('insertGapBreaks uses date-string whitespace for daily resolution', () => {
    const pts = [{ time: '2026-06-01', value: 1 }, { time: '2026-06-20', value: 2 }];
    const out = insertGapBreaks(pts, 3 * 86400 * 1000, true);
    assert.strictEqual(out.length, 3);
    assert.strictEqual(out[1].time, '2026-06-02'); // day after previous point
    assert.strictEqual('value' in out[1], false);
});

// -------------------------------------------------- computeModelErrors

// Candles opening at t close at t+300 with close = c
const candles = [
    { time: 0,    c: 100 },
    { time: 300,  c: 102 },
    { time: 600,  c: 104 },
    { time: 900,  c: 106 },
];

test('computeModelErrors averages relative error of matured predictions', () => {
    const predHist = [
        { time: 300, LSTM: 101 },   // actual 100 -> 1% error
        { time: 600, LSTM: 104.04 }, // actual 102 -> 2% error
    ];
    const { avg, count } = computeModelErrors(predHist, candles, 'LSTM');
    assert.strictEqual(count, 2);
    assert.ok(Math.abs(avg - 1.5) < 1e-9);
});

test('computeModelErrors skips unmatured and null predictions', () => {
    const predHist = [
        { time: 300, LSTM: 101 },        // matured
        { time: 99999, LSTM: 500 },      // target in the future -> skip
        { time: 600, LSTM: null },       // null -> skip
    ];
    const { avg, count } = computeModelErrors(predHist, candles, 'LSTM');
    assert.strictEqual(count, 1);
    assert.ok(Math.abs(avg - 1.0) < 1e-9);
});

test('computeModelErrors returns null avg for empty/missing data', () => {
    assert.deepStrictEqual(computeModelErrors([], candles, 'LSTM'), { avg: null, count: 0 });
    assert.deepStrictEqual(computeModelErrors([{ time: 300, LSTM: 101 }], [], 'LSTM'), { avg: null, count: 0 });
    assert.deepStrictEqual(computeModelErrors([{ time: 300, TFT: 101 }], candles, 'LSTM'), { avg: null, count: 0 });
});

test('computeModelErrors keeps only the last N matured predictions', () => {
    // 30 candles, 30 matured predictions each with 1% error
    const manyCandles = Array.from({ length: 31 }, (_, i) => ({ time: i * 300, c: 100 }));
    const manyPreds = Array.from({ length: 30 }, (_, i) => ({ time: (i + 1) * 300, LSTM: 101 }));
    const { count } = computeModelErrors(manyPreds, manyCandles, 'LSTM', 20);
    assert.strictEqual(count, 20);
});

test('computeModelErrors tolerates +/- one candle offset in timestamps', () => {
    const predHist = [{ time: 450, LSTM: 101 }]; // no exact close at 450
    const offsetCandles = [{ time: 150, c: 100 }, { time: 450, c: 100 }];
    // closeAt has keys 450 and 750; t=450 matches exactly via key 450
    const { count } = computeModelErrors(predHist, offsetCandles, 'LSTM');
    assert.strictEqual(count, 1);
});

// --------------------------------------------------- computeModelStats

// Candles: opens 0..1200, each closes 300s later. The last (open 1200) is the
// in-progress candle, so predictions at t=900 are matured (1200 exists after them).
// closeAt keys: 300->100, 600->102, 900->104, 1200->106, 1500->108
const statCandles = [
    { time: 0,    c: 100 },
    { time: 300,  c: 102 },
    { time: 600,  c: 104 },
    { time: 900,  c: 106 },
    { time: 1200, c: 108 },
];

test('computeModelStats: directional accuracy counts correct calls', () => {
    // Target t=900: actual = closeAt(1200) = 106, baseline = closeAt(900) = 104
    // -> actual move is UP. pred 105 says UP (hit), pred 99 says DOWN (miss).
    const predHist = [
        { time: 900, LSTM: 105 },
        { time: 900, LSTM: 99 },
    ];
    const stats = computeModelStats(predHist, statCandles, 'LSTM');
    assert.strictEqual(stats.dirCount, 2);
    assert.ok(Math.abs(stats.dirAccuracy - 50) < 1e-9);
    assert.strictEqual(stats.errorCount, 2);
});

test('computeModelStats: in-progress target candle is NOT matured', () => {
    // t=1200 == last candle open (in-progress) -> excluded (close not final yet)
    const stats = computeModelStats([{ time: 1200, LSTM: 109 }], statCandles, 'LSTM');
    assert.deepStrictEqual(stats, EMPTY_STATS);
});

test('computeModelStats: error uses the next candle close (t+300) as actual', () => {
    // Prediction at t=600 -> realized = closeAt[900] = 104; 105.04 -> 1% error
    const predHist = [{ time: 600, LSTM: 105.04 }];
    const stats = computeModelStats(predHist, statCandles, 'LSTM');
    assert.ok(Math.abs(stats.avgError - 1.0) < 1e-9);
    assert.strictEqual(stats.errorCount, 1);
});

test('computeModelStats: window filtering excludes out-of-range predictions', () => {
    const predHist = [
        { time: 600, LSTM: 103 },  // inside window
        { time: 900, LSTM: 105 },  // outside (after toSec)
    ];
    const stats = computeModelStats(predHist, statCandles, 'LSTM', { fromSec: 0, toSec: 700 });
    assert.strictEqual(stats.errorCount, 1);
});

test('computeModelStats: zero actual move carries no direction', () => {
    // For t=900: baseline closeAt(900)=100 and actual closeAt(1200)=100 -> flat move.
    // (open 1200 is the in-progress candle, making t=900 matured.)
    const flatCandles = [
        { time: 0,    c: 100 },
        { time: 300,  c: 101 },
        { time: 600,  c: 100 },
        { time: 900,  c: 100 },
        { time: 1200, c: 100 },
    ];
    const predHist = [{ time: 900, LSTM: 105 }];
    const stats = computeModelStats(predHist, flatCandles, 'LSTM');
    assert.strictEqual(stats.errorCount, 1);     // error still measured
    assert.strictEqual(stats.dirCount, 0);       // direction not scored
    assert.strictEqual(stats.dirAccuracy, null);
});

test('computeModelStats: missing baseline candle skips direction, keeps error', () => {
    // Realized (t+300) exists but the baseline close at t is absent.
    // candles -> closeAt keys {900:104, 1200:105}; for t=600, closeAt[900] is the
    // realized actual, but closeAt[600] (baseline) and closeAt[300] are missing.
    const sparse2 = [{ time: 600, c: 104 }, { time: 900, c: 105 }];
    const predHist = [{ time: 600, LSTM: 103 }];
    const stats = computeModelStats(predHist, sparse2, 'LSTM');
    assert.strictEqual(stats.errorCount, 1);     // error vs realized closeAt[900]=104
    assert.strictEqual(stats.dirCount, 0);       // no baseline -> direction not scored
});

test('computeModelStats: lastN caps the evaluated predictions', () => {
    const manyCandles = Array.from({ length: 40 }, (_, i) => ({ time: i * 300, c: 100 }));
    const manyPreds = Array.from({ length: 30 }, (_, i) => ({ time: (i + 3) * 300, LSTM: 101 }));
    const stats = computeModelStats(manyPreds, manyCandles, 'LSTM', { lastN: 10 });
    assert.strictEqual(stats.errorCount, 10);
});

test('computeModelStats: empty inputs return null metrics', () => {
    assert.deepStrictEqual(
        computeModelStats([], statCandles, 'LSTM'),
        EMPTY_STATS);
    assert.deepStrictEqual(
        computeModelStats([{ time: 900, LSTM: 105 }], [], 'LSTM'),
        EMPTY_STATS);
});

// =================================================== EVALUATION METRICS

// closeAt keys: 300->100, 600->102, 900->104, 1200->106, 1500->108
// lastCandleTime = 1200, so predictions at t < 1200 are matured.
const evalCandles = [
    { time: 0,    c: 100 },
    { time: 300,  c: 102 },
    { time: 600,  c: 104 },
    { time: 900,  c: 106 },
    { time: 1200, c: 108 },
];

// -------------------------------------------------- buildPredictionLog

test('buildPredictionLog returns matured records newest-first with directions', () => {
    // t=300: actual closeAt[600]=102, baseline closeAt[300]=100, pred 103 -> UP/UP hit
    // t=600: actual closeAt[900]=104, baseline closeAt[600]=102, pred 101 -> DOWN/UP miss
    const log = buildPredictionLog([
        { time: 300, M: 103 },
        { time: 600, M: 101 },
    ], evalCandles, 'M');
    assert.strictEqual(log.length, 2);
    assert.strictEqual(log[0].time, 600);              // newest first
    assert.strictEqual(log[0].actual, 104);
    assert.strictEqual(log[0].baseline, 102);
    assert.strictEqual(log[0].predDir, 'DOWN');
    assert.strictEqual(log[0].actDir, 'UP');
    assert.strictEqual(log[0].correct, false);
    assert.ok(Math.abs(log[0].errAbs - 3) < 1e-9);     // |101-104|
    assert.strictEqual(log[1].time, 300);
    assert.strictEqual(log[1].correct, true);
    assert.ok(Math.abs(log[1].errAbs - 1) < 1e-9);     // |103-102|
});

test('buildPredictionLog excludes the in-progress and future targets', () => {
    const log = buildPredictionLog([
        { time: 1200, M: 109 },   // == lastCandleTime -> in progress
        { time: 99999, M: 500 },  // future
        { time: 600, M: 105 },    // matured
    ], evalCandles, 'M');
    assert.strictEqual(log.length, 1);
    assert.strictEqual(log[0].time, 600);
});

test('buildPredictionLog FLAT move leaves correct null', () => {
    // need a candle at t-300 so baseline closeAt[600] exists; all closes equal -> flat move
    const flat = [{ time: 300, c: 100 }, { time: 600, c: 100 }, { time: 900, c: 100 }, { time: 1200, c: 100 }];
    // t=600: actual closeAt[900]=100, baseline closeAt[600]=100 -> actDir FLAT
    const log = buildPredictionLog([{ time: 600, M: 101 }], flat, 'M');
    assert.strictEqual(log.length, 1);
    assert.strictEqual(log[0].actDir, 'FLAT');
    assert.strictEqual(log[0].correct, null);
});

// --------------------------------------------------- regressionMetrics

test('regressionMetrics computes mae/rmse/mape/r2/mase/bias', () => {
    const log = [
        { predicted: 11, actual: 10, baseline: 9 },
        { predicted: 19, actual: 20, baseline: 19 },
        { predicted: 31, actual: 30, baseline: 29 },
    ];
    const m = regressionMetrics(log);
    assert.strictEqual(m.n, 3);
    assert.ok(Math.abs(m.mae - 1) < 1e-9);
    assert.ok(Math.abs(m.rmse - 1) < 1e-9);
    assert.ok(Math.abs(m.mase - 1) < 1e-9);          // naive MAE = 1 -> mase 1
    assert.ok(Math.abs(m.bias - 1 / 3) < 1e-9);
    assert.ok(Math.abs(m.r2 - 0.985) < 1e-9);        // 1 - 3/200
    assert.ok(Math.abs(m.mape - 6.111111111) < 1e-6);
});

test('regressionMetrics returns nulls for empty input', () => {
    assert.deepStrictEqual(regressionMetrics([]),
        { mae: null, rmse: null, mape: null, r2: null, mase: null, bias: null, n: 0 });
});

// ----------------------------------------------- classificationMetrics

test('classificationMetrics builds confusion matrix (UP = positive)', () => {
    const log = [
        { predDir: 'UP', actDir: 'UP' },     // TP
        { predDir: 'UP', actDir: 'UP' },     // TP
        { predDir: 'UP', actDir: 'DOWN' },   // FP
        { predDir: 'DOWN', actDir: 'UP' },   // FN
        { predDir: 'DOWN', actDir: 'DOWN' }, // TN
        { predDir: 'FLAT', actDir: 'UP' },   // ignored
    ];
    const c = classificationMetrics(log);
    assert.deepStrictEqual([c.tp, c.fp, c.fn, c.tn, c.n], [2, 1, 1, 1, 5]);
    assert.ok(Math.abs(c.precision - 2 / 3) < 1e-9);
    assert.ok(Math.abs(c.recall - 2 / 3) < 1e-9);
    assert.ok(Math.abs(c.f1 - 2 / 3) < 1e-9);
    assert.ok(Math.abs(c.accuracy - 0.6) < 1e-9);
});

// ------------------------------------------------- pesaranTimmermann

test('pesaranTimmermann flags significant directional skill', () => {
    // 10 perfectly-correct calls (6 UP, 4 DOWN): P=1, P*=0.52, stat=10/3
    const log = [];
    for (let i = 0; i < 6; i++) log.push({ predDir: 'UP', actDir: 'UP' });
    for (let i = 0; i < 4; i++) log.push({ predDir: 'DOWN', actDir: 'DOWN' });
    const pt = pesaranTimmermann(log);
    assert.strictEqual(pt.n, 10);
    assert.ok(Math.abs(pt.stat - 10 / 3) < 1e-6);
    assert.ok(pt.pValue < 0.05);
    assert.strictEqual(pt.significant, true);
    assert.ok(Math.abs(pt.accuracy - 100) < 1e-9);
});

test('pesaranTimmermann needs a minimum sample', () => {
    const pt = pesaranTimmermann([{ predDir: 'UP', actDir: 'UP' }]);
    assert.strictEqual(pt.stat, null);
    assert.strictEqual(pt.significant, false);
});

// ---------------------------------------------------- rollingMetrics

test('rollingMetrics buckets a log into time slices', () => {
    const log = [
        { time: 0,    errAbs: 2, correct: true },
        { time: 100,  errAbs: 4, correct: false },
        { time: 1000, errAbs: 1, correct: true },
        { time: 1100, errAbs: 3, correct: true },
    ];
    const r = rollingMetrics(log, 2);
    assert.deepStrictEqual(r[0], { dirAcc: 50, mae: 3, n: 2 });
    assert.deepStrictEqual(r[1], { dirAcc: 100, mae: 2, n: 2 });
});

// --------------------------------------------------- regimeBreakdown

test('regimeBreakdown classifies trend up/down by lookback', () => {
    const hist = [
        { time: 0,    c: 100 },
        { time: 300,  c: 100 },
        { time: 600,  c: 110 },  // idx2: vs idx0 100 -> +10% UP
        { time: 900,  c: 110 },
        { time: 1200, c: 99 },   // idx4: vs idx2 110 -> -10% DOWN
        { time: 1500, c: 99 },
    ];
    const log = [
        { time: 1200, errAbs: 5, correct: false },
        { time: 600,  errAbs: 1, correct: true },
    ];
    const rb = regimeBreakdown(log, hist, { trendLookback: 2, volWindow: 2, trendThreshold: 0.1 });
    assert.deepStrictEqual(rb.trend.UP, { dirAcc: 100, mae: 1, n: 1 });
    assert.deepStrictEqual(rb.trend.DOWN, { dirAcc: 0, mae: 5, n: 1 });
    assert.strictEqual(rb.trend.SIDEWAYS.n, 0);
});

// ------------------------------------------------------- tradingSim

test('tradingSim simulates a directional strategy', () => {
    const log = [
        { time: 0,   baseline: 100, actual: 101, predDir: 'UP' },   // +1%
        { time: 300, baseline: 100, actual: 99,  predDir: 'UP' },   // -1%
    ];
    const s = tradingSim(log, { fee: 0, barSec: 300 });
    assert.strictEqual(s.trades, 2);
    assert.strictEqual(s.sharpe, 0);                 // mean return 0
    assert.ok(Math.abs(s.profitFactor - 1) < 1e-9);
    assert.ok(Math.abs(s.winRate - 50) < 1e-9);
    assert.ok(Math.abs(s.cumReturn - -0.01) < 1e-6); // 1.01*0.99 = 0.9999
    assert.ok(Math.abs(s.maxDrawdown - 1.0) < 1e-3);
});

test('tradingSim takes no position on FLAT predictions', () => {
    const s = tradingSim([{ time: 0, baseline: 100, actual: 101, predDir: 'FLAT' }]);
    assert.strictEqual(s.trades, 0);
    assert.strictEqual(s.cumReturn, null);
});

// -------------------------------------------------- horizon awareness (v2 / 1H)
//
// The engine stores the two series with different timestamp conventions:
//   legacy 5m : entry.time = the close the forecast was made from, target is +300
//   v2   1h   : entry.time = the TARGET (hour_key + 3600), forecast made at t-3600
// Scoring both over a fixed 5-minute window measures the wrong thing for v2.

// closes rise by 1 every candle: closeAt[x] = 100 + (x - 300) / 300
const hourCandles = Array.from({ length: 25 }, (_, i) => ({ time: i * 300, c: 100 + i }));
const HC_LAST = 7200;                       // last (in-progress) candle open time

test('horizonOffsets: legacy names keep the 5-minute convention', () => {
    assert.deepStrictEqual(horizonOffsets('LSTM'), { base: 0, actual: 300 });
    assert.deepStrictEqual(horizonOffsets('Ensemble'), { base: 0, actual: 300 });
});

test('horizonOffsets: _v2 names are target-stamped one hour back', () => {
    assert.deepStrictEqual(horizonOffsets('LSTM_v2'), { base: -3600, actual: 0 });
    assert.deepStrictEqual(horizonOffsets('ARIMA_v2'), { base: -3600, actual: 0 });
});

test('horizonOffsets: opts override the inferred defaults', () => {
    assert.deepStrictEqual(horizonOffsets('LSTM', { horizonSec: 900 }), { base: 0, actual: 900 });
    assert.deepStrictEqual(horizonOffsets('X', { stampIsTarget: true, horizonSec: 1800 }),
        { base: -1800, actual: 0 });
});

// The 5-minute v2 challengers are v2 models that are NOT hourly. They are named
// *_v2_5m precisely so the trailing-_v2 hourly rule does not catch them; if this
// ever regresses they would be scored over the wrong horizon and silently look
// far worse than they are.
test('horizonOffsets: _v2_5m models keep the 5-minute convention', () => {
    assert.deepStrictEqual(horizonOffsets('LSTM_v2_5m'), { base: 0, actual: 300 });
    assert.deepStrictEqual(horizonOffsets('Transformer_v2_5m'), { base: 0, actual: 300 });
    // ...while their hourly siblings stay target-stamped.
    assert.deepStrictEqual(horizonOffsets('LSTM_v2'), { base: -3600, actual: 0 });
});

test('computeModelStats scores a _v2_5m model exactly like a legacy 5-min model', () => {
    const hist = [
        { time: 300, LSTM: 101, LSTM_v2_5m: 101 },
        { time: 600, LSTM: 103, LSTM_v2_5m: 103 },
        { time: 900, LSTM: 99, LSTM_v2_5m: 99 }
    ];
    const legacy = computeModelStats(hist, candles, 'LSTM');
    const v25m = computeModelStats(hist, candles, 'LSTM_v2_5m');
    assert.deepStrictEqual(v25m, legacy);
});

test('buildPredictionLog scores a _v2 model against the close one hour earlier', () => {
    // t=6900 -> baseline closeAt[3300]=110, actual closeAt[6900]=122
    const log = buildPredictionLog([{ time: 6900, M_v2: 117 }], hourCandles, 'M_v2');
    assert.strictEqual(log.length, 1);
    assert.strictEqual(log[0].baseline, 110);   // NOT closeAt[6900]
    assert.strictEqual(log[0].actual, 122);     // NOT closeAt[7200]
    assert.strictEqual(log[0].predDir, 'UP');   // 117 > 110
    assert.strictEqual(log[0].actDir, 'UP');    // 122 > 110
    assert.strictEqual(log[0].correct, true);
});

test('buildPredictionLog: a _v2 entry whose realized candle is still open is not matured', () => {
    // t=7500 would realize at closeAt[7500], whose candle (open 7200) is in progress
    const log = buildPredictionLog([{ time: 7500, M_v2: 120 }], hourCandles, 'M_v2');
    assert.strictEqual(log.length, 0);
    // t=7200 realizes at closeAt[7200] (candle open 6900) -> closed, so it counts
    const ok = buildPredictionLog([{ time: 7200, M_v2: 120 }], hourCandles, 'M_v2');
    assert.strictEqual(ok.length, 1);
    assert.strictEqual(ok[0].baseline, 111);    // closeAt[3600]
    assert.strictEqual(ok[0].actual, 123);      // closeAt[7200]
});

test('buildPredictionLog: the same timestamps score differently per series', () => {
    const v2 = buildPredictionLog([{ time: 6900, M_v2: 117 }], hourCandles, 'M_v2');
    const legacy = buildPredictionLog([{ time: 6900, M: 117 }], hourCandles, 'M');
    assert.strictEqual(v2[0].baseline, 110);        // one hour back
    assert.strictEqual(legacy[0].baseline, 122);    // the close at t
    assert.notStrictEqual(v2[0].actual, legacy[0].actual);
});

test('computeModelStats uses the same horizon rule as buildPredictionLog', () => {
    const s = computeModelStats([{ time: 6900, M_v2: 117 }], hourCandles, 'M_v2');
    assert.strictEqual(s.errorCount, 1);
    assert.strictEqual(s.dirCount, 1);
    assert.strictEqual(s.dirAccuracy, 100);         // UP predicted, UP realized
    // |117 - 122| / 122 * 100
    assert.ok(Math.abs(s.avgError - (5 / 122 * 100)) < 1e-9);
});

test('computeModelStats: legacy models are unaffected by the horizon change', () => {
    const s = computeModelStats([{ time: 300, M: 103 }], evalCandles, 'M');
    assert.strictEqual(s.errorCount, 1);
    assert.strictEqual(s.dirAccuracy, 100);         // baseline 100, actual 102, pred 103
});

// ===================================================================
// Wilson confidence interval / directionInterval
// ===================================================================
const { wilsonInterval, directionInterval, marketSnapshot, modelAgreement } = ChartUtils;

test('wilsonInterval: a coin-flip sample straddles 50%', () => {
    const ci = wilsonInterval(132, 264);            // exactly 50%
    assert.strictEqual(ci.point, 50);
    assert.ok(ci.low < 50 && ci.high > 50);
    assert.strictEqual(ci.straddlesChance, true);
});

test('wilsonInterval: n=264 at 56.8% still spans 50% (the ARIMA_v2 case)', () => {
    // The measured live figure that prompted this work: nominally the best model,
    // but the interval reaches below chance, so the lead is not established.
    const ci = wilsonInterval(150, 264);
    assert.ok(Math.abs(ci.point - 56.8) < 0.2);
    assert.ok(ci.low < 51, 'lower bound should sit near/below 50 at this n');
});

test('wilsonInterval: bounds stay inside [0,100] at extremes (where Wald fails)', () => {
    const perfect = wilsonInterval(10, 10);
    assert.ok(perfect.high <= 100 && perfect.low > 0, 'no bound above 100%');
    const none = wilsonInterval(0, 10);
    assert.ok(none.low >= 0 && none.high < 100, 'no bound below 0%');
});

test('wilsonInterval: the interval narrows as n grows at a fixed rate', () => {
    const small = wilsonInterval(55, 100);
    const big = wilsonInterval(550, 1000);
    assert.ok((big.high - big.low) < (small.high - small.low));
});

test('wilsonInterval: n=0 returns nulls rather than NaN', () => {
    const ci = wilsonInterval(0, 0);
    assert.strictEqual(ci.low, null);
    assert.strictEqual(ci.high, null);
    assert.strictEqual(ci.n, 0);
});

test('directionInterval counts scoreable calls only, never the matured total', () => {
    const log = [
        { correct: true }, { correct: true }, { correct: false },
        { correct: null },        // FLAT move — no direction to score
        { correct: undefined }    // missing baseline
    ];
    const ci = directionInterval(log);
    assert.strictEqual(ci.n, 3);
    assert.ok(Math.abs(ci.point - (2 / 3 * 100)) < 1e-9);
});

// ===================================================================
// marketSnapshot
// ===================================================================
function ramp(n, start, stepPct) {
    const out = []; let p = start;
    for (let i = 0; i < n; i++) { out.push({ time: i * 300, c: p }); p *= (1 + stepPct / 100); }
    return out;
}

test('marketSnapshot flags a steady climb as UP', () => {
    const s = marketSnapshot(ramp(60, 100, 0.05));
    assert.strictEqual(s.trend, 'UP');
    assert.ok(s.changePct > 0.1);
});

test('marketSnapshot flags a steady fall as DOWN', () => {
    const s = marketSnapshot(ramp(60, 100, -0.05));
    assert.strictEqual(s.trend, 'DOWN');
    assert.ok(s.changePct < -0.1);
});

test('marketSnapshot calls a flat tape SIDEWAYS', () => {
    const flat = [];
    for (let i = 0; i < 60; i++) flat.push({ time: i * 300, c: 100 });
    const s = marketSnapshot(flat);
    assert.strictEqual(s.trend, 'SIDEWAYS');
    assert.strictEqual(s.volPct, 0);
});

test('marketSnapshot: volClass is relative, so a calm tail after a wild run reads LOW', () => {
    const c = []; let p = 100;
    for (let i = 0; i < 200; i++) { p *= 1 + ((i % 2 ? 1 : -1) * 0.6) / 100; c.push({ time: i * 300, c: p }); }
    for (let i = 200; i < 240; i++) { p *= 1.00001; c.push({ time: i * 300, c: p }); }
    assert.strictEqual(marketSnapshot(c).volClass, 'LOW');
});

test('marketSnapshot returns an empty shape for too little data', () => {
    assert.strictEqual(marketSnapshot([]).n, 0);
    assert.strictEqual(marketSnapshot([{ time: 0, c: 1 }]).trend, null);
});

// ===================================================================
// modelAgreement
// ===================================================================
test('modelAgreement splits up/down/flat and scores consensus over directional only', () => {
    const a = modelAgreement({
        A: { change_pct: 0.5 }, B: { change_pct: 0.2 }, C: { change_pct: 0.4 },
        D: { change_pct: -0.3 },
        E: { change_pct: 0.001 }            // inside the flat band
    }, ['A', 'B', 'C', 'D', 'E']);
    assert.strictEqual(a.up, 3);
    assert.strictEqual(a.down, 1);
    assert.strictEqual(a.flat, 1);
    assert.strictEqual(a.total, 5);
    assert.strictEqual(a.directional, 4);
    assert.strictEqual(a.majority, 'UP');
    assert.strictEqual(a.consensus, 75);   // 3 of 4 that took a side, NOT 3 of 5
});

test('modelAgreement: an even split reports 50% consensus', () => {
    const a = modelAgreement({ A: { change_pct: 1 }, B: { change_pct: -1 } }, ['A', 'B']);
    assert.strictEqual(a.consensus, 50);
});

test('modelAgreement: all-flat yields no majority instead of a fake one', () => {
    const a = modelAgreement({ A: { change_pct: 0 }, B: { change_pct: 0.001 } }, ['A', 'B']);
    assert.strictEqual(a.directional, 0);
    assert.strictEqual(a.majority, null);
    assert.strictEqual(a.consensus, null);
});

test('modelAgreement skips models with no live prediction', () => {
    const a = modelAgreement({ A: { change_pct: 1 } }, ['A', 'B', 'C']);
    assert.strictEqual(a.total, 1);
    assert.deepStrictEqual(Object.keys(a.byModel), ['A']);
});

test('modelAgreement tolerates a null predictions object', () => {
    const a = modelAgreement(null, ['A']);
    assert.strictEqual(a.total, 0);
    assert.strictEqual(a.majority, null);
});

// ===================================================================
// computeModelStats now carries the interval
// ===================================================================
test('computeModelStats exposes dirHits + dirCI consistent with dirCount', () => {
    const s = computeModelStats([{ time: 6900, M_v2: 117 }], hourCandles, 'M_v2');
    assert.strictEqual(s.dirHits, 1);
    assert.strictEqual(s.dirCI.n, s.dirCount);
    assert.ok(s.dirCI.low >= 0 && s.dirCI.high <= 100);
});

test('computeModelStats: empty result still returns a usable dirCI', () => {
    const s = computeModelStats([], hourCandles, 'M_v2');
    assert.strictEqual(s.dirCount, 0);
    assert.strictEqual(s.dirCI.low, null);
});

test('wilsonInterval: an interval entirely BELOW 50% is flagged distinctly, not as "good"', () => {
    // The live LSTM (1H) case on a short window: 2 of 12 correct. Statistically clear,
    // but clear in the WRONG direction — it must never share a verdict with a real edge.
    const ci = wilsonInterval(2, 12);
    assert.strictEqual(ci.straddlesChance, false);
    assert.strictEqual(ci.beatsChance, false);
    assert.strictEqual(ci.belowChance, true);
    assert.ok(ci.high < 50);
});

test('wilsonInterval: an interval entirely ABOVE 50% sets beatsChance only', () => {
    const ci = wilsonInterval(900, 1000);
    assert.strictEqual(ci.beatsChance, true);
    assert.strictEqual(ci.belowChance, false);
    assert.strictEqual(ci.straddlesChance, false);
});

test('wilsonInterval: the three verdicts are mutually exclusive at every n', () => {
    for (let n = 1; n <= 60; n++) {
        for (let h = 0; h <= n; h++) {
            const ci = wilsonInterval(h, n);
            const flags = [ci.beatsChance, ci.belowChance, ci.straddlesChance].filter(Boolean);
            assert.strictEqual(flags.length, 1,
                `exactly one verdict expected for ${h}/${n}, got ${flags.length}`);
        }
    }
});
