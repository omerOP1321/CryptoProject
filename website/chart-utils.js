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
        var lastN = opts.lastN === undefined ? 20 : opts.lastN;
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

    return {
        toMs: toMs,
        filterSanePoints: filterSanePoints,
        insertGapBreaks: insertGapBreaks,
        computeModelErrors: computeModelErrors,
        computeModelStats: computeModelStats,
        splitAtGaps: splitAtGaps,
        recentFocusRange: recentFocusRange
    };
}));
