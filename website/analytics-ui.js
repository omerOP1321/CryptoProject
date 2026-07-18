/*
 * Shared browser-side rendering for the analytics features (model modal +
 * analytics.html). Depends on window.ChartUtils (pure metrics). Exposes
 * window.AnalyticsUI. No framework, hand-rolled SVG to match the dark theme
 * and keep the payload small.
 */
(function (root) {
    'use strict';
    var CU = root.ChartUtils;

    // ----- Single source of truth for model identity (colors/labels/tags) -----
    var MODELS = {
        order: ['LSTM', 'Transformer', 'ARIMA', 'LSTM_v2', 'Transformer_v2', 'ARIMA_v2'],
        colors: {
            'LSTM': '#3b9eff', 'Transformer': '#e25bd0', 'ARIMA': '#22d3ee',
            'LSTM_v2': '#f5a524', 'Transformer_v2': '#818cf8', 'ARIMA_v2': '#34d399'
        },
        labels: {
            'LSTM': 'LSTM (5M)', 'Transformer': 'TFT (5M)', 'ARIMA': 'ARIMA',
            'LSTM_v2': 'LSTM (1H)', 'Transformer_v2': 'TFT (1H)', 'ARIMA_v2': 'ARIMA (1H)'
        },
        tags: {
            'LSTM': 'Legacy', 'Transformer': 'Legacy', 'ARIMA': 'Base',
            'LSTM_v2': 'V2', 'Transformer_v2': 'V2', 'ARIMA_v2': 'Base'
        },
        isV2: function (m) { return m.endsWith('_v2'); },
        labelOf: function (m) { return MODELS.labels[m] || m; }
    };

    var UP = '#63ff2f', DOWN = '#ff5470', MUTED = '#5b6675', GRID = '#16202b';

    // ------------------------------------------------------ formatting
    var TZ = -new Date().getTimezoneOffset() * 60;
    var MON = ['Jan','Feb','Mar','Apr','May','Jun','Jul','Aug','Sep','Oct','Nov','Dec'];
    function fmtPrice(p) {
        if (p == null || !isFinite(p)) return '—';
        return '$' + Number(p).toLocaleString(undefined,
            { minimumFractionDigits: p < 10 ? 4 : 2, maximumFractionDigits: p < 10 ? 4 : 2 });
    }
    function fmt(v, d) { return (v == null || !isFinite(v)) ? '—' : Number(v).toFixed(d == null ? 2 : d); }
    function fmtPct(v, d) { return (v == null || !isFinite(v)) ? '—' : Number(v).toFixed(d == null ? 1 : d) + '%'; }
    function signed(v, d) { if (v == null || !isFinite(v)) return '—'; return (v >= 0 ? '+' : '') + Number(v).toFixed(d == null ? 2 : d); }
    function fmtDateTime(sec) {
        var dt = new Date((sec + TZ) * 1000);
        return MON[dt.getUTCMonth()] + ' ' + dt.getUTCDate() + ', ' +
            String(dt.getUTCHours()).padStart(2, '0') + ':' + String(dt.getUTCMinutes()).padStart(2, '0');
    }
    function esc(s) { return String(s).replace(/[&<>"]/g, function (c) { return ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c]; }); }

    function dirBadge(dir) {
        if (dir == null) return '<span class="dir-badge dir-flat">—</span>';
        var cls = dir === 'UP' ? 'dir-up' : (dir === 'DOWN' ? 'dir-down' : 'dir-flat');
        var arrow = dir === 'UP' ? '▲' : (dir === 'DOWN' ? '▼' : '■');
        return '<span class="dir-badge ' + cls + '">' + arrow + ' ' + dir + '</span>';
    }
    function resultBadge(correct) {
        if (correct === null || correct === undefined) return '<span class="res-badge res-na">— n/a</span>';
        return correct
            ? '<span class="res-badge res-ok">✓ correct</span>'
            : '<span class="res-badge res-bad">✗ wrong</span>';
    }

    // ------------------------------------------------------ tooltip
    var _tip = null;
    function ensureTip() {
        if (_tip) return _tip;
        _tip = document.createElement('div');
        _tip.className = 'analytics-tip';
        document.body.appendChild(_tip);
        return _tip;
    }
    function attachTooltips(rootEl) {
        var tip = ensureTip();
        rootEl.addEventListener('mousemove', function (e) {
            var el = e.target.closest ? e.target.closest('[data-tip]') : null;
            if (!el) { tip.classList.remove('show'); return; }
            tip.innerHTML = el.getAttribute('data-tip');
            tip.classList.add('show');
            var pad = 14, x = e.clientX + pad, y = e.clientY + pad;
            var r = tip.getBoundingClientRect();
            if (x + r.width > window.innerWidth) x = e.clientX - r.width - pad;
            if (y + r.height > window.innerHeight) y = e.clientY - r.height - pad;
            tip.style.left = x + 'px'; tip.style.top = y + 'px';
        });
        rootEl.addEventListener('mouseleave', function () { tip.classList.remove('show'); });
    }

    // ------------------------------------------------------ FLIP reordering
    // Smooth reordering by reusing the project's slide easing. Measure positions
    // before a DOM mutation, then animate each surviving child from its old box to
    // its new one (translate + scale). New children fade/scale in. Honors
    // prefers-reduced-motion. This is the single animation primitive reused by the
    // model cards, the statistics bars, and the analytics comparison table.
    var FLIP_EASING = 'cubic-bezier(.22,1,.36,1)';
    function prefersReducedMotion() {
        return window.matchMedia && window.matchMedia('(prefers-reduced-motion: reduce)').matches;
    }
    function flipMove(container, mutate, opts) {
        opts = opts || {};
        var dur = opts.duration || 460, easing = opts.easing || FLIP_EASING;
        var prev = new Map();
        Array.prototype.forEach.call(container.children, function (c) { prev.set(c, c.getBoundingClientRect()); });
        mutate();
        if (prefersReducedMotion() || typeof container.children[0] === 'undefined') return;
        Array.prototype.forEach.call(container.children, function (c) {
            var f = prev.get(c), l = c.getBoundingClientRect();
            if (!f) {
                if (c.animate) c.animate([{ opacity: 0, transform: 'scale(.94)' }, { opacity: 1, transform: 'none' }], { duration: dur, easing: easing });
                return;
            }
            var dx = f.left - l.left, dy = f.top - l.top;
            var sx = l.width ? f.width / l.width : 1, sy = l.height ? f.height / l.height : 1;
            if (Math.abs(dx) < 0.5 && Math.abs(dy) < 0.5 && Math.abs(sx - 1) < 0.01 && Math.abs(sy - 1) < 0.01) return;
            if (!c.animate) return;
            c.animate([
                { transformOrigin: 'top left', transform: 'translate(' + dx + 'px,' + dy + 'px) scale(' + sx + ',' + sy + ')' },
                { transformOrigin: 'top left', transform: 'none' }
            ], { duration: dur, easing: easing });
        });
    }

    // Reconcile a keyed list to `items` (already in the desired order) and animate
    // the reordering. Each item: { key, html, className }. Container children carry
    // data-key so the same DOM node persists across renders (required for FLIP and
    // to avoid destroying focus/scroll). Returns nothing; mutates the container.
    function renderRankedList(container, items, opts) {
        opts = opts || {};
        var tag = opts.tag || 'div';
        var existing = {};
        Array.prototype.forEach.call(container.children, function (c) { existing[c.dataset.key] = c; });
        var desired = {};
        items.forEach(function (it) { desired[it.key] = true; });
        flipMove(container, function () {
            Object.keys(existing).forEach(function (k) { if (!desired[k]) existing[k].remove(); });
            items.forEach(function (it) {
                var node = existing[it.key];
                if (!node) { node = document.createElement(tag); node.dataset.key = it.key; }
                if (it.className != null && node.className !== it.className) node.className = it.className;
                if (it.html != null) node.innerHTML = it.html;
                container.appendChild(node); // appending in order performs the reorder
            });
        }, opts);
    }

    // ------------------------------------------------------ svg helpers
    function downsample(arr, max) {
        if (arr.length <= max) return arr;
        var step = arr.length / max, out = [];
        for (var i = 0; i < max; i++) out.push(arr[Math.floor(i * step)]);
        return out;
    }
    function emptyChart(w, h, msg) {
        return '<div class="chart-empty" style="height:' + h + 'px">' + esc(msg || 'No data') + '</div>';
    }

    // Predicted-vs-actual scatter with a y=x reference line.
    function svgScatter(points, opts) {
        opts = opts || {};
        var w = opts.w || 440, h = opts.h || 320, pad = 46;
        if (!points || !points.length) return emptyChart(w, h, 'No matured predictions yet');
        var draw = downsample(points, opts.max || 800);
        var all = [];
        points.forEach(function (p) { all.push(p.x, p.y); });
        var lo = Math.min.apply(null, all), hi = Math.max.apply(null, all);
        var span = (hi - lo) || 1; lo -= span * 0.05; hi += span * 0.05; span = hi - lo;
        var X = function (v) { return pad + ((v - lo) / span) * (w - pad - 14); };
        var Y = function (v) { return h - pad - ((v - lo) / span) * (h - pad - 14); };
        var s = '<svg viewBox="0 0 ' + w + ' ' + h + '" class="a-svg">';
        // grid + ticks (3)
        for (var t = 0; t < 3; t++) {
            var val = lo + span * (t / 2);
            var gy = Y(val), gx = X(val);
            s += '<line x1="' + pad + '" y1="' + gy.toFixed(1) + '" x2="' + (w - 14) + '" y2="' + gy.toFixed(1) + '" stroke="' + GRID + '"/>';
            s += '<text x="' + (pad - 6) + '" y="' + (gy + 3).toFixed(1) + '" text-anchor="end" fill="' + MUTED + '" font-size="9">' + fmtCompact(val) + '</text>';
            s += '<text x="' + gx.toFixed(1) + '" y="' + (h - pad + 14) + '" text-anchor="middle" fill="' + MUTED + '" font-size="9">' + fmtCompact(val) + '</text>';
        }
        // y = x reference
        s += '<line x1="' + X(lo).toFixed(1) + '" y1="' + Y(lo).toFixed(1) + '" x2="' + X(hi).toFixed(1) + '" y2="' + Y(hi).toFixed(1) + '" stroke="rgba(255,255,255,.35)" stroke-dasharray="4 3"/>';
        // axis labels
        s += '<text x="' + (w / 2) + '" y="' + (h - 4) + '" text-anchor="middle" fill="' + MUTED + '" font-size="10">Actual price</text>';
        s += '<text transform="translate(12,' + (h / 2) + ') rotate(-90)" text-anchor="middle" fill="' + MUTED + '" font-size="10">Predicted price</text>';
        draw.forEach(function (p) {
            var c = p.correct === true ? UP : (p.correct === false ? DOWN : (opts.color || '#3b9eff'));
            var tip = 'Pred ' + fmtPrice(p.y) + '<br>Actual ' + fmtPrice(p.x) + (p.tip ? '<br>' + p.tip : '');
            s += '<circle cx="' + X(p.x).toFixed(1) + '" cy="' + Y(p.y).toFixed(1) + '" r="2.6" fill="' + c + '" fill-opacity="0.72" data-tip="' + esc(tip) + '"/>';
        });
        s += '</svg>';
        return s;
    }

    function fmtCompact(v) {
        var a = Math.abs(v);
        if (a >= 1000) return (v / 1000).toFixed(a >= 100000 ? 0 : 1) + 'k';
        return v.toFixed(a < 10 ? 2 : 0);
    }

    // Histogram of values; opts.baseline draws a vertical marker (e.g. 0 for residuals).
    function svgHistogram(values, opts) {
        opts = opts || {};
        var w = opts.w || 440, h = opts.h || 260, padL = 30, padB = 26, padT = 12;
        var vals = (values || []).filter(function (v) { return v != null && isFinite(v); });
        if (!vals.length) return emptyChart(w, h, 'No data');
        var nb = opts.bins || 21;
        var lo = Math.min.apply(null, vals), hi = Math.max.apply(null, vals);
        if (lo === hi) { lo -= 1; hi += 1; }
        var bw = (hi - lo) / nb;
        var counts = new Array(nb).fill(0);
        vals.forEach(function (v) { var i = Math.min(nb - 1, Math.floor((v - lo) / bw)); counts[i]++; });
        var maxC = Math.max.apply(null, counts) || 1;
        var X = function (v) { return padL + ((v - lo) / (hi - lo)) * (w - padL - 10); };
        var plotH = h - padB - padT;
        var s = '<svg viewBox="0 0 ' + w + ' ' + h + '" class="a-svg">';
        for (var g = 0; g <= 2; g++) {
            var gy = padT + plotH * (g / 2);
            s += '<line x1="' + padL + '" y1="' + gy + '" x2="' + (w - 10) + '" y2="' + gy + '" stroke="' + GRID + '"/>';
            s += '<text x="' + (padL - 5) + '" y="' + (gy + 3) + '" text-anchor="end" fill="' + MUTED + '" font-size="9">' + Math.round(maxC * (1 - g / 2)) + '</text>';
        }
        var col = opts.color || '#3b9eff';
        for (var i = 0; i < nb; i++) {
            if (!counts[i]) continue;
            var x0 = X(lo + i * bw), x1 = X(lo + (i + 1) * bw);
            var bh = counts[i] / maxC * plotH;
            var tip = 'Range ' + fmt(lo + i * bw, 2) + ' … ' + fmt(lo + (i + 1) * bw, 2) + '<br>' + counts[i] + ' predictions';
            s += '<rect x="' + (x0 + 0.5).toFixed(1) + '" y="' + (padT + plotH - bh).toFixed(1) + '" width="' + Math.max(1, x1 - x0 - 1).toFixed(1) + '" height="' + bh.toFixed(1) + '" fill="' + col + '" fill-opacity="0.7" data-tip="' + esc(tip) + '"/>';
        }
        if (opts.baseline != null && opts.baseline >= lo && opts.baseline <= hi) {
            var bx = X(opts.baseline);
            s += '<line x1="' + bx.toFixed(1) + '" y1="' + padT + '" x2="' + bx.toFixed(1) + '" y2="' + (padT + plotH) + '" stroke="rgba(255,255,255,.5)" stroke-dasharray="4 3"/>';
        }
        // x ticks (lo, mid, hi)
        [lo, (lo + hi) / 2, hi].forEach(function (v) {
            s += '<text x="' + X(v).toFixed(1) + '" y="' + (h - 8) + '" text-anchor="middle" fill="' + MUTED + '" font-size="9">' + fmt(v, 2) + '</text>';
        });
        s += '</svg>';
        return s;
    }

    // 2x2 confusion heatmap. cm: { tp, fp, fn, tn }. Rows = predicted, cols = actual.
    function svgConfusion(cm) {
        var w = 300, h = 240, ox = 92, oy = 40, cw = 92, ch = 72;
        var max = Math.max(cm.tp, cm.fp, cm.fn, cm.tn, 1);
        function cell(r, c, val, label, kind) {
            var x = ox + c * cw, y = oy + r * ch;
            var good = kind === 'tp' || kind === 'tn';
            var base = good ? '99,255,47' : '255,84,112';
            var op = 0.08 + 0.55 * (val / max);
            var tip = label + '<br>' + val + ' predictions';
            return '<rect x="' + x + '" y="' + y + '" width="' + (cw - 4) + '" height="' + (ch - 4) + '" rx="6" fill="rgba(' + base + ',' + op.toFixed(3) + ')" stroke="rgba(255,255,255,.1)" data-tip="' + esc(tip) + '"/>' +
                '<text x="' + (x + cw / 2 - 2) + '" y="' + (y + ch / 2 - 4) + '" text-anchor="middle" fill="#e6edf3" font-size="20" font-weight="600">' + val + '</text>' +
                '<text x="' + (x + cw / 2 - 2) + '" y="' + (y + ch / 2 + 14) + '" text-anchor="middle" fill="' + MUTED + '" font-size="9">' + kind.toUpperCase() + '</text>';
        }
        var s = '<svg viewBox="0 0 ' + w + ' ' + h + '" class="a-svg">';
        s += '<text x="' + (ox + cw / 2 - 2) + '" y="' + (oy - 18) + '" text-anchor="middle" fill="' + MUTED + '" font-size="10">Actual UP</text>';
        s += '<text x="' + (ox + cw + cw / 2 - 2) + '" y="' + (oy - 18) + '" text-anchor="middle" fill="' + MUTED + '" font-size="10">Actual DOWN</text>';
        s += '<text transform="translate(' + (ox - 16) + ',' + (oy + ch / 2) + ') rotate(-90)" text-anchor="middle" fill="' + MUTED + '" font-size="10">Pred UP</text>';
        s += '<text transform="translate(' + (ox - 16) + ',' + (oy + ch + ch / 2) + ') rotate(-90)" text-anchor="middle" fill="' + MUTED + '" font-size="10">Pred DOWN</text>';
        s += cell(0, 0, cm.tp, 'Predicted UP, actual UP', 'tp');
        s += cell(0, 1, cm.fp, 'Predicted UP, actual DOWN', 'fp');
        s += cell(1, 0, cm.fn, 'Predicted DOWN, actual UP', 'fn');
        s += cell(1, 1, cm.tn, 'Predicted DOWN, actual DOWN', 'tn');
        s += '</svg>';
        return s;
    }

    // Multi-series line chart. series: [{ name, color, data:[y|null,...] }].
    // opts: { w,h, xLabels, baseline:{value,label}, yMin,yMax, fmtY, ySuffix }
    function svgLineMulti(series, opts) {
        opts = opts || {};
        var w = opts.w || 460, h = opts.h || 240, padL = 38, padR = 14, padT = 14, padB = 26;
        var all = [];
        series.forEach(function (s) { s.data.forEach(function (v) { if (v != null && isFinite(v)) all.push(v); }); });
        if (opts.baseline) all.push(opts.baseline.value);
        if (!all.length) return emptyChart(w, h, 'Not enough data');
        var lo = opts.yMin != null ? opts.yMin : Math.min.apply(null, all);
        var hi = opts.yMax != null ? opts.yMax : Math.max.apply(null, all);
        if (hi - lo < 1e-9) { hi = lo + 1; }
        // Only pad the auto-scaled bounds; honor explicit yMin/yMax exactly.
        var padv = (hi - lo) * 0.08;
        if (opts.yMin == null) lo -= padv;
        if (opts.yMax == null) hi += padv;
        var maxN = 0; series.forEach(function (s) { if (s.data.length > maxN) maxN = s.data.length; });
        // Each series is scaled across the full width by ITS OWN length, so curves
        // of different lengths (e.g. equity curves) overlay on a common 0..1 x-axis.
        var X = function (i, len) { return padL + (len <= 1 ? 0 : (i / (len - 1)) * (w - padL - padR)); };
        var Y = function (v) { return padT + (1 - (v - lo) / (hi - lo)) * (h - padT - padB); };
        var fy = opts.fmtY || function (v) { return fmt(v, 0); };
        var s = '<svg viewBox="0 0 ' + w + ' ' + h + '" class="a-svg">';
        [0, 0.5, 1].forEach(function (f) {
            var val = lo + (hi - lo) * f, gy = Y(val);
            s += '<line x1="' + padL + '" y1="' + gy.toFixed(1) + '" x2="' + (w - padR) + '" y2="' + gy.toFixed(1) + '" stroke="' + GRID + '"/>';
            s += '<text x="' + (padL - 5) + '" y="' + (gy + 3).toFixed(1) + '" text-anchor="end" fill="' + MUTED + '" font-size="9">' + fy(val) + (opts.ySuffix || '') + '</text>';
        });
        if (opts.baseline) {
            var by = Y(opts.baseline.value);
            s += '<line x1="' + padL + '" y1="' + by.toFixed(1) + '" x2="' + (w - padR) + '" y2="' + by.toFixed(1) + '" stroke="rgba(255,255,255,.4)" stroke-dasharray="4 3"/>';
            s += '<text x="' + (w - padR) + '" y="' + (by - 4).toFixed(1) + '" text-anchor="end" fill="rgba(255,255,255,.5)" font-size="9">' + esc(opts.baseline.label || '') + '</text>';
        }
        if (opts.xLabels) {
            opts.xLabels.forEach(function (lbl, i) {
                if (lbl == null) return;
                s += '<text x="' + X(i, opts.xLabels.length).toFixed(1) + '" y="' + (h - 8) + '" text-anchor="middle" fill="' + MUTED + '" font-size="9">' + esc(lbl) + '</text>';
            });
        }
        // Draw markers only when the series is short enough to stay readable.
        series.forEach(function (ser) {
            var len = ser.data.length, dots = len <= 40;
            var d = '', started = false;
            ser.data.forEach(function (v, i) {
                if (v == null || !isFinite(v)) { started = false; return; }
                d += (started ? 'L' : 'M') + X(i, len).toFixed(1) + ' ' + Y(v).toFixed(1) + ' ';
                started = true;
            });
            s += '<path d="' + d + '" fill="none" stroke="' + ser.color + '" stroke-width="2" stroke-linejoin="round" stroke-linecap="round"/>';
            if (dots) ser.data.forEach(function (v, i) {
                if (v == null || !isFinite(v)) return;
                var tip = (ser.name ? ser.name + '<br>' : '') + fy(v) + (opts.ySuffix || '');
                s += '<circle cx="' + X(i, len).toFixed(1) + '" cy="' + Y(v).toFixed(1) + '" r="2.6" fill="' + ser.color + '" data-tip="' + esc(tip) + '"/>';
            });
        });
        s += '</svg>';
        return s;
    }

    // Horizontal labelled bars. items: [{ label, value, color, max, suffix, tip }].
    function svgBarsH(items, opts) {
        opts = opts || {};
        if (!items || !items.length) return emptyChart(opts.w || 440, 120, 'No data');
        var rows = items.map(function (it) {
            var max = it.max || 100;
            var pct = it.value == null ? 0 : Math.max(0, Math.min(100, it.value / max * 100));
            var val = it.value == null ? '—' : fmt(it.value, opts.dp == null ? 1 : opts.dp) + (it.suffix || '');
            return '<div class="hbar-row" ' + (it.tip ? 'data-tip="' + esc(it.tip) + '"' : '') + '>' +
                '<span class="hbar-label">' + esc(it.label) + '</span>' +
                '<span class="hbar-track"><span class="hbar-fill" style="width:' + pct.toFixed(1) + '%;background:' + (it.color || '#3b9eff') + '"></span></span>' +
                '<span class="hbar-val">' + val + '</span></div>';
        }).join('');
        return '<div class="hbars">' + rows + '</div>';
    }

    function metricTile(label, value, sub, accent) {
        return '<div class="m-tile">' +
            '<div class="m-label">' + esc(label) + '</div>' +
            '<div class="m-value' + (accent ? ' accent' : '') + '">' + value + '</div>' +
            (sub ? '<div class="m-sub">' + sub + '</div>' : '') + '</div>';
    }

    // ------------------------------------------------------ data helpers
    function predHistFor(payload, modelName) {
        return MODELS.isV2(modelName)
            ? (payload.prediction_history_v2 || [])
            : (payload.prediction_history || []);
    }
    function fullLog(payload, modelName) {
        var hist5m = (payload.history && payload.history['5m']) || [];
        return CU.buildPredictionLog(predHistFor(payload, modelName), hist5m, modelName);
    }

    // ------------------------------------------------------ per-model analytics HTML
    function renderModelAnalytics(modelName, payload) {
        var hist5m = (payload.history && payload.history['5m']) || [];
        var color = MODELS.colors[modelName] || '#3b9eff';
        var log = fullLog(payload, modelName);
        if (!log.length) return '<div class="chart-empty" style="height:200px">No matured predictions yet for ' + esc(MODELS.labelOf(modelName)) + '.</div>';

        var reg = CU.regressionMetrics(log);
        var cls = CU.classificationMetrics(log);
        var pt = CU.pesaranTimmermann(log);
        var roll = CU.rollingMetrics(log, 12);
        var regime = CU.regimeBreakdown(log, hist5m);
        var sim = CU.tradingSim(log, { barSec: MODELS.isV2(modelName) ? 3600 : 300 });

        // significance badge
        var ptBadge;
        if (pt.pValue == null) ptBadge = '<span class="sig-badge sig-na">n/a</span>';
        else if (pt.significant) ptBadge = '<span class="sig-badge sig-yes">significant · p=' + pt.pValue.toFixed(3) + '</span>';
        else ptBadge = '<span class="sig-badge sig-no">not significant · p=' + pt.pValue.toFixed(2) + '</span>';

        // tiles
        var da = cls.accuracy != null ? cls.accuracy * 100 : null;
        var tiles = '<div class="m-tiles">' +
            metricTile('Directional accuracy', fmtPct(da, 1), 'vs 50% coin-flip', true) +
            metricTile('PT significance', ptBadge, 'better than chance?') +
            metricTile('MAE', fmtPrice(reg.mae), 'avg abs error') +
            metricTile('RMSE', fmtPrice(reg.rmse)) +
            metricTile('MAPE', fmtPct(reg.mape, 3)) +
            metricTile('R²', fmt(reg.r2, 3)) +
            metricTile('MASE', fmt(reg.mase, 2), reg.mase != null && reg.mase >= 1 ? 'no better than naive' : 'beats naive') +
            metricTile('Bias', signed(reg.bias, 2), 'predicted − actual') +
            '</div>';

        // classification block
        var clsTiles = '<div class="m-tiles four">' +
            metricTile('Precision', fmtPct(cls.precision != null ? cls.precision * 100 : null, 1)) +
            metricTile('Recall', fmtPct(cls.recall != null ? cls.recall * 100 : null, 1)) +
            metricTile('F1 score', fmt(cls.f1, 3)) +
            metricTile('Win rate', fmtPct(cls.winRate != null ? cls.winRate * 100 : null, 1)) +
            '</div>';

        // scatter
        var scatterPts = log.map(function (r) {
            return { x: r.actual, y: r.predicted, correct: r.correct,
                     tip: fmtDateTime(r.time) + '<br>err ' + fmt(r.errPct, 3) + '%' };
        });

        // residuals (predicted - actual)
        var residuals = log.map(function (r) { return r.predicted - r.actual; });

        // rolling DA + MAE
        var rollLabels = roll.map(function (_, i) { return i === roll.length - 1 ? 'now' : ''; });
        var rollDA = { name: 'Directional accuracy', color: color, data: roll.map(function (b) { return b.dirAcc; }) };

        // regime bars
        var trendBars = ['UP', 'DOWN', 'SIDEWAYS'].map(function (k) {
            var g = regime.trend[k];
            return { label: 'Trend ' + k, value: g.dirAcc, color: color, suffix: '%', max: 100,
                     tip: g.n + ' predictions · MAE ' + fmtPrice(g.mae) };
        });
        var volBars = ['LOW', 'MED', 'HIGH'].map(function (k) {
            var g = regime.volatility[k];
            return { label: 'Vol ' + k, value: g.dirAcc, color: color, suffix: '%', max: 100,
                     tip: g.n + ' predictions · MAE ' + fmtPrice(g.mae) };
        });

        // trading sim
        var pf = sim.profitFactor;
        var simTiles = '<div class="m-tiles four">' +
            metricTile('Cumulative return', signed(sim.cumReturn, 2) + '%', sim.trades + ' trades', true) +
            metricTile('Sharpe (annualized)', fmt(sim.sharpe, 2)) +
            metricTile('Profit factor', pf == null ? '—' : (pf === Infinity ? '∞' : fmt(pf, 2))) +
            metricTile('Max drawdown', fmtPct(sim.maxDrawdown, 1)) +
            '</div>';
        var equitySeries = [{ name: 'Equity', color: color, data: sim.equityCurve.map(function (p) { return p.equity; }) }];

        return '' +
            tiles +
            section('Directional skill significance (Pesaran–Timmermann)',
                'Tests whether the up/down hit-rate beats a coin flip. ' + pt.n + ' directional calls.', clsTiles) +
            '<div class="a-grid2">' +
                card('Predicted vs actual', svgScatter(scatterPts, { color: color })) +
                card('Confusion matrix', svgConfusion(cls)) +
            '</div>' +
            '<div class="a-grid2">' +
                card('Residual distribution (pred − actual)', svgHistogram(residuals, { color: color, baseline: 0 })) +
                card('Rolling directional accuracy', svgLineMulti([rollDA], { xLabels: rollLabels, baseline: { value: 50, label: '50% chance' }, yMin: 0, yMax: 100, fmtY: function (v) { return fmt(v, 0); }, ySuffix: '%' })) +
            '</div>' +
            '<div class="a-grid2">' +
                card('Accuracy by trend regime', svgBarsH(trendBars)) +
                card('Accuracy by volatility regime', svgBarsH(volBars)) +
            '</div>' +
            section('Trading-strategy evaluation',
                'Long when the model predicts up, short when down; honest results for a near-coin-flip model are typically marginal.', simTiles) +
            card('Strategy equity curve (compounded)', svgLineMulti(equitySeries, { baseline: { value: 1, label: 'break-even' }, fmtY: function (v) { return v.toFixed(2) + '×'; } }));

        function section(title, sub, body) {
            return '<div class="a-section"><h4>' + esc(title) + '</h4><p class="a-sub">' + esc(sub) + '</p>' + body + '</div>';
        }
        function card(title, body) {
            return '<div class="a-card"><div class="a-card-title">' + esc(title) + '</div>' + body + '</div>';
        }
    }

    // ------------------------------------------------------ prediction log (virtualized)
    // Row height must match the CSS (.log-row); mobile stacks the cells taller.
    function rowHeight() { return window.innerWidth <= 640 ? 92 : 60; }
    function logRowHtml(r) {
        var errPct = r.errPct == null ? '—' : fmt(r.errPct, 3) + '%';
        return '<div class="log-cell c-time">' + fmtDateTime(r.time) + '</div>' +
            '<div class="log-cell c-num">' + fmtPrice(r.predicted) + '</div>' +
            '<div class="log-cell c-num">' + fmtPrice(r.actual) + '</div>' +
            '<div class="log-cell c-num">' + fmtPrice(r.errAbs) + '<span class="sub">' + errPct + '</span></div>' +
            '<div class="log-cell c-dir">' + dirBadge(r.predDir) + '</div>' +
            '<div class="log-cell c-dir">' + dirBadge(r.actDir) + '</div>' +
            '<div class="log-cell c-res">' + resultBadge(r.correct) + '</div>';
    }
    function mountVirtualList(scrollEl, rows) {
        scrollEl.innerHTML = '<div class="vlist-spacer"></div>';
        var spacer = scrollEl.firstChild;
        var data = rows, ticking = false, rh = rowHeight();
        function render() {
            ticking = false;
            rh = rowHeight();
            spacer.style.height = (data.length * rh) + 'px';
            var top = scrollEl.scrollTop, vh = scrollEl.clientHeight;
            var start = Math.max(0, Math.floor(top / rh) - 4);
            var end = Math.min(data.length, Math.ceil((top + vh) / rh) + 4);
            var html = '';
            for (var i = start; i < end; i++) {
                html += '<div class="log-row" style="top:' + (i * rh) + 'px">' + logRowHtml(data[i]) + '</div>';
            }
            spacer.innerHTML = html;
        }
        scrollEl.onscroll = function () { if (!ticking) { ticking = true; requestAnimationFrame(render); } };
        render();
        return { update: function (newRows) { data = newRows; scrollEl.scrollTop = 0; render(); }, render: render };
    }

    function applyFilterSort(log, f) {
        var out = log.filter(function (r) {
            if (f.result === 'correct' && r.correct !== true) return false;
            if (f.result === 'incorrect' && r.correct !== false) return false;
            if (f.dir !== 'all' && r.predDir !== f.dir) return false;
            if (f.fromSec != null && r.time < f.fromSec) return false;
            if (f.toSec != null && r.time > f.toSec) return false;
            return true;
        });
        if (f.sort === 'time_asc') out.sort(function (a, b) { return a.time - b.time; });
        else if (f.sort === 'err_desc') out.sort(function (a, b) { return b.errAbs - a.errAbs; });
        else if (f.sort === 'err_asc') out.sort(function (a, b) { return a.errAbs - b.errAbs; });
        else out.sort(function (a, b) { return b.time - a.time; }); // time_desc default
        return out;
    }

    // ------------------------------------------------------ model modal
    var modal = null;
    function buildModalShell() {
        if (modal) return modal;
        var backdrop = document.createElement('div');
        backdrop.className = 'mm-backdrop';
        var panel = document.createElement('div');
        panel.className = 'mm-panel';
        panel.innerHTML =
            '<div class="mm-head">' +
                '<div class="mm-title"><span class="mm-dot"></span><span class="mm-name"></span><span class="mm-tag"></span></div>' +
                '<button class="mm-close" aria-label="Close">✕</button>' +
            '</div>' +
            '<div class="mm-tabs">' +
                '<button class="mm-tab active" data-tab="log">Prediction Log</button>' +
                '<button class="mm-tab" data-tab="analytics">Analytics</button>' +
            '</div>' +
            '<div class="mm-body">' +
                '<div class="mm-pane mm-log active">' +
                    '<div class="log-toolbar">' +
                        '<label>Result <select class="lf-result"><option value="all">All</option><option value="correct">Correct</option><option value="incorrect">Incorrect</option></select></label>' +
                        '<label>Direction <select class="lf-dir"><option value="all">All</option><option value="UP">Up</option><option value="DOWN">Down</option><option value="FLAT">Flat</option></select></label>' +
                        '<label>Sort <select class="lf-sort"><option value="time_desc">Newest</option><option value="time_asc">Oldest</option><option value="err_desc">Largest error</option><option value="err_asc">Smallest error</option></select></label>' +
                        '<label>From <input type="datetime-local" class="lf-from"></label>' +
                        '<label>To <input type="datetime-local" class="lf-to"></label>' +
                        '<span class="log-count"></span>' +
                    '</div>' +
                    '<div class="log-head">' +
                        '<div class="c-time">Time</div><div class="c-num">Predicted</div><div class="c-num">Actual</div>' +
                        '<div class="c-num">Error</div><div class="c-dir">Pred dir</div><div class="c-dir">Actual dir</div><div class="c-res">Result</div>' +
                    '</div>' +
                    '<div class="log-scroll"></div>' +
                '</div>' +
                '<div class="mm-pane mm-analytics"></div>' +
            '</div>';
        backdrop.appendChild(panel);
        document.body.appendChild(backdrop);

        modal = { backdrop: backdrop, panel: panel,
            name: panel.querySelector('.mm-name'), dot: panel.querySelector('.mm-dot'),
            tag: panel.querySelector('.mm-tag'), scroll: panel.querySelector('.log-scroll'),
            analytics: panel.querySelector('.mm-analytics'), count: panel.querySelector('.log-count'),
            tabs: panel.querySelectorAll('.mm-tab'),
            logPane: panel.querySelector('.mm-log'), anaPane: panel.querySelector('.mm-analytics'),
            f: { result: panel.querySelector('.lf-result'), dir: panel.querySelector('.lf-dir'),
                 sort: panel.querySelector('.lf-sort'), from: panel.querySelector('.lf-from'), to: panel.querySelector('.lf-to') },
            vlist: null, state: null };

        panel.querySelector('.mm-close').onclick = closeModal;
        backdrop.addEventListener('click', function (e) { if (e.target === backdrop) closeModal(); });
        window.addEventListener('keydown', function (e) { if (e.key === 'Escape' && backdrop.classList.contains('open')) closeModal(); });

        modal.tabs.forEach(function (t) {
            t.onclick = function () {
                modal.tabs.forEach(function (x) { x.classList.remove('active'); });
                t.classList.add('active');
                var tab = t.dataset.tab;
                modal.logPane.classList.toggle('active', tab === 'log');
                modal.anaPane.classList.toggle('active', tab === 'analytics');
                if (tab === 'analytics' && !modal.anaPane.dataset.rendered) {
                    modal.anaPane.innerHTML = renderModelAnalytics(modal.state.modelName, modal.state.payload);
                    modal.anaPane.dataset.rendered = '1';
                    attachTooltips(modal.anaPane);
                }
            };
        });
        function reFilter() {
            var f = {
                result: modal.f.result.value, dir: modal.f.dir.value, sort: modal.f.sort.value,
                fromSec: modal.f.from.value ? Math.floor(new Date(modal.f.from.value).getTime() / 1000) : null,
                toSec: modal.f.to.value ? Math.floor(new Date(modal.f.to.value).getTime() / 1000) : null
            };
            var filtered = applyFilterSort(modal.state.log, f);
            modal.count.textContent = filtered.length + ' of ' + modal.state.log.length + ' predictions';
            modal.vlist.update(filtered);
        }
        Object.keys(modal.f).forEach(function (k) { modal.f[k].onchange = reFilter; });
        modal._reFilter = reFilter;
        attachTooltips(modal.anaPane);
        return modal;
    }

    function openModelModal(modelName, payload) {
        var m = buildModalShell();
        var log = fullLog(payload, modelName);
        m.state = { modelName: modelName, payload: payload, log: log };
        m.name.textContent = MODELS.labelOf(modelName);
        m.dot.style.background = MODELS.colors[modelName] || '#3b9eff';
        m.tag.textContent = MODELS.tags[modelName] || '';
        // reset to log tab
        m.tabs.forEach(function (x) { x.classList.toggle('active', x.dataset.tab === 'log'); });
        m.logPane.classList.add('active');
        m.anaPane.classList.remove('active');
        m.anaPane.innerHTML = '';
        delete m.anaPane.dataset.rendered;
        // reset filters
        m.f.result.value = 'all'; m.f.dir.value = 'all'; m.f.sort.value = 'time_desc';
        m.f.from.value = ''; m.f.to.value = '';
        m.count.textContent = log.length + ' of ' + log.length + ' predictions';
        m.vlist = mountVirtualList(m.scroll, log);
        m.backdrop.classList.add('open');
        document.body.style.overflow = 'hidden';
    }
    function closeModal() {
        if (!modal) return;
        modal.backdrop.classList.remove('open');
        document.body.style.overflow = '';
        if (_tip) _tip.classList.remove('show');
    }

    root.AnalyticsUI = {
        MODELS: MODELS,
        openModelModal: openModelModal,
        closeModal: closeModal,
        renderModelAnalytics: renderModelAnalytics,
        fullLog: fullLog,
        attachTooltips: attachTooltips,
        // animation / reordering
        flipMove: flipMove, renderRankedList: renderRankedList,
        // chart primitives (used by analytics.html)
        svgScatter: svgScatter, svgHistogram: svgHistogram, svgConfusion: svgConfusion,
        svgLineMulti: svgLineMulti, svgBarsH: svgBarsH, metricTile: metricTile,
        // formatting
        fmt: fmt, fmtPct: fmtPct, fmtPrice: fmtPrice, signed: signed, fmtDateTime: fmtDateTime, esc: esc
    };
}(window));
