'use strict';

/**
 * Workflow UI controller: /confirm /pack /doc /del pages + /admin employees.
 *
 * The SERVER enforces every rule; the UI simply mirrors the same state machine
 * for convenience (buttons are disabled where the server would answer 409).
 */
(function () {
  const { esc, prettyIso, api, toast, debounce } = window.BS;
  const PAGE = window.__PAGE__;

  // ---------------------------------------------------------------- sidebar
  const hamburger = document.getElementById('hamburger');
  const sidebar = document.getElementById('sidebar');
  const overlay = document.getElementById('sidebar-overlay');
  if (hamburger && sidebar) {
    hamburger.addEventListener('click', () => {
      const open = !sidebar.classList.contains('open');
      sidebar.classList.toggle('open', open);
      hamburger.setAttribute('aria-expanded', String(open));
      overlay.hidden = !open;
    });
    overlay.addEventListener('click', () => {
      sidebar.classList.remove('open');
      overlay.hidden = true;
      hamburger.setAttribute('aria-expanded', 'false');
    });
  }

  function openModal(id) { document.getElementById(id).hidden = false; }
  function closeModal(id) {
    document.getElementById(id).hidden = true;
    document.querySelectorAll('.modal-x').forEach((b) => b.removeEventListener('click', () => closeModal(id)));
  }
  document.addEventListener('click', (event) => {
    const closer = event.target.closest('[data-close]');
    if (closer) closeModal(closer.dataset.close);
  });
  document.addEventListener('keydown', (event) => {
    if (event.key === 'Escape') document.querySelectorAll('.modal-backdrop').forEach((m) => { m.hidden = true; });
  });

  // ------------------------------------------------------------ stage configs
  const ACTIVE = ['PENDING', 'IN_PROGRESS', 'ATTEMPTED', 'DELAYED'];

  const MODULES = {
    confirm: {
      apiBase: '/api/confirm',
      stage: 'CONFIRMATION',
      columns: [
        ['Package', 'stage'],
        ['Customer', 'customer'],
        ['Status', 'status'],
        ['Confirmation date', 'confirmDate'],
        ['Expected delivery', 'expected'],
        ['Planned completion', 'planned'],
        ['Delay', 'delay'],
        ['', 'actions'],
      ],
      detailKeys: ['orderReference', 'orderDetails', 'confirmDate', 'started', 'completed', 'missingInfo'],
      actions: [
        ['start', 'Start confirmation', 'primary'],
        ['complete', 'Mark confirmation completed', 'teal'],
        ['missing-info', 'Record missing information', 'outline'],
        ['delay', 'Record confirmation delay', 'danger'],
        ['record-issue', 'Record issue', 'outline'],
      ],
      fields: ['delayCategory', 'remarks'],
      can: (p, action) => {
        const st = p.confirmation.status;
        const atCurrentStage = p.currentStage === 'CONFIRMATION';
        switch (action) {
          case 'start': return atCurrentStage && st === 'PENDING';
          case 'complete': return atCurrentStage && (st === 'PENDING' || st === 'IN_PROGRESS');
          case 'missing-info':
          case 'record-issue': return atCurrentStage && ACTIVE.includes(st);
          case 'delay': return atCurrentStage && (st === 'PENDING' || st === 'IN_PROGRESS');
          case 'remarks': return atCurrentStage && ACTIVE.includes(st);
          default: return false;
        }
      },
    },
    pack: {
      apiBase: '/api/pack',
      stage: 'PACKAGING',
      columns: [
        ['Package', 'stage'],
        ['Status', 'status'],
        ['Packaging start', 'packStart'],
        ['Packaging completed', 'packDone'],
        ['Expected delivery', 'expected'],
        ['Planned completion', 'planned'],
        ['Delay', 'delay'],
        ['', 'actions'],
      ],
      detailKeys: ['orderReference', 'packStart', 'packDone', 'packDelay', 'confirmDone'],
      actions: [
        ['start', 'Start packaging', 'primary'],
        ['complete', 'Mark packaging completed', 'teal'],
        ['delay', 'Record packaging delay', 'danger'],
        ['record-issue', 'Record missing materials / issue', 'outline'],
      ],
      fields: ['delayCategory', 'remarks'],
      can: (p, action) => {
        const st = p.packaging.status;
        const ok = p.confirmation.status === 'COMPLETED';
        const atCurrentStage = p.currentStage === 'PACKAGING';
        switch (action) {
          case 'start': return atCurrentStage && ok && st === 'PENDING';
          case 'complete': return atCurrentStage && ok && (st === 'PENDING' || st === 'IN_PROGRESS');
          case 'delay': return atCurrentStage && (st === 'PENDING' || st === 'IN_PROGRESS');
          case 'record-issue': case 'remarks': return atCurrentStage && ACTIVE.includes(st);
          default: return false;
        }
      },
    },
    doc: {
      apiBase: '/api/doc',
      stage: 'DOCUMENTATION_DISPATCH',
      columns: [
        ['Package', 'stage'],
        ['Docs verification', 'verification'],
        ['Transporter / Tracking', 'transporter'],
        ['Dispatch date', 'dispatchDate'],
        ['Expected delivery', 'expected'],
        ['Status', 'status'],
        ['Planned completion', 'planned'],
        ['', 'actions'],
      ],
      detailKeys: ['orderReference', 'invoiceNumber', 'shippingDocRef', 'verification', 'transporter', 'trackingNumber', 'dispatchDate'],
      actions: [
        ['start-doc', 'Start documentation', 'primary'],
        ['save-doc', 'Save documentation', 'outline'],
        ['verify', 'Mark documents verified', 'teal'],
        ['record-missing-docs', 'Record missing documentation', 'outline'],
        ['save-dispatch', 'Save dispatch/handover info', 'outline'],
        ['complete', 'Mark dispatch completed', 'teal'],
        ['delay', 'Record dispatch delay', 'danger'],
        ['record-issue', 'Record issue', 'outline'],
      ],
      fields: ['invoiceNumber', 'shippingDocRef', 'transporter', 'trackingNumber', 'dispatchDate', 'delayCategory', 'remarks'],
      can: (p, action) => {
        const atCurrentStage = p.currentStage === 'DOCUMENTATION_DISPATCH';
        const d = p.dispatch, doc = p.documentation;
        const canSave = atCurrentStage && ACTIVE.includes(doc.status);
        switch (action) {
          case 'start-doc': return atCurrentStage && doc.status === 'PENDING';
          case 'save-doc': case 'save-dispatch': case 'record-missing-docs': case 'record-issue': case 'remarks':
            return canSave;
          case 'verify': return canSave && !!(doc.invoiceNumber || p.documentation.invoiceNumber) &&
            !!(doc.shippingDocRef || p.documentation.shippingDocRef);
          case 'complete': {
            return atCurrentStage && (doc.status === 'PENDING' || doc.status === 'IN_PROGRESS')
              && !!doc.invoiceNumber && !!doc.shippingDocRef
              && doc.verificationStatus === 'VERIFIED'
              && !!d.transporter && !!d.trackingNumber && !!(d.dispatchDate);
          }
          case 'delay': return canSave;
          default: return false;
        }
      },
    },
    del: {
      apiBase: '/api/del',
      stage: 'DELIVERY',
      columns: [
        ['Package', 'stage'],
        ['Delivery status', 'deliveryStatus'],
        ['Transporter / Tracking', 'transporter'],
        ['Attempts', 'attempts'],
        ['Expected delivery', 'expected'],
        ['Planned completion', 'planned'],
        ['Actual delivery', 'actual'],
        ['', 'actions'],
      ],
      detailKeys: ['orderReference', 'transporter', 'trackingNumber', 'dispatchDate', 'deliveryStart', 'attempts', 'deliveryDelay', 'deliveryIssues'],
      actions: [
        ['start', 'In transit - start delivery', 'primary'],
        ['attempt', 'Record delivery attempt', 'outline'],
        ['resume', 'Resume delivery', 'primary'],
        ['update-expected', 'Update expected delivery', 'outline'],
        ['complete', 'Mark as delivered', 'teal'],
        ['delay', 'Record delivery delay', 'danger'],
        ['record-issue', 'Record delivery issue', 'outline'],
      ],
      fields: ['expectedDelivery', 'delayCategory', 'remarks'],
      can: (p, action) => {
        const atCurrentStage = p.currentStage === 'DELIVERY';
        const st = p.delivery.status;
        const dispatchOk = p.dispatch.status === 'COMPLETED';
        switch (action) {
          case 'start': return atCurrentStage && dispatchOk && st === 'PENDING';
          case 'attempt': return atCurrentStage && dispatchOk && (st === 'IN_PROGRESS' || st === 'ATTEMPTED');
          case 'resume': return atCurrentStage && dispatchOk && (st === 'DELAYED' || st === 'ATTEMPTED');
          case 'update-expected': return atCurrentStage && dispatchOk && ACTIVE.includes(st);
          case 'complete': return atCurrentStage && dispatchOk && (st === 'PENDING' || st === 'IN_PROGRESS' || st === 'ATTEMPTED');
          case 'delay': return atCurrentStage && dispatchOk && (st === 'PENDING' || st === 'IN_PROGRESS' || st === 'ATTEMPTED');
          case 'record-issue': case 'remarks': return atCurrentStage && dispatchOk && ACTIVE.includes(st);
          default: return false;
        }
      },
    },
  };

  // Delay-reason taxonomy - codes MUST match server/lib/stages.js (reports
  // group by these codes). Shown in the delay select on every stage page.
  const DELAY_REASONS = {
    MISSING_INFORMATION: 'Missing information',
    MATERIAL_SHORTAGE: 'Material shortage',
    PACKAGING_ISSUE: 'Packaging issue',
    DOCUMENTATION_ERROR: 'Documentation error',
    TRANSPORTER_DELAY: 'Transporter delay',
    OTHER: 'Other',
  };

  const MODAL_FIELDS = {
    invoiceNumber: ['Invoice number', 'text'],
    shippingDocRef: ['Shipping document reference', 'text'],
    transporter: ['Transporter name', 'text'],
    trackingNumber: ['Tracking number', 'text'],
    dispatchDate: ['Dispatch/Handover date', 'date'],
    expectedDelivery: ['New expected delivery date', 'date'],
    delayCategory: ['Delay reason (needed when recording a delay)', 'select', Object.entries(DELAY_REASONS)],
    remarks: ['Remarks', 'textarea'],
    issueNote: ['Issue note', 'textarea'],
  };

  function badge(status, badgeKey, labelOverride) {
    const label = labelOverride || status;
    return `<span class="badge ${badgeKey}">${esc(label)}</span>`;
  }

  function delayCell(p) {
    if (p.delayKey === 'NONE') return '<span class="badge neutral">On schedule</span>';
    const text = p.delayKey === 'RECORDED' ? 'Delayed' : p.delayDetail;
    const sub = p.delayDetail && p.delayKey === 'RECORDED' ? esc(p.delayDetail) : '';
    return `<span class="badge delayed">${esc(text)}</span>${sub ? '<br><span class="cell-sub">' + sub + '</span>' : ''}`;
  }

  // ------------------------------------------------------------ render table
  let currentState = null;

  function cell(kind, p) {
    switch (kind) {
      case 'stage':
        return `<td><span class="cell-main">${esc(p.packageCode)}</span><br><span class="cell-sub">${esc(p.projectName)}</span></td>`;
      case 'customer': return `<td>${esc(p.customerName)}</td>`;
      case 'status': return `<td class="nowrap">${badge(p.status, p.badge, p.statusLabel)}</td>`;
      case 'expected': return `<td class="nowrap">${p.expectedDelivery ? esc(prettyIso(p.expectedDelivery)) : '-'}</td>`;
      case 'updatedAt': return `<td class="nowrap cell-sub">${esc(p.updatedAt)}</td>`;
      case 'delay': return `<td>${delayCell(p)}</td>`;
      case 'planned': {
        const d = p.stageDeadline || {};
        if (!d.planned) return `<td class="nowrap cell-sub">-</td>`;
        const late = d.overdueDays > 0;
        return `<td class="nowrap">${esc(prettyIso(d.planned))}${late
          ? ` <span class="badge delayed">${d.overdueDays}d late</span>` : ''}</td>`;
      }
      case 'confirmDate': return `<td class="nowrap">${p.confirmation.confirmDate ? esc(p.confirmation.confirmDate) : '-'}</td>`;
      case 'packStart': return `<td class="nowrap cell-sub">${esc(p.packaging.startedAt || '-')}</td>`;
      case 'packDone': return `<td class="nowrap cell-sub">${p.packaging.status === 'COMPLETED' ? esc(p.packaging.completedAt || '') : '-'}</td>`;
      case 'verification': {
        const v = p.documentation.verificationStatus;
        const map = { VERIFIED: ['completed', 'Verified'], MISSING: ['delayed', 'Missing documents'], PENDING: ['pending', 'Pending verification'] };
        return `<td class="nowrap">${badge(v, map[v][0], map[v][1])}</td>`;
      }
      case 'transporter': return `<td>${esc(p.dispatch.transporter || '-')}<br><span class="cell-sub">${esc(p.dispatch.trackingNumber || '')}</span></td>`;
      case 'dispatchDate': return `<td class="nowrap">${p.dispatch.dispatchDate ? esc(p.dispatch.dispatchDate) : '-'}</td>`;
      case 'deliveryStatus': return `<td class="nowrap">${badge(p.delivery.status || 'PENDING',
        p.delivery.badge || (p.delivery.status === 'COMPLETED' ? 'delivered' : 'pending'), p.delivery.statusLabel)}</td>`;
      case 'attempts': return `<td>${p.delivery.attempts}</td>`;
      case 'actual': return `<td class="nowrap cell-sub">${esc(p.delivery.actualDelivery || '-')}</td>`;
      case 'actions':
        return `<td><button class="btn btn-outline btn-sm" data-open="${esc(p.packageCode)}" type="button">Open</button></td>`;
      default: return `<td></td>`;
    }
  }

  function renderRows(items) {
    const mod = MODULES[PAGE];
    // Column headers: the empty <tr id="work-head"> in workflow.ejs was never
    // filled by any script, so the table rendered body rows with no titles.
    const head = document.getElementById('work-head');
    if (head) head.innerHTML = mod.columns.map(([label]) => `<th scope="col"${label === '' ? ' aria-label="Actions"' : ''}>${esc(label)}</th>`).join('');
    document.getElementById('work-body').innerHTML = items.length
      ? items.map((p) => `<tr>${mod.columns.map(([, kind]) => cell(kind, p)).join('')}</tr>`).join('')
      : '<tr class="state-row"><td colspan="8"></td></tr>';
    const count = document.getElementById('table-meta');
  }

  function states(showEmpty, errText) {
    document.getElementById('work-empty').hidden = !showEmpty;
    const err = document.getElementById('work-error');
    err.hidden = !errText;
    document.getElementById('work-error-detail').textContent = errText || '';
  }

  async function load() {
    showLoading();
    const view = document.querySelector('#view-tabs .tab.active');
    const params = new URLSearchParams();
    params.set('view', view ? view.dataset.view : '');
    const q = document.getElementById('work-q');
    if (q && q.value.trim()) params.set('q', q.value.trim());
    try {
      const data = await api(`${MODULES[PAGE].apiBase}/packages?` + params.toString());
      currentState = data.items || [];
      renderRows(currentState);
      if (data.notice) toast(data.notice, 'warn');
      states(currentState.length === 0, null);
    } catch (e) {
      currentState = [];
      document.getElementById('work-body').innerHTML = '<tr class="state-row"><td colspan="8"><span class="muted">-</span></td></tr>';
      states(false, e.message || 'Unknown error');
    }
  }

  function showLoading() {
    document.getElementById('work-body').innerHTML =
      '<tr class="state-row"><td colspan="8"><span class="muted">Loading…</span></td></tr>';
  }

  // ------------------------------------------------------------ detail modal
  function detailItem(k, v, full) {
    return `<div class="detail-item ${full ? 'full' : ''}"><span class="k">${esc(k)}</span><span class="v">${v || esc('') || '-'}</span></div>`;
  }

  function detailGrid(mod, p) {
    const g = (kv) => kv.map(([k, v, full]) => `<div class="detail-item ${full ? 'full' : ''}"><span class="k">${esc(k)}</span><span class="v">${v}</span></div>`).join('');
    let rows = '';
    const issuesOf = (list, emptyNote) => list && list.length
      ? `<ul class="issue-list">${list.map((i) => `<li>${esc(i.note)} — <em>${esc(i.by)}</em>, ${esc(i.at)}</li>`).join('')}</ul>`
      : `<span class="cell-sub">${esc(emptyNote || 'None')}</span>`;

    switch (PAGE) {
      case 'confirm':
        rows = g([
          ['Order reference', esc(p.orderReference || '-')],
          ['Confirmation date', esc(p.confirmation.confirmDate || '-')],
          ['Status', badge(p.confirmation.status, p.status === p.confirmation.status ? p.badge : 'pending', p.confirmation.statusLabel)],
          ['Stage history', esc(p.stageLabel)],
          ['Started', esc(p.confirmation.startedAt || '-')],
          ['Completed', esc(p.confirmation.completedAt || '-')],
          ['Missing information', esc(p.confirmation.missingInfo || '-')],
          ['Order details (internal)', esc(p.orderDetails || '-')],
          ['Remarks', esc(p.confirmation.remarks || '-')],
          ['Issues', issuesOf(p.confirmation.issues), true],
        ]);
        break;
      case 'pack':
        rows = g([
          ['Confirmation completed', esc(p.confirmation.completedAt || '-')],
          ['Packaging started', esc(p.packaging.startedAt || '-')],
          ['Packaging completed', esc(p.packaging.completedAt || '-')],
          ['Delayed reason', esc(p.packaging.delayReason || '-')],
          ['Order details (internal)', esc(p.orderDetails || '-')],
          ['Remarks', esc(p.packaging.remarks || '-')],
          ['Issues', issuesOf(p.packaging.issues), true],
        ]);
        break;
      case 'doc': {
        const v = p.documentation.verificationStatus;
        const map = { VERIFIED: ['completed', 'Verified'], MISSING: ['delayed', 'Missing documents'], PENDING: ['pending', 'Pending verification'] };
        rows = g([
          ['Invoice number', esc(p.documentation.invoiceNumber || '-')],
          ['Shipping document reference', esc(p.documentation.shippingDocRef || '-')],
          ['Document verification', badge(v, map[v][0], map[v][1])],
          ['Transporter', esc(p.dispatch.transporter || '-')],
          ['Tracking number', esc(p.dispatch.trackingNumber || '-')],
          ['Dispatch/Handover date', esc(p.dispatch.dispatchDate || '-')],
          ['Delay reason', esc(p.dispatch.delayReason || '-')],
          ['Remarks', esc(p.documentation.remarks || '-')],
          ['Issues', issuesOf(p.documentation.issues), true],
        ]);
        break;
      }
      case 'del':
        rows = g([
          ['Transporter', esc(p.dispatch.transporter || '-')],
          ['Tracking number', esc(p.dispatch.trackingNumber || '-')],
          ['Dispatch date', esc(p.dispatch.dispatchDate || '-')],
          ['Delivery started', esc(p.delivery.startedAt || '-')],
          ['Expected delivery', esc(p.delivery.expectedDelivery || p.expectedDelivery || '-')],
          ['Actual delivery', esc(p.delivery.actualDelivery || '-')],
          ['Attempts', String(p.delivery.attempts)],
          ['Delay reason', esc(p.delivery.delayReason || '-')],
          ['Remarks', esc(p.delivery.remarks || '-')],
          ['Issues', issuesOf(p.delivery.issues), true],
        ]);
        break;
    }
    return `<div class="detail-grid">${rows}</div>`;
  }

  function actionButtons(mod, p, fieldVals) {
    const collect = () => {
      const body = { remarks: (fieldVals.remarks || document.getElementById('m-remarks') || {}).value || undefined };
      for (const key of ['issueNote', ...mod.fields]) {
        const el = document.getElementById('m-' + key) || document.getElementById('m-' + key);
        if (!el) continue;
        body[key] = el.value;
      }
      if (body.issueNote === '') body.issueNote = undefined;
      if (body.remarks === '') body.remarks = undefined;
      return body;
    };
    const colNameOf = (name) => (MODAL_FIELDS[name] ? MODAL_FIELDS[name][0] : name);

    const buttons = mod.actions.map(([action, label, kind]) => {
      const enabled = mod.can(p, action);
      return `<button class="btn btn-${kind} btn-sm" ${enabled ? '' : 'disabled'} data-action="${action}"
        title="${enabled ? '' : 'Not available for this package state'}" type="button">${esc(label)}</button>`;
    }).join('');

    const wrapper = document.createElement('div');
    wrapper.innerHTML = `
      <div class="action-grid">${buttons}</div>
      <div class="modal-fields">${mod.fields.map((f) => {
        const meta = MODAL_FIELDS[f];
        const value = (fieldVals && fieldVals[f]) || (f === 'remarks' ? remarksOfCurrent(p) || '' : '') || prefilled(p, f) || '';
        return `<label class="field"><span class="label">${esc(colNameOf(f))}</span>${
          meta[1] === 'textarea'
            ? `<textarea class="input" id="m-${f}" rows="2">${esc(value)}</textarea>`
            : meta[1] === 'select'
              ? `<select class="input" id="m-${f}"><option value=""></option>${(meta[2] || [])
                .map(([v, l]) => `<option value="${esc(v)}"${v === value ? ' selected' : ''}>${esc(l)}</option>`).join('')}</select>`
              : `<input class="input" type="${meta[1]}" id="m-${f}" value="${esc(value)}">`
        }</label>`;
      }).join('')}</div>`;
    return wrapper;
  }

  function remarksOfCurrent(p) {
    const map = {
      confirm: p.confirmation.remarks,
      pack: p.packaging.remarks,
      doc: p.documentation.remarks,
      del: p.delivery.remarks,
    };
    return map[PAGE] || '';
  }

  function prefilled(p, f) {
    switch (f) {
      case 'invoiceNumber': return p.documentation.invoiceNumber || '';
      case 'shippingDocRef': return p.documentation.shippingDocRef || '';
      case 'transporter': return p.dispatch.transporter || '';
      case 'trackingNumber': return p.dispatch.trackingNumber || '';
      case 'dispatchDate': return p.dispatch.dispatchDate || '';
      case 'expectedDelivery': return p.expectedDelivery || '';
      default: return '';
    }
  }

  function actionLabel(action) {
    const found = [];
    for (const mod of Object.values(MODULES)) {
      const a = mod.actions.find((x) => x[0] === action);
      if (a) found.push(a[1]);
    }
    return found[0] ? found[0].replace(/"/g, '') : action;
  }

  function needsFields() { return null; }

  async function openPackage(code) {
    let data;
    try {
      data = await api(`${MODULES[PAGE].apiBase}/packages/${encodeURIComponent(code)}`);
    } catch (e) {
      toast(e.message, 'err');
      return;
    }
    const p = data.package;
    document.getElementById('pkg-title').textContent = p.packageCode + ' - ' + p.projectName;

    const historyHtml = (data.history || []).slice(0, 12).map((h) =>
      `<li><strong>${esc(h.stage)}</strong>: ${esc(h.previousStatus)} &rarr; ${esc(h.newStatus)}
        <span class="cell-sub">by ${esc(h.updatedBy)} — ${esc(h.timestamp)}</span>
        ${h.reason ? `<br><span class="cell-sub">Reason: ${esc(h.reason)}</span>` : ''}</li>`).join('') ||
      '<li><span class="cell-sub">No history entries yet.</span></li>';

    const body = document.getElementById('pkg-body');
    body.innerHTML =
      `<span class="badge ${esc(p.badge)}">${esc(p.statusLabel)}</span> ` +
      `<span class="cell-sub">at ${esc(p.stageLabel)} — updated ${esc(p.updatedAt)}</span>` +
      detailGrid(MODULES[PAGE], p) +
      '<h3>Stage action</h3>' +
      `<div id="action-zone"></div>` +
      `<div class="detail-item full"><span class="k">Recent history</span><ul class="issue-list">${historyHtml}</ul></div>`;

    const footer = document.getElementById('pkg-foot');
    footer.innerHTML = '<button class="btn btn-outline" data-close="pkg-modal" type="button">Close</button>';

    const zone = document.getElementById('action-zone');
    const wrapper = actionButtons(MODULES[PAGE], p);
    zone.appendChild(wrapper);

    zone.querySelectorAll('[data-action]').forEach((bp) => {
      bp.addEventListener('click', async () => {
        const action = bp.dataset.action;
        const payload = { action };
        zone.querySelectorAll('.modal-fields input, .modal-fields select, .modal-fields textarea')
          .forEach((el) => {
            const key = el.id.replace('m-', '');
            payload[key] = el.value === '' ? undefined : el.value;
          });
        // Client-side guard for the structured delay taxonomy: the server
        // enforces it too, but failing fast here saves a round-trip.
        if (action === 'delay' && !payload.delayCategory) {
          bp.disabled = false;
          toast('Select a delay reason first', 'err');
          return;
        }
        bp.disabled = true;
        try {
          const out = await api(`${MODULES[PAGE].apiBase}/packages/${encodeURIComponent(p.packageCode)}/actions`,
            { method: 'POST', body: payload });
          toast(out.message || 'Done', 'ok');
          closeModal('pkg-modal');
          load();
        } catch (e) {
          toast(e.message || 'Action failed', 'err');
          bp.disabled = false;
        }
      });
    });

    openModal('pkg-modal');
  }

  // Workflow-page controls (view tabs, search, table, create form). These run
  // ONLY on /confirm /pack /doc /del. On other pages that load this file
  // (e.g. /admin) the elements do not exist - touching them threw a TypeError
  // that killed the whole controller, which is why the admin summary and the
  // employees table never loaded on /admin.
  if (MODULES[PAGE]) {
  const viewTabs = document.getElementById('view-tabs');
  if (viewTabs) viewTabs.addEventListener('click', (event) => {
    const tab = event.target.closest('.tab');
    if (!tab) return;
    document.querySelectorAll('#view-tabs .tab').forEach((t) => {
      t.classList.toggle('active', t === tab);
      t.setAttribute('aria-selected', String(t === tab));
    });
    load();
  });

  const qEl = document.getElementById('work-q');
  if (qEl) qEl.addEventListener('input', debounce(load, 340));
  const refreshBtn = document.getElementById('work-refresh');
  if (refreshBtn) refreshBtn.addEventListener('click', load);

  document.getElementById('work-body').addEventListener('click', (event) => {
    const btn = event.target.closest('[data-open]');
    if (btn) openPackage(btn.dataset.open);
  });

  // ------------------------------------------------------------ create package (confirm page)
  const openCreate = document.getElementById('open-create');
  if (openCreate) {
    openCreate.addEventListener('click', () => openModal('create-modal'));
    document.getElementById('create-submit').addEventListener('click', async () => {
      const btnEl = document.getElementById('create-submit');
      const errs = document.querySelectorAll('#create-form .error-text[data-err]');
      errs.forEach((e) => { e.hidden = true; e.textContent = ''; });
      const globalErr = document.getElementById('create-error');
      globalErr.hidden = true;
      const payload = {
        packageCode: document.getElementById('c-code').value.trim(),
        projectName: document.getElementById('c-project').value.trim(),
        customerName: document.getElementById('c-customer').value.trim(),
        orderReference: document.getElementById('c-order-ref').value.trim(),
        confirmDate: document.getElementById('c-confirm-date').value,
        expectedDelivery: document.getElementById('c-expected').value,
        orderDetails: document.getElementById('c-order-details').value,
        remarks: document.getElementById('c-remarks').value,
        publicCustomer: document.getElementById('c-public').checked,
      };
      btnEl.disabled = true;
      try {
        const out = await api('/api/confirm/packages', { method: 'POST', body: payload });
        toast(out.message || 'Package created', 'ok');
        closeModal('create-modal');
        load();
      } catch (e) {
        const fe = e.fieldErrors || null;
        if (fe && typeof fe === 'object') {
          let matched = false;
          for (const [field, msg] of Object.entries(fe)) {
            const el = document.querySelector(`#create-form .error-text[data-err="${field}"]`);
            if (el) { el.hidden = false; el.textContent = msg; matched = true; }
          }
          if (!matched) { globalErr.hidden = false; globalErr.textContent = e.message; }
        } else {
          globalErr.hidden = false;
          globalErr.textContent = e.message;
        }
      } finally {
        btnEl.disabled = false;
      }
    });
  }

  }

  // ------------------------------------------------------------ ADMIN module
  if (PAGE === 'admin') {
    let employeesCache = [];

    async function loadSummary() {
      // Overview page only - skip silently on the employees page.
      if (!document.getElementById('a-total')) return;
      try {
        const s = await api('/admin/api/summary');
        [['a-total', s.totalPackages], ['a-active', s.active], ['a-delayed', s.delayed],
          ['a-delivered', s.delivered], ['a-employees', s.employees], ['a-attention', s.attention]]
          .forEach(([id, v]) => {
            const el = document.getElementById(id);
            if (el) el.textContent = v != null ? v : '-';
          });
      } catch (e) {
        toast(e.message, 'err');
      }
    }

    async function loadEmployees() {
      showEmpLoading();
      const params = new URLSearchParams();
      const q = document.getElementById('emp-q');
      if (q && q.value.trim()) params.set('q', q.value.trim());
      const role = document.getElementById('emp-role');
      if (role && role.value) params.set('role', role.value);
      const status = document.getElementById('emp-status');
      if (status && status.value) params.set('status', status.value);
      try {
        const listEl = document.getElementById('emp-body');
        const data = await api('/admin/api/employees?' + params.toString());
        employeesCache = data.items || [];
        const errEl = document.getElementById('emp-error');
        errEl.hidden = true;
        if (data.notice) toast(data.notice, 'warn');
        if (!employeesCache.length) {
          listEl.innerHTML = '<tr class="state-row"><td colspan="6"></td></tr>';
          document.getElementById('emp-empty').hidden = false;
          return;
        }
        document.getElementById('emp-empty').hidden = true;
        listEl.innerHTML = employeesCache.map((e2) => `<tr>
          <td class="cell-main">${esc(e2.name)}</td>
          <td>${esc(e2.email)}</td>
          <td>
            <label class="visually-hidden-role" for="role-${esc(e2.uid)}">Role</label>
            <select class="input input-sm role-select" id="role-${esc(e2.uid)}" data-uid="${esc(e2.uid)}">
              ${['ADMIN', 'CONFIRM', 'PACK', 'DOC', 'DEL'].map((r) =>
                `<option value="${r}" ${e2.role === r ? 'selected' : ''}>${r}</option>`).join('')}
            </select>
          </td>
          <td>${badge(e2.enabled ? 'enabled' : 'disabled', e2.enabled ? 'delivered' : 'delayed', e2.enabled ? 'Enabled' : 'Disabled')}</td>
          <td class="nowrap cell-sub">${esc(e2.createdAt)}</td>
          <td class="row-actions">
            <button class="btn btn-outline btn-sm" data-save-role="${esc(e2.uid)}" type="button">Save role</button>
            <button class="btn ${e2.enabled ? 'btn-danger' : 'btn-teal'} btn-sm" data-toggle-uid="${esc(e2.uid)}" data-enabled="${e2.enabled}" type="button">
              ${e2.enabled ? 'Disable' : 'Enable'}
            </button>
          </td>
        </tr>`).join('');
      } catch (e) {
        document.getElementById('emp-error').hidden = false;
        document.getElementById('emp-error-detail').textContent = e.message || 'Unknown error';
      }
    }

    function showEmpLoading() {
      const listEl = document.getElementById('emp-body');
      if (!listEl) return; // employees section not on this page
      listEl.innerHTML =
        '<tr class="state-row"><td colspan="6"><span class="muted">Loading employees…</span></td></tr>';
    }

    const empBody = document.getElementById('emp-body');
    if (empBody) empBody.addEventListener('click', async (event) => {
      const saveBtn = event.target.closest('[data-save-role]');
      const toggleBtn = event.target.closest('[data-toggle-uid]');
      if (!saveBtn && !toggleBtn) return;
      if (saveBtn) {
        const uid = saveBtn.dataset.saveRole;
        const select = document.getElementById('role-' + uid);
        const newRole = select ? select.value : null;
        if (newRole !== 'ADMIN' && confirm('Demote this administrator? Account stays enabled.')) {
          await updateEmployee(uid, { role: newRole });
        } else {
          await updateEmployee(uid, { role: newRole });
        }
      } else {
        const uid = toggleBtn.dataset.toggleUid;
        const enabling = toggleBtn.dataset.enabled !== 'true';
        if (!enabling && !confirm('Disable this account? The employee will be logged out on their next action.')) return;
        await updateEmployee(uid, { enabled: enabling });
      }
    });

    async function updateEmployee(uid, body) {
      try {
        const out = await api('/admin/api/employees/' + encodeURIComponent(uid), { method: 'POST', body });
        toast(out.message || 'Updated', 'ok');
        await Promise.all([loadEmployees(), loadSummary()]);
      } catch (e) {
        toast(e.message || 'Update failed', 'err');
      }
    }

    const empOpen = document.getElementById('open-create-emp');
    if (empOpen) {
      empOpen.addEventListener('click', () => openModal('emp-modal'));
      document.getElementById('emp-submit').addEventListener('click', async () => {
        const btnEl = document.getElementById('emp-submit');
        const gErr = document.getElementById('emp-form-error');
        gErr.hidden = true;
        const payload = {
          name: document.getElementById('e-name').value.trim(),
          email: document.getElementById('e-email').value.trim(),
          password: document.getElementById('e-pass').value,
          role: document.getElementById('e-role').value,
        };
        btnEl.disabled = true;
        try {
          const out = await api('/admin/api/employees', { method: 'POST', body: payload });
          toast(out.message || 'Employee created', 'ok');
          closeModal('emp-modal');
          ['e-name', 'e-email', 'e-pass'].forEach((id) => { document.getElementById(id).value = ''; });
          loadEmployees();
        } catch (e) {
          gErr.hidden = false;
          gErr.textContent = e.message;
        } finally {
          btnEl.disabled = false;
        }
      });
    }

    const empQ = document.getElementById('emp-q');
    if (empQ) empQ.addEventListener('input', debounce(loadEmployees, 340));
    const empRefresh = document.getElementById('emp-refresh');
    if (empRefresh) empRefresh.addEventListener('click', loadEmployees);

    loadSummary();
    // Employees init only on the /admin/employees page (section exists there).
    if (document.getElementById('emp-body')) loadEmployees();
    if (new URLSearchParams(window.location.search).get('denied') === '1') {
      const banner = document.getElementById('denied-banner');
      if (banner) banner.hidden = false;
    }
  } else {
    load();
  }
})();
