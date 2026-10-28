'use strict';

/**
 * Reports & bottleneck analytics (ADMIN).
 * Charts: average stage duration (bar), delays per stage (bar),
 * weekly/monthly trend created vs delivered (line). CSV exports per range.
 */
(function () {
  const { esc, api, toast } = window.BS;
  const COLORS = {
    blue: '#175CD3', teal: '#0E9384', amber: '#F79009', red: '#D92D20',
    gray: '#667085', grid: '#EAECF0', text: '#475467',
  };

  let range = 'this-week';
  let charts = { stages: null, delays: null, trend: null };
  let lastData = null;

  const rangeChips = Array.from(document.querySelectorAll('.range-chip'));
  const customDates = document.getElementById('custom-dates');
  const repLabel = document.getElementById('rep-label');
  const insufficient = document.getElementById('rep-insufficient');

  rangeChips.forEach((chip) => chip.addEventListener('click', () => {
    rangeChips.forEach((c) => {
      c.classList.toggle('active', c === chip);
      c.setAttribute('aria-pressed', String(c === chip));
    });
    range = chip.dataset.range;
    customDates.hidden = range !== 'custom';
    if (range !== 'custom') loadReport();
    else {
      repLabel.textContent = 'Select a start and end date, then reload or download CSV.';
      refreshBtnFocus();
    }
  }));

  function refreshBtnFocus() {
    const btn = document.getElementById('csv-custom');
    if (btn) btn.focus();
  }

  document.getElementById('rep-from').addEventListener('change', maybeLoadCustom);
  document.getElementById('rep-to').addEventListener('change', maybeLoadCustom);
  function maybeLoadCustom() {
    const from = document.getElementById('rep-from').value;
    const to = document.getElementById('rep-to').value;
    if (from && to) loadReport();
  }

  function exportParams(kindOverride) {
    const kind = kindOverride || range;
    const params = new URLSearchParams();
    params.set('range', kind);
    if (kind === 'custom') {
      params.set('from', document.getElementById('rep-from').value);
      params.set('to', document.getElementById('rep-to').value);
    }
    return params;
  }

  function downloadCsv(kindOverride, label) {
    const params = exportParams(kindOverride);
    if (kindOverride === 'custom' && (!params.get('from') || !params.get('to'))) {
      toast('Select both dates for the custom CSV range.', 'warn');
      return;
    }
    // navigate (GET) - the browser downloads text/csv; CSRF is GET-safe
    const btn = document.activeElement;
    window.location.href = '/api/reports/export?' + params.toString();
    setTimeout(() => { if (btn) btn.focus(); }, 0);
  }

  document.getElementById('csv-week').addEventListener('click', () => downloadCsv('this-week'));
  document.getElementById('csv-month').addEventListener('click', () => downloadCsv('this-month'));
  document.getElementById('csv-custom').addEventListener('click', () => downloadCsv('custom'));

  const fmtRow = (num) => (num == null ? '-' : num);
  const STAGE_KEY_ORDER = ['CONFIRMATION', 'PACKAGING', 'DOCUMENTATION_DISPATCH', 'DELIVERY'];

  function metric(id, value, suffix) {
    const el = document.getElementById(id);
    el.textContent = value == null ? '-' : value;
    if (suffix) el.textContent = String(el.textContent) + suffix;
  }

  function destroyCharts() {
    Object.values(charts).forEach((c) => { if (c) c.destroy(); });
  }

  function rowLine(text, count) {
    return `<li><span>${esc(text)}</span><strong>${count}</strong></li>`;
  }

  async function loadReport() {
    insufficient.hidden = true;
    try {
      lastData = await api('/api/reports/data?' + exportParams().toString());
      const d = lastData;
      repLabel.textContent = 'Period: ' + d.rangeLabel;
      metric('m-created', d.metrics.created);
      metric('m-delivered', d.metrics.delivered);
      metric('m-active', d.metrics.active);
      metric('m-delayed', d.metrics.delayed);
      metric('m-avg', d.metrics.avgCompletionDays == null ? null : d.metrics.avgCompletionDays);
      document.getElementById('m-slowest').textContent = d.metrics.slowestStage || '-';

      if (d.insufficient && d.insufficient.length) {
        insufficient.innerHTML = d.insufficient.map((t) => '<p>' + esc(t) + '</p>').join('');
        insufficient.hidden = false;
      }

      // Bottleneck table
      document.getElementById('stage-rows').innerHTML = d.stages.map((s) => {
        const lines = [];
        if (s.avgDays == null) lines.push('Not enough data yet');
        if (d.metrics.slowestStage === s.label) lines.push('Longest average duration');
        if (s.delayed > 0) lines.push(s.delayed + ' delayed');
        return `<tr>
          <td class="cell-main">${esc(s.label)}</td>
          <td>${fmtRow(s.avgDays)}</td>
          <td>${s.delayed}</td>
          <td>${s.awaiting}</td>
          <td class="cell-sub">${esc(lines.join(' - ') || 'OK')}</td>
        </tr>`;
      }).join('');

      // Reasons
      const reasons = d.topDelayReasons || [];
      document.getElementById('reason-list').innerHTML =
        reasons.length ? reasons.map((r) => rowLine(r.reason, r.count)).join('') : '';
      document.getElementById('no-reasons').hidden = reasons.length > 0;

      drawCharts(d);
    } catch (e) {
      toast(e.message || 'Could not load report', 'err');
      repLabel.textContent = '';
    }
  }

  function drawCharts(d) {
    destroyCharts();

    const barCommon = {
      responsive: true,
      maintainAspectRatio: false,
      scales: {
        x: { grid: { display: false }, ticks: { color: COLORS.text, font: { size: 11 } } },
        y: { beginAtZero: true, grid: { color: COLORS.grid }, ticks: { color: COLORS.text, precision: 0 } },
      },
      plugins: { legend: { display: false } },
    };

    const labels = STAGE_KEY_ORDER;
    const avgByStage = STAGE_KEY_ORDER.map((k) => {
      const row = d.stages.find((s) => s.stage === k);
      return row && row.avgDays != null ? row.avgDays : null;
    });
    charts.stages = new Chart(document.getElementById('chart-stage-durations'), {
      type: 'bar',
      data: {
        labels: labels.map((k) => (d.stages.find((s) => s.stage === k) || {}).label || k),
        datasets: [{
          label: 'Avg days',
          data: avgByStage,
          backgroundColor: avgByStage.map((v, i) =>
            v != null && d.metrics.slowestStage === (d.stages[i] || {}).label ? COLORS.amber : COLORS.blue),
          borderRadius: 6,
        }],
      },
      options: barCommon,
    });

    charts.delays = new Chart(document.getElementById('chart-delays'), {
      type: 'bar',
      data: {
        labels: labels.map((k) => (d.stages.find((s) => s.stage === k) || {}).label || k),
        datasets: [{
          label: 'Packages delayed',
          data: STAGE_KEY_ORDER.map((k) => (d.stages.find((s) => s.stage === k) || { delayed: 0 }).delayed),
          backgroundColor: COLORS.red,
          borderRadius: 6,
        }],
      },
      options: barCommon,
    });

    charts.trend = new Chart(document.getElementById('chart-trend'), {
      type: 'line',
      data: {
        labels: d.trend.labels,
        datasets: [
          {
            label: 'Created', data: d.trend.created,
            borderColor: COLORS.blue, backgroundColor: 'rgba(23,92,211,.12)',
            fill: true, tension: 0.3, pointRadius: 3,
          },
          {
            label: 'Delivered', data: d.trend.delivered,
            borderColor: COLORS.teal, backgroundColor: 'rgba(14,147,132,.12)',
            fill: true, tension: 0.3, pointRadius: 3,
          },
        ],
      },
      options: {
        responsive: true,
        maintainAspectRatio: false,
        scales: {
          x: { grid: { display: false }, ticks: { color: COLORS.text, font: { size: 11 }, maxRotation: 0, autoSkip: true } },
          y: { beginAtZero: true, grid: { color: COLORS.grid }, ticks: { color: COLORS.text, precision: 0 } },
        },
        plugins: { legend: { labels: { color: COLORS.text } } },
      },
    });
  }

  if (typeof Chart === 'undefined') {
    toast('Chart.js failed to load from the CDN - metrics tables still work.', 'warn');
  }
  loadReport();
})();
