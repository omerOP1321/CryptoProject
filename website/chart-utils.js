/*
 * Pure chart-data helpers for the Crypto AI Predictions Dashboard.
 * No DOM / chart-library dependencies, so the logic is unit-testable in Node.
 * Loaded in the browser as window.ChartUtils, in Node via require().
 */
(function (root, factory) {
    if (typeof module === 'object' && module.exports) {
        module.exports = factory();
    } else {
        root.ChartUtils = factory();
    }
}(typeof self !== 'undefined' ? self : this, function () {
    'use strict';

    // Chart times are unix seconds (5m/1h) or 'YYYY-MM-DD' strings (1d)
    function toMs(t) {
        return typeof t === 'string' ? Date.parse(t) : t * 1000;
    }

    /*
     * Drop points whose value is further than `tolerance` (relative) from the
     * market reference price at that time. Catches garbage left in history by
     * old engine versions and any extreme outliers that would wreck the scale.
     * `nearestClose(time)` returns the candle close at/near that time, or
     * undefined; `fallbackPrice` is used when no candle matches.
     */
    function filterSanePoints(points, nearestClose, fallbackPrice, tolerance) {
        tolerance = tolerance === undefined ? 0.05 : tolerance;
        return points.filter(function (p) {
            if (!Number.isFinite(p.value)) return false;
            var ref = nearestClose(p.time);
            var base = ref !== undefined ? ref : fallbackPrice;
            if (!Number.isFinite(base) || base <= 0) return false;
            return Math.abs(p.value - base) / base <= tolerance;
        });
    }

    /*
     * Insert whitespace items (time only, no value) wherever two consecutive
     * points are further apart than maxGapMs, so the chart renders separate
     * segments instead of a straight line across the missing period.
     * Points must already be sorted by time.
     * NOTE: Lightweight Charts line series connect straight across whitespace,
     * so for that library use splitAtGaps() and draw one series per segment.
     */
    function insertGapBreaks(points, maxGapMs, isDaily) {
        var out = [];
        points.forEach(function (p, i) {
            if (i > 0 && toMs(p.time) - toMs(points[i - 1].time) > maxGapMs) {
                var prev = points[i - 1].time;
                out.push(isDaily
                    ? { time: new Date(toMs(prev) + 86400000).toISOString().split('T')[0] }
                    : { time: prev + 1 });
            }
            out.push(p);
        });
        return out;
    }

    /*
     * Split sorted points into contiguous runs wherever two consecutive points
     * are further apart than maxGapMs. Each run is rendered as a separate line
     * series so missing periods show as real gaps.
     */
    function splitAtGaps(points, maxGapMs) {
        var segments = [];
        var current = [];
        points.forEach(function (p, i) {
            if (i > 0 && toMs(p.time) - toMs(points[i - 1].time) > maxGapMs) {
                segments.push(current);
                current = [];
            }
            current.push(p);
        });
        if (current.length) segments.push(current);
        return segments;
    }

    /*
     * Find service outages in a prediction series: stretches where the engine
     * published nothing for at least minGapSec.
     *
     * splitAtGaps() already stops the chart drawing a line across these, but an
     * unlabelled break reads as "the models had nothing to say" when the truth is
     * "the data never reached the database". The 2026-07-12..15 outage is the real
     * case: the engine predicted every 5 minutes throughout, and Supabase rejected
     * all 986 cycles with 402 exceed_egress_quota. Those predictions are gone and
     * cannot be honestly reconstructed, so the gap is permanent and worth naming.
     *
     * Derived from the data rather than hardcoded to that incident, so any future
     * outage labels itself. Returns [{ fromSec, toSec, durationSec }].
     */
    function findOutages(predHist, minGapSec) {
        var minGap = minGapSec || 3600;
        if (!Array.isArray(predHist)) return [];
        var times = predHist
            .map(function (e) { return Number(e && e.time); })
            .filter(function (t) { return Number.isFinite(t); })
            .sort(function (a, b) { return a - b; });
        var out = [];
        for (var i = 1; i < times.length; i++) {
            var gap = times[i] - times[i - 1];
            if (gap >= minGap) {
                out.push({ fromSec: times[i - 1], toSec: times[i], durationSec: gap });
            }
        }
        return out;
    }

    /* Human-readable outage length, e.g. "82h" / "75min" / "3.4 days". */
    function formatOutage(sec) {
        if (sec >= 86400) return (sec / 86400).toFixed(1) + ' days';
        if (sec >= 3600) return Math.round(sec / 3600) + 'h';
        return Math.round(sec / 60) + 'min';
    }

    /*
     * Average relative error (%) of a model's matured predictions.
     * predHist entries: { time: <target unix sec>, <modelName>: <predicted price> }
     * hist5m entries:   { time: <candle open unix sec>, c: <close> }
     * A candle opening at t closes at t+300, so its close is the actual
     * price at the prediction target written as t+300.
     * Returns { avg: number|null, count: number } over the last `lastN`
     * matured predictions.
     */
    function computeModelErrors(predHist, hist5m, modelName, lastN) {
        lastN = lastN === undefined ? 20 : lastN;
        if (!Array.isArray(predHist) || !Array.isArray(hist5m) || hist5m.length === 0) {
            return { avg: null, count: 0 };
        }
        var closeAt = new Map(hist5m.map(function (c) { return [c.time + 300, c.c]; }));
        var lastCandleTime = hist5m[hist5m.length - 1].time;
        var errors = [];
        predHist.forEach(function (entry) {
            var pred = Number(entry[modelName]);
            if (entry[modelName] === null || entry[modelName] === undefined || !Number.isFinite(pred)) return;
            var t = Number(entry.time);
            if (!Number.isFinite(t) || t > lastCandleTime) return; // not matured yet
            var actual = closeAt.get(t);
            if (actual === undefined) actual = closeAt.get(t - 300);
            if (actual === undefined) actual = closeAt.get(t + 300);
            if (actual === undefined || actual <= 0) return;
            errors.push(Math.abs(pred - actual) / actual * 100);
        });
        var recent = errors.slice(-lastN);
        if (recent.length === 0) return { avg: null, count: 0 };
        var sum = recent.reduce(function (a, b) { return a + b; }, 0);
        return { avg: sum / recent.length, count: recent.length };
    }

    /*
     * Combined accuracy stats for a model over a time window.
     *
     * Relative error: |predicted - actual| / actual * 100, averaged.
     * Directional accuracy: % of predictions whose direction matched the
     * actual move. Models forecast 1 candle (5 min) ahead, and a prediction is
     * stored at t = the predicted candle's open time. Its realized price is that
     * candle's close = closeAt[t+300]; the baseline (price when the prediction
     * was made) is the previous close = closeAt[t]. Predicted/actual moves are
     * measured from that baseline; zero moves carry no direction.
     *
     * opts: { fromSec, toSec, lastN } - window bounds (unix sec, inclusive)
     * and a cap on how many of the most recent matured predictions count.
     * Returns { avgError, errorCount, dirAccuracy, dirCount }.
     */
    function computeModelStats(predHist, hist5m, modelName, opts) {
        opts = opts || {};
        var lastN = opts.lastN === undefined ? Infinity : opts.lastN;
        var fromSec = opts.fromSec === undefined ? -Infinity : opts.fromSec;
        var toSec = opts.toSec === undefined ? Infinity : opts.toSec;
        var empty = { avgError: null, errorCount: 0, dirAccuracy: null, dirCount: 0 };
        if (!Array.isArray(predHist) || !Array.isArray(hist5m) || hist5m.length === 0) {
            return empty;
        }
        var closeAt = new Map(hist5m.map(function (c) { return [c.time + 300, c.c]; }));
        var lastCandleTime = hist5m[hist5m.length - 1].time;

        var matured = [];
        predHist.forEach(function (entry) {
            var raw = entry[modelName];
            var pred = Number(raw);
            if (raw === null || raw === undefined || !Number.isFinite(pred)) return;
            var t = Number(entry.time);
            // Matured only when the predicted candle (open t) has FULLY CLOSED, i.e. a
            // later candle exists (t strictly before the last, in-progress candle).
            // Using `t > lastCandleTime` would include the in-progress target candle
            // and evaluate against its non-final running close.
            if (!Number.isFinite(t) || t >= lastCandleTime || t < fromSec || t > toSec) return;
            // Realized price = predicted candle's final close = closeAt[t+300]. Require it
            // exactly (clean 300s grid); a gap here means we can't evaluate -> skip.
            var actual = closeAt.get(t + 300);
            if (actual === undefined || actual <= 0) return;
            // Baseline = price when the prediction was made = previous close = closeAt[t].
            // If absent (data gap), direction is left unscored below.
            var base = closeAt.get(t);
            matured.push({
                err: Math.abs(pred - actual) / actual * 100,
                pred: pred,
                actual: actual,
                base: base
            });
        });

        var recent = matured.slice(-lastN);
        if (recent.length === 0) return empty;

        var errSum = 0, dirHits = 0, dirTotal = 0;
        recent.forEach(function (m) {
            errSum += m.err;
            if (m.base === undefined || m.base <= 0) return;
            var predMove = m.pred - m.base;
            var actMove = m.actual - m.base;
            if (predMove === 0 || actMove === 0) return;
            dirTotal++;
            if ((predMove > 0) === (actMove > 0)) dirHits++;
        });

        return {
            avgError: errSum / recent.length,
            errorCount: recent.length,
            dirAccuracy: dirTotal > 0 ? dirHits / dirTotal * 100 : null,
            dirCount: dirTotal
        };
    }

    /*
     * Logical visible range for "recent focus" auto-scale: show the most recent
     * `focusBars` candles plus `rightOffset` bars of empty space on the right so
     * the future prediction target is visible. Bars are indexed 0..barCount-1.
     * Returns { from, to } for setVisibleLogicalRange, or null if there's no data.
     */
    function recentFocusRange(barCount, focusBars, rightOffset) {
        if (!barCount || barCount <= 0) return null;
        focusBars = focusBars || 48;
        rightOffset = rightOffset || 0;
        return {
            from: Math.max(0, barCount - focusBars),
            to: barCount - 1 + rightOffset
        };
    }

    /* ======================================================================
     * EVALUATION METRICS
     * Pure functions for the prediction-history log and the analytics suite.
     * All build on the same maturation rules as computeModelStats():
     *   actual   = closeAt[t + 300]  (the predicted candle's final close)
     *   baseline = closeAt[t]        (the close when the prediction was made)
     * and the in-progress candle (t === lastCandleTime) is never matured.
     * ====================================================================== */

    /*
     * One record per matured prediction, NEWEST FIRST. Each record:
     *   { time, predicted, actual, baseline, errAbs, errPct,
     *     predDir, actDir, correct }
     * dir is 'UP' | 'DOWN' | 'FLAT' (FLAT = zero move). `correct` is true/false
     * when both directions are non-FLAT, else null (no direction to score).
     * opts: { fromSec, toSec, lastN } window bounds (unix sec) + cap on records.
     */
    function buildPredictionLog(predHist, hist5m, modelName, opts) {
        opts = opts || {};
        var fromSec = opts.fromSec === undefined ? -Infinity : opts.fromSec;
        var toSec = opts.toSec === undefined ? Infinity : opts.toSec;
        if (!Array.isArray(predHist) || !Array.isArray(hist5m) || hist5m.length === 0) return [];
        var closeAt = new Map(hist5m.map(function (c) { return [c.time + 300, c.c]; }));
        var lastCandleTime = hist5m[hist5m.length - 1].time;
        var out = [];
        predHist.forEach(function (entry) {
            var raw = entry[modelName];
            var pred = Number(raw);
            if (raw === null || raw === undefined || !Number.isFinite(pred)) return;
            var t = Number(entry.time);
            if (!Number.isFinite(t) || t >= lastCandleTime || t < fromSec || t > toSec) return;
            var actual = closeAt.get(t + 300);
            if (actual === undefined || actual <= 0) return;
            var baseline = closeAt.get(t);
            var errAbs = Math.abs(pred - actual);
            var errPct = actual !== 0 ? errAbs / Math.abs(actual) * 100 : null;
            var predDir = null, actDir = null, correct = null;
            if (baseline !== undefined && baseline > 0) {
                var pm = pred - baseline, am = actual - baseline;
                predDir = pm > 0 ? 'UP' : (pm < 0 ? 'DOWN' : 'FLAT');
                actDir = am > 0 ? 'UP' : (am < 0 ? 'DOWN' : 'FLAT');
                if (predDir !== 'FLAT' && actDir !== 'FLAT') correct = (predDir === actDir);
            }
            out.push({
                time: t, predicted: pred, actual: actual,
                baseline: baseline === undefined ? null : baseline,
                errAbs: errAbs, errPct: errPct,
                predDir: predDir, actDir: actDir, correct: correct
            });
        });
        out.sort(function (a, b) { return b.time - a.time; }); // newest first
        if (opts.lastN !== undefined && out.length > opts.lastN) out = out.slice(0, opts.lastN);
        return out;
    }

    /*
     * Point-forecast error metrics over a prediction log.
     * MASE = MAE / mean(|actual - baseline|): scales the model's error against a
     * naive "no change" (random-walk) forecast. MASE < 1 beats naive; >= 1 does not.
     * Returns { mae, rmse, mape, r2, mase, bias, n } (nulls when undefined).
     */
    function regressionMetrics(log) {
        var empty = { mae: null, rmse: null, mape: null, r2: null, mase: null, bias: null, n: 0 };
        if (!Array.isArray(log) || log.length === 0) return empty;
        var n = log.length;
        var sumAbs = 0, sumSq = 0, sumPct = 0, pctCount = 0, sumBias = 0, sumActual = 0;
        var naiveSum = 0, naiveCount = 0;
        log.forEach(function (r) {
            var e = r.predicted - r.actual;
            sumAbs += Math.abs(e); sumSq += e * e; sumBias += e; sumActual += r.actual;
            if (r.actual !== 0) { sumPct += Math.abs(e) / Math.abs(r.actual); pctCount++; }
            if (r.baseline !== null && r.baseline !== undefined) {
                naiveSum += Math.abs(r.actual - r.baseline); naiveCount++;
            }
        });
        var mae = sumAbs / n;
        var meanActual = sumActual / n;
        var ssRes = 0, ssTot = 0;
        log.forEach(function (r) {
            ssRes += Math.pow(r.actual - r.predicted, 2);
            ssTot += Math.pow(r.actual - meanActual, 2);
        });
        var naiveMae = naiveCount > 0 ? naiveSum / naiveCount : 0;
        return {
            mae: mae,
            rmse: Math.sqrt(sumSq / n),
            mape: pctCount > 0 ? sumPct / pctCount * 100 : null,
            r2: ssTot > 0 ? 1 - ssRes / ssTot : null,
            mase: naiveMae > 0 ? mae / naiveMae : null,
            bias: sumBias / n,
            n: n
        };
    }

    /*
     * Binary directional classification (positive class = UP). Only records with
     * both directions non-FLAT are scored. Returns the 2x2 confusion counts plus
     * { precision, recall, f1, accuracy, winRate, n }.
     */
    function classificationMetrics(log) {
        var tp = 0, fp = 0, fn = 0, tn = 0;
        (log || []).forEach(function (r) {
            if (r.predDir === 'FLAT' || r.actDir === 'FLAT' || r.predDir == null || r.actDir == null) return;
            var p = r.predDir === 'UP', a = r.actDir === 'UP';
            if (p && a) tp++; else if (p && !a) fp++; else if (!p && a) fn++; else tn++;
        });
        var total = tp + fp + fn + tn;
        var precision = (tp + fp) > 0 ? tp / (tp + fp) : null;
        var recall = (tp + fn) > 0 ? tp / (tp + fn) : null;
        var f1 = (precision !== null && recall !== null && (precision + recall) > 0)
            ? 2 * precision * recall / (precision + recall) : null;
        var accuracy = total > 0 ? (tp + tn) / total : null;
        return { tp: tp, fp: fp, fn: fn, tn: tn, n: total,
                 precision: precision, recall: recall, f1: f1,
                 accuracy: accuracy, winRate: accuracy };
    }

    // Error function (Abramowitz & Stegun 7.1.26) and standard-normal CDF.
    function erf(x) {
        var sign = x < 0 ? -1 : 1;
        x = Math.abs(x);
        var a1 = 0.254829592, a2 = -0.284496736, a3 = 1.421413741,
            a4 = -1.453152027, a5 = 1.061405429, p = 0.3275911;
        var t = 1 / (1 + p * x);
        var y = 1 - (((((a5 * t + a4) * t) + a3) * t + a2) * t + a1) * t * Math.exp(-x * x);
        return sign * y;
    }
    function normalCdf(z) { return 0.5 * (1 + erf(z / Math.SQRT2)); }

    /*
     * Pesaran-Timmermann (1992) test of directional accuracy. Tests whether the
     * proportion of correct up/down calls is significantly better than chance.
     * Returns { stat, pValue, significant, n, accuracy } (one-sided p; skill > chance).
     * Needs a minimum sample for the asymptotic normal approximation to hold.
     */
    function pesaranTimmermann(log) {
        var xs = [], ys = [];
        (log || []).forEach(function (r) {
            if (r.predDir === 'FLAT' || r.actDir === 'FLAT' || r.predDir == null || r.actDir == null) return;
            xs.push(r.predDir === 'UP' ? 1 : 0);
            ys.push(r.actDir === 'UP' ? 1 : 0);
        });
        var n = xs.length;
        if (n < 8) return { stat: null, pValue: null, significant: false, n: n, accuracy: null };
        var correct = 0, sx = 0, sy = 0;
        for (var i = 0; i < n; i++) { if (xs[i] === ys[i]) correct++; sx += xs[i]; sy += ys[i]; }
        var P = correct / n, Px = sx / n, Py = sy / n;
        var Pstar = Px * Py + (1 - Px) * (1 - Py);
        var fail = { stat: null, pValue: null, significant: false, n: n, accuracy: P * 100 };
        if (Pstar <= 0 || Pstar >= 1) return fail;
        var varP = Pstar * (1 - Pstar) / n;
        var varPstar = (Math.pow(2 * Py - 1, 2) * Px * (1 - Px) +
                        Math.pow(2 * Px - 1, 2) * Py * (1 - Py) +
                        4 * Px * Py * (1 - Px) * (1 - Py) / n) / n;
        var denom = varP - varPstar;
        if (denom <= 0) return fail;
        var stat = (P - Pstar) / Math.sqrt(denom);
        var pValue = 1 - normalCdf(stat);
        return { stat: stat, pValue: pValue, significant: pValue < 0.05, n: n, accuracy: P * 100 };
    }

    /*
     * Bucket a prediction log into nBuckets equal time slices (oldest -> newest)
     * and return per-bucket { dirAcc, mae, n } for rolling-performance charts.
     */
    function rollingMetrics(log, nBuckets) {
        nBuckets = nBuckets || 12;
        var out = [];
        for (var k = 0; k < nBuckets; k++) out.push({ dirAcc: null, mae: null, n: 0 });
        if (!Array.isArray(log) || log.length === 0) return out;
        var arr = log.slice().sort(function (a, b) { return a.time - b.time; });
        var tmin = arr[0].time, tmax = arr[arr.length - 1].time;
        var span = (tmax - tmin) || 1;
        var buckets = [];
        for (var i = 0; i < nBuckets; i++) buckets.push({ hits: 0, dir: 0, errSum: 0, n: 0 });
        arr.forEach(function (r) {
            var idx = Math.floor((r.time - tmin) / span * nBuckets);
            if (idx >= nBuckets) idx = nBuckets - 1; if (idx < 0) idx = 0;
            var b = buckets[idx];
            b.errSum += r.errAbs; b.n++;
            if (r.correct !== null) { b.dir++; if (r.correct) b.hits++; }
        });
        return buckets.map(function (b) {
            return { dirAcc: b.dir > 0 ? b.hits / b.dir * 100 : null,
                     mae: b.n > 0 ? b.errSum / b.n : null, n: b.n };
        });
    }

    /*
     * Directional accuracy + MAE grouped by market regime at each prediction's
     * baseline time. Trend: close vs `trendLookback` candles back (UP/DOWN/SIDEWAYS
     * by +/-trendThreshold percent). Volatility: stddev of the last `volWindow`
     * returns, split into LOW/MED/HIGH terciles across the log. Returns
     * { trend: {UP,DOWN,SIDEWAYS}, volatility: {LOW,MED,HIGH} } of {dirAcc,mae,n}.
     */
    function regimeBreakdown(log, hist5m, opts) {
        opts = opts || {};
        var lookback = opts.trendLookback || 12;
        var volWindow = opts.volWindow || 12;
        var trendThresh = opts.trendThreshold === undefined ? 0.1 : opts.trendThreshold;
        function blank() { return { hits: 0, dir: 0, errSum: 0, n: 0 }; }
        var trend = { UP: blank(), DOWN: blank(), SIDEWAYS: blank() };
        var vol = { LOW: blank(), MED: blank(), HIGH: blank() };
        function fin(g) {
            var o = {};
            Object.keys(g).forEach(function (k) {
                var b = g[k];
                o[k] = { dirAcc: b.dir > 0 ? b.hits / b.dir * 100 : null,
                         mae: b.n > 0 ? b.errSum / b.n : null, n: b.n };
            });
            return o;
        }
        function finalize() { return { trend: fin(trend), volatility: fin(vol) }; }
        if (!Array.isArray(log) || !log.length || !Array.isArray(hist5m) || !hist5m.length) return finalize();

        var idxByTime = new Map();
        var closes = [];
        hist5m.forEach(function (c, i) { idxByTime.set(c.time, i); closes.push(c.c); });
        var rets = [0];
        for (var i = 1; i < closes.length; i++) rets.push(closes[i - 1] > 0 ? (closes[i] - closes[i - 1]) / closes[i - 1] : 0);
        function stddev(a) {
            if (a.length < 2) return 0;
            var m = a.reduce(function (s, v) { return s + v; }, 0) / a.length;
            var v = a.reduce(function (s, x) { return s + (x - m) * (x - m); }, 0) / a.length;
            return Math.sqrt(v);
        }
        function accum(b, r) { b.errSum += r.errAbs; b.n++; if (r.correct !== null) { b.dir++; if (r.correct) b.hits++; } }

        var records = [];
        log.forEach(function (r) {
            var idx = idxByTime.get(r.time);
            if (idx === undefined) return;
            var back = idx - lookback;
            var trendClass = 'SIDEWAYS';
            if (back >= 0 && closes[back] > 0) {
                var chg = (closes[idx] - closes[back]) / closes[back] * 100;
                if (chg > trendThresh) trendClass = 'UP';
                else if (chg < -trendThresh) trendClass = 'DOWN';
            }
            var lo = Math.max(0, idx - volWindow + 1);
            records.push({ r: r, trendClass: trendClass, vol: stddev(rets.slice(lo, idx + 1)) });
        });
        if (!records.length) return finalize();
        var sortedVol = records.map(function (x) { return x.vol; }).sort(function (a, b) { return a - b; });
        var q1 = sortedVol[Math.floor(sortedVol.length / 3)];
        var q2 = sortedVol[Math.floor(sortedVol.length * 2 / 3)];
        records.forEach(function (x) {
            accum(trend[x.trendClass], x.r);
            var vc = x.vol <= q1 ? 'LOW' : (x.vol <= q2 ? 'MED' : 'HIGH');
            accum(vol[vc], x.r);
        });
        return finalize();
    }

    /*
     * Simulate a directional trading strategy from a prediction log: take a long
     * (+1) position when the model predicts UP, short (-1) when DOWN; the trade's
     * return is position * (actual - baseline) / baseline, minus an optional fee.
     * Returns { sharpe, profitFactor, maxDrawdown, cumReturn, equityCurve, trades,
     * winRate }. Sharpe is annualized using barSec (5m default). FLAT predictions
     * take no position. NOTE: with near-coin-flip models these are honestly poor.
     */
    function tradingSim(log, opts) {
        opts = opts || {};
        var fee = opts.fee || 0;
        var barSec = opts.barSec || 300;
        var empty = { sharpe: null, profitFactor: null, maxDrawdown: null,
                      cumReturn: null, equityCurve: [], trades: 0, winRate: null };
        if (!Array.isArray(log) || !log.length) return empty;
        var arr = log.slice().sort(function (a, b) { return a.time - b.time; });
        var rets = [], times = [];
        arr.forEach(function (r) {
            if (r.baseline === null || r.baseline === undefined || r.baseline <= 0) return;
            if (r.predDir === 'FLAT' || r.predDir == null) return;
            var pos = r.predDir === 'UP' ? 1 : -1;
            rets.push(pos * ((r.actual - r.baseline) / r.baseline) - fee);
            times.push(r.time);
        });
        var nT = rets.length;
        if (nT === 0) return empty;
        var mean = rets.reduce(function (s, v) { return s + v; }, 0) / nT;
        var variance = rets.reduce(function (s, v) { return s + (v - mean) * (v - mean); }, 0) / nT;
        var sd = Math.sqrt(variance);
        var periodsPerYear = (365 * 24 * 3600) / barSec;
        var gains = 0, losses = 0, wins = 0;
        rets.forEach(function (v) { if (v > 0) { gains += v; wins++; } else losses += -v; });
        var equity = 1, peak = 1, maxDd = 0;
        var curve = [{ time: times[0], equity: 1 }];
        for (var i = 0; i < nT; i++) {
            equity *= (1 + rets[i]);
            if (equity > peak) peak = equity;
            var dd = peak > 0 ? (peak - equity) / peak : 0;
            if (dd > maxDd) maxDd = dd;
            curve.push({ time: times[i], equity: equity });
        }
        return {
            sharpe: sd > 0 ? mean / sd * Math.sqrt(periodsPerYear) : null,
            profitFactor: losses > 0 ? gains / losses : (gains > 0 ? Infinity : null),
            maxDrawdown: maxDd * 100,
            cumReturn: (equity - 1) * 100,
            equityCurve: curve,
            trades: nT,
            winRate: wins / nT * 100
        };
    }

    return {
        toMs: toMs,
        filterSanePoints: filterSanePoints,
        insertGapBreaks: insertGapBreaks,
        computeModelErrors: computeModelErrors,
        computeModelStats: computeModelStats,
        splitAtGaps: splitAtGaps,
        findOutages: findOutages,
        formatOutage: formatOutage,
        recentFocusRange: recentFocusRange,
        buildPredictionLog: buildPredictionLog,
        regressionMetrics: regressionMetrics,
        classificationMetrics: classificationMetrics,
        pesaranTimmermann: pesaranTimmermann,
        normalCdf: normalCdf,
        rollingMetrics: rollingMetrics,
        regimeBreakdown: regimeBreakdown,
        tradingSim: tradingSim
    };
}));
