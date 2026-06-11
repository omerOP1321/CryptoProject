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

    return {
        toMs: toMs,
        filterSanePoints: filterSanePoints,
        insertGapBreaks: insertGapBreaks,
        computeModelErrors: computeModelErrors
    };
}));
