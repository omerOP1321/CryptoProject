/*
 * Page controller for analytics.html — the all-models comparison view.
 * Depends on window.ChartUtils (metrics) and window.AnalyticsUI (rendering).
 * Kept as an external script (not inline) so it runs in every host environment.
 */
(function () {
    'use strict';
    const SUPABASE_URL = 'https://iphxmjltsigsaocicipu.supabase.co';
    const SUPABASE_PUBLISHABLE_KEY = 'sb_publishable_4clMLjZVc1oacTPOb5XrUA_w9T5aevj';
    const AUI = window.AnalyticsUI;
    const CU = window.ChartUtils;
    const MODELS = AUI.MODELS;
    const supabase = window.sb || window.supabase.createClient(SUPABASE_URL, SUPABASE_PUBLISHABLE_KEY);

    let activeId = 1, activeSym = 'BTC';
    let payload = null;
    let metrics = [];           // per-model computed metrics for the active coin
    let sortKey = 'da', sortDir = -1;

    const COLS = [
        { key: 'model', label: 'Model', type: 'model' },
        { key: 'n',     label: 'Matured', higher: true,  fmt: v => v },
        { key: 'da',    label: 'Dir. acc', higher: true, fmt: v => AUI.fmtPct(v, 1), heat: true },
        { key: 'p',     label: 'PT p-value', higher: false, fmt: v => v == null ? '—' : v.toFixed(3), heat: true },
        { key: 'mae',   label: 'MAE', higher: false, fmt: v => AUI.fmtPrice(v), heat: true },
        { key: 'rmse',  label: 'RMSE', higher: false, fmt: v => AUI.fmtPrice(v), heat: true },
        { key: 'mase',  label: 'MASE', higher: false, fmt: v => AUI.fmt(v, 2), heat: true },
        { key: 'f1',    label: 'F1', higher: true, fmt: v => AUI.fmt(v, 3), heat: true },
        { key: 'sharpe',label: 'Sharpe', higher: true, fmt: v => AUI.fmt(v, 2), heat: true },
        { key: 'cum',   label: 'Cum. %', higher: true, fmt: v => AUI.signed(v, 2) + '%', heat: true }
    ];

    function computeAll(p) {
        const out = [];
        MODELS.order.forEach(m => {
            if (!(p.predictions && p.predictions[m])) return;
            const log = AUI.fullLog(p, m);
            if (!log.length) return;
            const reg = CU.regressionMetrics(log);
            const cls = CU.classificationMetrics(log);
            const pt = CU.pesaranTimmermann(log);
            const sim = CU.tradingSim(log, { barSec: MODELS.isV2(m) ? 3600 : 300 });
            out.push({
                model: m, log: log,
                n: log.length,
                da: cls.accuracy != null ? cls.accuracy * 100 : null,
                p: pt.pValue, mae: reg.mae, rmse: reg.rmse, mase: reg.mase,
                f1: cls.f1, sharpe: sim.sharpe, cum: sim.cumReturn,
                roll: CU.rollingMetrics(log, 12), equity: sim.equityCurve
            });
        });
        return out;
    }

    function heat(value, key, higher) {
        const vals = metrics.map(r => r[key]).filter(v => v != null && isFinite(v));
        if (value == null || !isFinite(value) || vals.length < 2) return '';
        const min = Math.min.apply(null, vals), max = Math.max.apply(null, vals);
        if (min === max) return '';
        let t = (value - min) / (max - min);
        if (!higher) t = 1 - t;                  // 1 = good
        const r = Math.round(255 + (99 - 255) * t);
        const g = Math.round(84 + (255 - 84) * t);
        const b = Math.round(112 + (47 - 112) * t);
        return 'background: rgba(' + r + ',' + g + ',' + b + ',0.16)';
    }

    function rowCells(r) {
        return COLS.map(c => {
            if (c.type === 'model') {
                return '<td><span class="cmp-model"><span class="dot" style="background:' + MODELS.colors[r.model] + '"></span>' + AUI.esc(MODELS.labelOf(r.model)) + '</span></td>';
            }
            const style = c.heat ? heat(r[c.key], c.key, c.higher) : '';
            return '<td style="' + style + '">' + c.fmt(r[c.key]) + '</td>';
        }).join('');
    }

    function renderTable() {
        const rows = metrics.slice().sort((a, b) => {
            if (sortKey === 'model') return MODELS.labelOf(a.model).localeCompare(MODELS.labelOf(b.model)) * sortDir;
            const av = a[sortKey], bv = b[sortKey];
            if (av == null) return 1; if (bv == null) return -1;
            return (av - bv) * sortDir;
        });
        const table = document.getElementById('cmp-table');
        // Persistent thead + tbody so rows can FLIP-reorder on sort / data change.
        let thead = table.querySelector('thead'), tbody = table.querySelector('tbody');
        if (!thead) { thead = document.createElement('thead'); table.appendChild(thead); }
        if (!tbody) {
            tbody = document.createElement('tbody'); table.appendChild(tbody);
            // one delegated click handler; rows are reused across renders
            tbody.addEventListener('click', (e) => {
                const tr = e.target.closest('tr[data-key]');
                if (tr) AUI.openModelModal(tr.dataset.key, payload);
            });
        }
        thead.innerHTML = '<tr>' + COLS.map(c => {
            const arrow = c.key === sortKey ? (sortDir < 0 ? ' ▼' : ' ▲') : '';
            return '<th data-key="' + c.key + '">' + c.label + '<span class="arrow">' + arrow + '</span></th>';
        }).join('') + '</tr>';
        thead.querySelectorAll('th').forEach(th => th.onclick = () => {
            const k = th.dataset.key;
            if (k === sortKey) { sortDir = -sortDir; }
            else {
                sortKey = k;
                // first click puts the BEST value on top: ascending when lower is
                // better (MAE/RMSE/MASE/p-value), descending otherwise.
                const col = COLS.find(c => c.key === k);
                sortDir = (k === 'model') ? 1 : (col && col.higher === false ? 1 : -1);
            }
            renderTable();
        });
        AUI.renderRankedList(tbody, rows.map(r => ({ key: r.model, html: rowCells(r) })), { tag: 'tr' });
    }

    function legendChips(elId) {
        document.getElementById(elId).innerHTML = metrics.map(r =>
            '<span><i style="background:' + MODELS.colors[r.model] + '"></i>' + AUI.esc(MODELS.labelOf(r.model)) + '</span>').join('');
    }

    function renderRolling() {
        const series = metrics.map(r => ({ name: MODELS.labelOf(r.model), color: MODELS.colors[r.model],
            data: r.roll.map(b => b.dirAcc) }));
        const xLabels = []; for (let i = 0; i < 12; i++) xLabels.push(i === 11 ? 'now' : '');
        document.getElementById('chart-rolling').innerHTML = AUI.svgLineMulti(series, {
            w: 900, h: 280, xLabels: xLabels, baseline: { value: 50, label: '50% chance' },
            yMin: 0, yMax: 100, fmtY: v => AUI.fmt(v, 0), ySuffix: '%'
        });
        legendChips('legend-rolling');
        AUI.attachTooltips(document.getElementById('chart-rolling'));
    }

    function renderEquity() {
        const series = metrics.map(r => ({ name: MODELS.labelOf(r.model), color: MODELS.colors[r.model],
            data: r.equity.map(p => p.equity) }));
        document.getElementById('chart-equity').innerHTML = AUI.svgLineMulti(series, {
            w: 900, h: 280, baseline: { value: 1, label: 'break-even' },
            fmtY: v => v.toFixed(2) + '×'
        });
        legendChips('legend-equity');
        AUI.attachTooltips(document.getElementById('chart-equity'));
    }

    function renderFocus(model) {
        const r = metrics.find(x => x.model === model) || metrics[0];
        if (!r) return;
        const color = MODELS.colors[r.model];
        const scatterPts = r.log.map(d => ({ x: d.actual, y: d.predicted, correct: d.correct,
            tip: AUI.fmtDateTime(d.time) + '<br>err ' + AUI.fmt(d.errPct, 3) + '%' }));
        const resid = r.log.map(d => d.predicted - d.actual);
        const sc = document.getElementById('focus-scatter');
        const rs = document.getElementById('focus-resid');
        sc.innerHTML = AUI.svgScatter(scatterPts, { color: color, w: 460, h: 320 });
        rs.innerHTML = AUI.svgHistogram(resid, { color: color, baseline: 0, w: 460, h: 320 });
        AUI.attachTooltips(sc); AUI.attachTooltips(rs);
    }

    function renderAll() {
        metrics = computeAll(payload);
        document.getElementById('loading').style.display = 'none';
        document.getElementById('content').style.display = 'block';
        if (!metrics.length) {
            document.getElementById('content').innerHTML =
                '<div class="chart-empty" style="height:200px">No matured predictions yet for ' + activeSym + '.</div>';
            return;
        }
        renderTable();
        renderRolling();
        renderEquity();
        const sel = document.getElementById('focus-select');
        sel.innerHTML = metrics.map(r => '<option value="' + r.model + '">' + AUI.esc(MODELS.labelOf(r.model)) + '</option>').join('');
        sel.onchange = () => renderFocus(sel.value);
        renderFocus(metrics[0].model);
    }

    async function fetchPayload() {
        try {
            const { data, error } = await supabase.from('predictions').select('payload').eq('id', activeId).single();
            if (error) {
                document.getElementById('loading').innerText = '⏳ Waiting for predictions for ' + activeSym + '…';
                return;
            }
            payload = data.payload;
            renderAll();
        } catch (e) {
            console.error(e);
            document.getElementById('loading').innerText = '❌ Connection error.';
        }
    }

    function switchCoin(btn) {
        document.querySelectorAll('.coin-tab').forEach(t => t.classList.remove('active'));
        btn.classList.add('active');
        activeId = Number(btn.dataset.id); activeSym = btn.dataset.sym;
        document.getElementById('coin-note').textContent = btn.dataset.name + ' · all models · click a row for full detail';
        document.getElementById('loading').style.display = 'block';
        document.getElementById('loading').innerText = 'Loading ' + activeSym + '…';
        document.getElementById('content').style.display = 'none';
        history.replaceState(null, '', '?coin=' + activeSym);
        fetchPayload();
    }
    document.querySelectorAll('.coin-tab').forEach(t => t.onclick = () => switchCoin(t));

    // Honor ?coin= on load
    const wanted = new URLSearchParams(location.search).get('coin');
    if (wanted) {
        const t = [].slice.call(document.querySelectorAll('.coin-tab')).find(x => x.dataset.sym === wanted.toUpperCase());
        if (t) { document.querySelectorAll('.coin-tab').forEach(x => x.classList.remove('active')); t.classList.add('active'); activeId = Number(t.dataset.id); activeSym = t.dataset.sym; }
    }
    fetchPayload();
}());
