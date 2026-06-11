/*
 * Unit tests for website/chart-utils.js
 * Run with:  node --test website/tests/
 */
const { test } = require('node:test');
const assert = require('node:assert');
const ChartUtils = require('../chart-utils.js');

const { toMs, filterSanePoints, insertGapBreaks, computeModelErrors, computeModelStats, splitAtGaps, recentFocusRange } = ChartUtils;

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

// Candles: opens 0..900, each closes 300s later.
// closeAt keys: 300->100, 600->102, 900->104, 1200->106
const statCandles = [
    { time: 0,   c: 100 },
    { time: 300, c: 102 },
    { time: 600, c: 104 },
    { time: 900, c: 106 },
];

test('computeModelStats: directional accuracy counts correct calls', () => {
    // Target t=900: actual = closeAt(900) = 104, baseline = closeAt(300) = 100
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

test('computeModelStats: error average matches computeModelErrors logic', () => {
    const predHist = [{ time: 900, LSTM: 105.04 }]; // actual 104 -> 1% error
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
    // Baseline closeAt(300)=100 and actual closeAt(900)=100 -> flat move
    const flatCandles = [
        { time: 0,   c: 100 },
        { time: 300, c: 101 },
        { time: 600, c: 100 },
        { time: 900, c: 100 },
    ];
    const predHist = [{ time: 900, LSTM: 105 }];
    const stats = computeModelStats(predHist, flatCandles, 'LSTM');
    assert.strictEqual(stats.errorCount, 1);     // error still measured
    assert.strictEqual(stats.dirCount, 0);       // direction not scored
    assert.strictEqual(stats.dirAccuracy, null);
});

test('computeModelStats: missing baseline candle skips direction, keeps error', () => {
    // Only the actual's candle exists; t-600/t-900 closes are absent
    const sparse = [{ time: 600, c: 104 }];      // closeAt: 900 -> 104... but lastCandleTime=600 < t=900
    const sparse2 = [{ time: 600, c: 104 }, { time: 900, c: 105 }];
    const predHist = [{ time: 900, LSTM: 103 }];
    const stats = computeModelStats(predHist, sparse2, 'LSTM');
    assert.strictEqual(stats.errorCount, 1);
    assert.strictEqual(stats.dirCount, 0);
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
        { avgError: null, errorCount: 0, dirAccuracy: null, dirCount: 0 });
    assert.deepStrictEqual(
        computeModelStats([{ time: 900, LSTM: 105 }], [], 'LSTM'),
        { avgError: null, errorCount: 0, dirAccuracy: null, dirCount: 0 });
});
