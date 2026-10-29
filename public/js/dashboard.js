'use strict';

/**
 * Public main dashboard: summary cards + package table with search, filters
 * and sorting. Data only arrives from /api/public/* - approved fields only.
 */
(function () {
  const { esc, debounce, prettyIso, api } = window.BS;

  const els = {
    summary: ['total', 'awaitingConfirmation', 'inPackaging', 'awaitingDocDispatch', 'inDelivery', 'delivered', 'delayed'],
    body: document.getElementById('packagesBody'),
    empty: document.getElementById('empty-state'),
    error: document.getElementById('error-state'),
    errDetail: document.getElementById('error-detail'),
    meta: document.getElementById('table-meta'),
    note: document.getElementById('filter-note'),
    retry: document.getElementById('retry'),
    q: document.getElementById('f-q'),
    stage: document.getElementById('f-stage'),
    status: document.getElementById('f-status'),
    from: document.getElementById('f-from'),
    to: document.getElementById('f-to'),
    sort: document.getElementById('f-sort'),
    clear: document.getElementById('f-clear'),
  };

  const STAGE_KEY_ORDER = ['CONFIRMATION', 'PACKAGING', 'DOCUMENTATION_DISPATCH', 'DELIVERY'];

  function stageDots(stageKey) {
    const idx = STAGE_KEY_ORDER.indexOf(stageKey);
    if (stageKey === 'DELIVERED') return stageDotsAllDone();
    let html = '<span class="stage-dots" aria-hidden="true">';
    STAGE_KEY_ORDER.forEach((_, i) => {
      const cls = i < idx ? 'dot done' : i === idx ? 'dot current' : 'dot';
      html += '<span class="' + cls + '"></span>';
    });
    return html + '</span>';
  }

  function stageDotsAllDone() {
    return '<span class="stage-dots" aria-hidden="true">' +
      STAGE_KEY_ORDER.map(() => '<span class="dot done"></span>').join('') + '</span>';
  }

  function delayBadge(item) {
    if (item.delayKey === 'OVERDUE') {
      return `<span class="badge delayed">${esc(item.delayDetail)}</span>`;
    }
    if (item.delayKey === 'RECORDED') {
      return `<span class="badge delayed">Delayed</span><br><span class="cell-sub">${esc(item.delayDetail)}</span>`;
    }
    return '<span class="badge neutral">On schedule</span>';
  }

  function renderSummary(summary) {
    els.summary.forEach((key) => {
      const el = document.getElementById('stat-' + key);
      if (el) el.textContent = typeof summary[key] === 'number' ? summary[key] : '-';
    });
  }

  function rowHtml(item) {
    const customer = item.customerName
      ? esc(item.customerName)
      : '<span class="cell-sub">Not published</span>';
    return `<tr>
      <td class="nowrap cell-main">${esc(item.packageCode)}</td>
      <td>${esc(item.projectName)}</td>
      <td>${customer}</td>
      <td class="nowrap">${esc(item.stageLabel)}</td>
      <td>
        <div class="progress-track" role="progressbar" aria-valuenow="${item.progress}" aria-valuemin="0" aria-valuemax="100" aria-label="Progress">
          <div class="progress-fill" style="width:${item.progress}%"></div>
        </div>
        ${stageDots(item.stage)} <span class="cell-sub">${item.progress}%</span>
      </td>
      <td><span class="badge ${esc(item.badge)}">${esc(item.statusLabel)}</span></td>
      <td class="nowrap">${item.expectedDelivery ? esc(prettyIso(item.expectedDelivery)) : '<span class="cell-sub">-</span>'}</td>
      <td>${delayBadge(item)}</td>
    </tr>`;
  }

  function state(showEmpty, showErr) {
    els.empty.hidden = !showEmpty || showErr;
    els.error.hidden = !showErr;
    if (!showEmpty && !showErr) {
      els.body.querySelectorAll('.state-row').forEach((tr) => tr.remove());
    }
  }

  async function load() {
    showLoadingRow();
    const params = new URLSearchParams();
    if (els.q.value.trim()) params.set('q', els.q.value.trim());
    if (els.stage.value) params.set('stage', els.stage.value);
    if (els.status.value) params.set('status', els.status.value);
    if (els.from.value) params.set('from', els.from.value);
    if (els.to.value) params.set('to', els.to.value);
    const sortValue = els.sort.value;
    if (sortValue === 'delivery') { params.set('sort', 'delivery'); params.set('dir', 'asc'); }
    else if (sortValue === 'delivery-asc') { params.set('sort', 'delivery'); params.set('dir', 'desc'); }
    else if (sortValue === 'update-asc') { params.set('sort', 'updated'); params.set('dir', 'asc'); }

    try {
      const summary = await api('/api/public/summary');
      renderSummary(summary);
      if (summary.notice) {
        els.note.hidden = false;
        els.note.textContent = summary.notice;
      } else {
        els.note.hidden = true;
      }
      const data = await api('/api/public/packages?' + params.toString());
      const items = data.items || [];
      els.body.innerHTML = items.length
        ? items.map(rowHtml).join('')
        : '<tr class="state-row"><td colspan="8"></td></tr>';
      els.meta.textContent = `${items.length} package${items.length === 1 ? '' : 's'}`;
      state(items.length === 0, false);
    } catch (e) {
      els.body.innerHTML = '<tr class="state-row"><td colspan="8"><span class="muted">-</span></td></tr>';
      els.errDetail.textContent = e.message || 'Unknown error';
      state(true, true);
    }
  }

  function showLoadingRow() {
    els.body.innerHTML = '<tr class="state-row"><td colspan="8"><span class="muted">Loading packages…</span></td></tr>';
  }

  els.q.addEventListener('input', debounce(load, 320));
  [els.stage, els.status, els.from, els.to, els.sort].forEach((el) => el.addEventListener('change', load));
  els.clear.addEventListener('click', () => {
    els.q.value = ''; els.stage.value = ''; els.status.value = '';
    els.from.value = ''; els.to.value = '';
    els.sort.value = 'updated';
    load();
  });
  els.retry.addEventListener('click', load);

  load();
})();
