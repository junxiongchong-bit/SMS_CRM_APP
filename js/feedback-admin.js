// ── FEEDBACK INBOX + SEND ─────────────────────────────────────────────────────

let _fbFilter      = 'all';
let _fbEligible    = [];        // all customers in the send list (date-filtered + manual)
let _fbSelected    = new Set(); // IDs of checked customers
let _fbManualAdded = [];        // IDs manually added (survives date filter changes)

// ── Navigation entry point ────────────────────────────────────────────────────

function renderFeedback() {
  renderFeedbackAuto();
  renderFeedbackSend();
  renderFeedbackStats();
  renderFeedbackTable();
}

// ── AUTO FEEDBACK CARD ────────────────────────────────────────────────────────

let _fbAutoQueue = [];

async function renderFeedbackAuto() {
  const card = document.getElementById('fb-auto-card');
  if (!card) return;

  const enabled    = db.settings?.feedbackAutoEnabled || false;
  const lastRun    = db.settings?.feedbackAutoLastRun;
  const lastStats  = db.settings?.feedbackAutoLastStats;
  const statusColor = enabled ? 'var(--accent2)' : 'var(--muted)';
  const lastRunStr  = lastRun
    ? `${fmtDate(lastRun)} — Sent: ${lastStats?.sent ?? 0}, Skipped: ${lastStats?.skipped ?? 0}`
    : 'Never run';

  let queueHtml = '<span class="muted" style="font-size:.78rem">Loading…</span>';
  card.innerHTML = buildFbAutoCardHtml(enabled, statusColor, lastRunStr, _fbAutoQueue, queueHtml);

  try {
    const r = await fetch('/api/feedback-auto-queue');
    const j = await r.json();
    _fbAutoQueue = j.queue || [];
  } catch(e) {
    _fbAutoQueue = [];
  }

  card.innerHTML = buildFbAutoCardHtml(enabled, statusColor, lastRunStr, _fbAutoQueue);
}

function buildFbAutoCardHtml(enabled, statusColor, lastRunStr, queue) {
  const queueRows = queue.length === 0
    ? '<div class="muted" style="font-size:.78rem;padding:8px 0">No customers with a visit yesterday.</div>'
    : queue.slice(0, 100).map(c => {
        const name = [c.firstName, c.lastName].filter(Boolean).join(' ') || '—';
        return `<div style="font-size:.78rem;padding:5px 0;border-bottom:1px solid var(--border);display:flex;gap:8px;align-items:center">
          <span style="font-weight:500">${escHtml(name)}</span>
          <span class="muted">${escHtml(c.phone)}</span>
          <span class="muted">last visit: ${fmtDate(c.lastVisit)}</span>
        </div>`;
      }).join('') + (queue.length > 100 ? `<div class="muted" style="padding:6px 0;font-size:.75rem">…and ${queue.length - 100} more</div>` : '');

  return `
    <div style="font-size:.8rem;font-weight:700;color:var(--accent);text-transform:uppercase;letter-spacing:.06em;margin-bottom:14px">Auto Feedback SMS</div>
    <div style="display:flex;gap:8px;align-items:center;margin-bottom:14px;flex-wrap:wrap">
      <span class="badge" style="background:${enabled ? 'rgba(78,205,164,.15)' : 'var(--surface2)'};color:${statusColor};border:1px solid ${statusColor}40">
        ${enabled ? '● Active' : '○ Disabled'}
      </span>
      <span class="badge ${queue.length ? 'bg' : 'bb'}">${queue.length} in queue</span>
      <span class="muted" style="font-size:.75rem">Last run: ${lastRunStr}</span>
    </div>
    <p class="muted" style="font-size:.82rem;margin:0 0 14px">
      When active, sends a personalised feedback SMS daily at <strong>5pm Perth</strong> to every customer whose last visit was the day before.
    </p>
    <div style="display:flex;align-items:center;justify-content:space-between;flex-wrap:wrap;gap:10px;margin-bottom:${queue.length ? '12px' : '0'}">
      <label style="display:flex;align-items:center;gap:8px;cursor:pointer;font-size:.85rem">
        <span class="toggle"><input type="checkbox" id="fb-auto-toggle" ${enabled ? 'checked' : ''} onchange="toggleFeedbackAuto(this.checked)"><span class="toggle-track"></span></span>
        Enable auto feedback SMS
      </label>
      ${queue.length ? `<button class="btn btn-ghost btn-sm" onclick="toggleFbAutoQueue()">▾ Show queue</button>` : ''}
    </div>
    <div id="fb-auto-queue" style="display:none;max-height:220px;overflow-y:auto;border:1px solid var(--border);border-radius:6px;padding:4px 10px">
      ${queueRows}
    </div>`;
}

function toggleFbAutoQueue() {
  const el = document.getElementById('fb-auto-queue');
  if (el) el.style.display = el.style.display === 'none' ? 'block' : 'none';
}

async function toggleFeedbackAuto(checked) {
  db.settings.feedbackAutoEnabled = checked;
  await fetch('/api/settings', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(db.settings) });
  renderFeedbackAuto();
  toast(`Auto feedback SMS ${checked ? 'enabled' : 'disabled'}.`);
}

// ── SEND SECTION ──────────────────────────────────────────────────────────────

const FB_DEFAULT_TEMPLATE = 'Hi {name}, how was your Woodpeckers Murdoch order? {link}\nReply STOP to opt out.';

function renderFeedbackSend() {
  const sinceEl = document.getElementById('fb-since-date');
  if (!sinceEl.value) {
    const d = new Date();
    d.setDate(d.getDate() - 1);
    sinceEl.value = d.toISOString().slice(0, 10);
  }
  document.getElementById('fb-msg-template').value = db.settings?.feedbackTemplate || FB_DEFAULT_TEMPLATE;
  refreshFbEligible();
}

function refreshFbEligible() {
  const since    = document.getElementById('fb-since-date').value;
  const testMode = document.getElementById('fb-test-mode').checked;
  const optOuts  = new Set(db.optOuts || []);

  if (testMode) {
    const testPhone = db.settings?.testPhone || '';
    const self = (db.customers || []).find(c => c.phone === testPhone);
    _fbEligible = self ? [self] : [];
    _fbSelected = new Set(_fbEligible.map(c => c.id));
    renderFbList(true);
    updateMsgPreview();
    return;
  }

  // Date-filtered customers
  const dateFiltered = (db.customers || []).filter(c => {
    if (!c.phone) return false;
    if (optOuts.has(c.phone)) return false;
    if (c.googleReviewDone) return false;
    if (since && c.lastVisit !== since) return false;
    return true;
  });

  // Append manually added customers not already in the date-filtered set
  const seen = new Set(dateFiltered.map(c => c.id));
  const manualCustomers = _fbManualAdded
    .map(id => (db.customers || []).find(c => c.id === id))
    .filter(c => c && !seen.has(c.id));

  const prevIds  = new Set(_fbEligible.map(c => c.id));
  _fbEligible    = [...dateFiltered, ...manualCustomers];

  // Auto-select new entries; preserve existing check state
  for (const c of _fbEligible) {
    if (!prevIds.has(c.id)) _fbSelected.add(c.id);
  }
  // Remove stale IDs no longer in the list
  for (const id of [..._fbSelected]) {
    if (!_fbEligible.find(c => c.id === id)) _fbSelected.delete(id);
  }

  renderFbList(false);
  updateMsgPreview();
}

function renderFbList(testMode) {
  const countEl = document.getElementById('fb-eligible-count');
  const labelEl = document.getElementById('fb-eligible-label');
  const listEl  = document.getElementById('fb-eligible-list');

  if (testMode) {
    const c = _fbEligible[0];
    countEl.textContent = _fbEligible.length;
    labelEl.textContent = ` customers eligible — 1 will be used for test`;
    if (c) {
      const name = `${c.firstName || ''} ${c.lastName || ''}`.trim() || '—';
      listEl.style.display = 'block';
      listEl.innerHTML = `<div style="padding:8px 10px;font-size:.82rem;color:var(--muted)">
        Test token for: <strong style="color:var(--text)">${escHtml(name)}</strong> (${c.phone}) — SMS goes to your test phone.
      </div>`;
    } else {
      listEl.style.display = 'none';
    }
    return;
  }

  const selCount = _fbEligible.filter(c => _fbSelected.has(c.id)).length;
  countEl.textContent = selCount;
  labelEl.textContent = selCount < _fbEligible.length
    ? ` selected of ${_fbEligible.length}`
    : ` customers`;

  if (!_fbEligible.length) {
    listEl.style.display = 'none';
    return;
  }

  const manualSet = new Set(_fbManualAdded);
  const allChecked = selCount === _fbEligible.length;
  const someChecked = selCount > 0 && !allChecked;

  listEl.style.display = 'block';
  listEl.innerHTML = `
    <div style="display:flex;justify-content:space-between;align-items:center;padding:5px 10px;border-bottom:1px solid var(--border);font-size:.78rem;color:var(--muted);background:var(--surface2)">
      <label style="cursor:pointer;display:flex;align-items:center;gap:6px;user-select:none">
        <input type="checkbox" id="fb-select-all" onchange="fbToggleAll(this.checked)" ${allChecked ? 'checked' : ''}>
        Select all
      </label>
      <span>${selCount} / ${_fbEligible.length} selected</span>
    </div>
    ${_fbEligible.map(c => {
      const name    = `${c.firstName || ''} ${c.lastName || ''}`.trim() || '—';
      const checked = _fbSelected.has(c.id) ? 'checked' : '';
      const badge   = manualSet.has(c.id)
        ? `<span style="font-size:.7rem;background:var(--accent);color:#fff;border-radius:3px;padding:1px 5px;margin-left:5px">+added</span>`
        : '';
      const removeBtn = manualSet.has(c.id)
        ? `<button onclick="fbRemoveManual('${c.id}')" title="Remove" style="background:none;border:none;cursor:pointer;color:var(--muted);font-size:.9rem;padding:0 2px;line-height:1">✕</button>`
        : '';
      return `<div style="display:flex;align-items:center;gap:8px;padding:5px 10px;font-size:.82rem;border-bottom:1px solid var(--border)">
        <input type="checkbox" ${checked} onchange="fbToggle('${c.id}',this.checked)" style="flex-shrink:0">
        <span style="flex:1;min-width:0">${escHtml(name)}${badge}</span>
        <span class="muted" style="white-space:nowrap">${c.phone}</span>
        ${removeBtn}
      </div>`;
    }).join('')}
  `;

  // Indeterminate state requires JS (can't do in HTML)
  const allCb = document.getElementById('fb-select-all');
  if (allCb) allCb.indeterminate = someChecked;
}

function fbToggle(id, checked) {
  if (checked) _fbSelected.add(id); else _fbSelected.delete(id);
  const selCount = _fbEligible.filter(c => _fbSelected.has(c.id)).length;
  document.getElementById('fb-eligible-count').textContent = selCount;
  document.getElementById('fb-eligible-label').textContent = selCount < _fbEligible.length
    ? ` selected of ${_fbEligible.length}`
    : ` customers`;
  // Update header row
  const allCb = document.getElementById('fb-select-all');
  if (allCb) {
    allCb.checked       = selCount === _fbEligible.length;
    allCb.indeterminate = selCount > 0 && selCount < _fbEligible.length;
  }
  const listEl = document.getElementById('fb-eligible-list');
  const hdrSpan = listEl?.querySelector('div:first-child span');
  if (hdrSpan) hdrSpan.textContent = `${selCount} / ${_fbEligible.length} selected`;
}

function fbToggleAll(checked) {
  for (const c of _fbEligible) {
    if (checked) _fbSelected.add(c.id); else _fbSelected.delete(c.id);
  }
  renderFbList(false);
}

function fbRemoveManual(id) {
  _fbManualAdded = _fbManualAdded.filter(x => x !== id);
  _fbSelected.delete(id);
  refreshFbEligible();
}

// ── Manual customer search ────────────────────────────────────────────────────

function fbSearchCustomers(query) {
  const resultsEl = document.getElementById('fb-search-results');
  if (!query || query.trim().length < 2) { resultsEl.style.display = 'none'; return; }

  const q       = query.toLowerCase().trim();
  const qDigits = q.replace(/\D/g, '');
  const optOuts = new Set(db.optOuts || []);
  const inList  = new Set(_fbEligible.map(c => c.id));

  const matches = (db.customers || []).filter(c => {
    if (!c.phone) return false;
    const name  = `${c.firstName || ''} ${c.lastName || ''}`.toLowerCase();
    const digits = (c.phone || '').replace(/\D/g, '');
    return name.includes(q) || (qDigits && digits.includes(qDigits));
  }).slice(0, 8);

  if (!matches.length) { resultsEl.style.display = 'none'; return; }

  resultsEl.style.display = 'block';
  resultsEl.innerHTML = matches.map(c => {
    const name     = `${c.firstName || ''} ${c.lastName || ''}`.trim() || '—';
    const alreadyIn = inList.has(c.id);
    const blocked   = optOuts.has(c.phone) || c.googleReviewDone;
    const note      = alreadyIn ? ' · already in list' : optOuts.has(c.phone) ? ' · opted out' : c.googleReviewDone ? ' · review done' : '';
    const disabled  = alreadyIn || blocked;
    return `<div
      onclick="${disabled ? '' : `fbAddManual('${c.id}')`}"
      style="display:flex;justify-content:space-between;align-items:center;padding:7px 10px;font-size:.82rem;cursor:${disabled ? 'default' : 'pointer'};border-bottom:1px solid var(--border);opacity:${disabled ? '.45' : '1'}"
      onmouseover="if(!${disabled})this.style.background='var(--surface2)'"
      onmouseout="this.style.background=''">
      <span>${escHtml(name)}<span class="muted" style="margin-left:4px">${note}</span></span>
      <span class="muted">${c.phone}</span>
    </div>`;
  }).join('');
}

function fbAddManual(id) {
  if (!_fbManualAdded.includes(id)) _fbManualAdded.push(id);
  document.getElementById('fb-manual-search').value = '';
  document.getElementById('fb-search-results').style.display = 'none';
  refreshFbEligible();
}

// ── Template / preview ────────────────────────────────────────────────────────

let _fbTplSaveTimer = null;
function saveFbTemplate() {
  clearTimeout(_fbTplSaveTimer);
  _fbTplSaveTimer = setTimeout(async () => {
    db.settings.feedbackTemplate = document.getElementById('fb-msg-template').value;
    await fetch('/api/settings', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(db.settings) });
  }, 800);
}

function updateMsgPreview() {
  const testMode    = document.getElementById('fb-test-mode').checked;
  const baseUrl     = (db.settings?.feedbackBaseUrl || 'https://crm.woodpeckers.pizza').replace(/\/$/, '');
  const sample      = _fbEligible[0];
  const name        = (sample?.firstName || '').trim() || 'there';
  const previewLink = `${baseUrl}/fb?t=<token>`;
  const tpl         = document.getElementById('fb-msg-template').value || FB_DEFAULT_TEMPLATE;
  const preview     = tpl.replace('{name}', name).replace('{link}', previewLink);

  const sampleLink = `${baseUrl}/fb?t=abc123def456`;
  const sampleMsg  = tpl.replace('{name}', name).replace('{link}', sampleLink);
  const len        = sampleMsg.length;
  const countEl    = document.getElementById('fb-char-count');
  countEl.textContent = `${len} / 160`;
  countEl.style.color = len > 160 ? 'var(--danger)' : len > 140 ? 'var(--warn)' : 'var(--muted)';

  const note = testMode ? '\n\n⚠ Test mode: SMS routes to your test phone, but real tokens are generated.' : '';
  document.getElementById('fb-msg-preview').textContent = preview + note;
}

function onFbTestModeChange() {
  refreshFbEligible();
}

// ── Send ──────────────────────────────────────────────────────────────────────

async function sendFeedbackSMS() {
  const testMode = document.getElementById('fb-test-mode').checked;
  const toSend   = testMode ? _fbEligible : _fbEligible.filter(c => _fbSelected.has(c.id));

  if (!toSend.length) { toast('No customers selected.', 'warn'); return; }

  const baseUrl = (db.settings?.feedbackBaseUrl || 'https://crm.woodpeckers.pizza').replace(/\/$/, '');
  const btn     = document.getElementById('fb-send-btn');

  const label = testMode
    ? `Send 1 test SMS to your test phone? (Token for: ${toSend[0]?.firstName || toSend[0]?.phone})`
    : `Send feedback SMS to ${toSend.length} customer${toSend.length !== 1 ? 's' : ''}?`;
  if (!confirm(label)) return;

  btn.disabled    = true;
  btn.textContent = 'Sending…';

  try {
    const r = await fetch('/api/feedback-send', {
      method:  'POST',
      headers: { 'Content-Type': 'application/json' },
      body:    JSON.stringify({
        customerIds: toSend.map(c => c.id),
        testMode,
        baseUrl,
        template: document.getElementById('fb-msg-template').value || FB_DEFAULT_TEMPLATE,
      }),
    });
    const j = await r.json();
    if (!j.ok) throw new Error(j.error);

    toast(`Sent ${j.sent} feedback SMS${j.sent !== 1 ? 'es' : ''}${testMode ? ' (test mode)' : ''}.`);
    if (j.errors?.length) toast(`${j.errors.length} failed — check console.`, 'warn');

    // Clear manual list after a successful real send
    if (!testMode) _fbManualAdded = [];

    await loadDB();
    renderFeedback();
  } catch (e) {
    toast('Send failed: ' + e.message, 'error');
  } finally {
    btn.disabled    = false;
    btn.textContent = '📤 Send Feedback SMS';
  }
}

// ── INBOX SECTION ─────────────────────────────────────────────────────────────

function setFbFilter(val, btn) {
  _fbFilter = val;
  document.querySelectorAll('#fb-filters .segment-btn').forEach(b => b.classList.remove('active'));
  btn.classList.add('active');
  renderFeedbackTable();
}

function renderFeedbackStats() {
  const tokens    = db.feedbackTokens || [];
  const submitted = tokens.filter(t => t.usedAt);
  const total     = submitted.length;
  const avg       = total ? (submitted.reduce((s, t) => s + t.rating, 0) / total).toFixed(1) : '—';
  const fiveStar  = submitted.filter(t => t.rating === 5).length;
  const reviewed  = submitted.filter(t => t.googleReviewClicked).length;

  document.getElementById('fb-stats').innerHTML = [
    { val: total,    lbl: 'Total Submitted' },
    { val: avg,      lbl: 'Avg Rating' },
    { val: fiveStar, lbl: '5-Star Ratings' },
    { val: reviewed, lbl: 'Google Reviews' },
  ].map(s => `
    <div class="stat-card">
      <div class="val">${s.val}</div>
      <div class="lbl">${s.lbl}</div>
    </div>`).join('');
}

function renderFeedbackTable() {
  const custMap = {};
  for (const c of db.customers || []) custMap[c.id] = c;

  let rows = (db.feedbackTokens || []).filter(t => t.usedAt);
  if (_fbFilter === '5star')     rows = rows.filter(t => t.rating === 5);
  if (_fbFilter === 'low')       rows = rows.filter(t => t.rating < 5);
  if (_fbFilter === 'no-review') rows = rows.filter(t => t.rating === 5 && !t.googleReviewClicked);

  rows.sort((a, b) => (b.usedAt || '').localeCompare(a.usedAt || ''));

  const tbody = document.getElementById('fb-tbody');
  const empty = document.getElementById('fb-empty');
  const table = document.getElementById('fb-table');

  if (!rows.length) {
    table.style.display = 'none';
    empty.style.display = 'block';
    return;
  }
  table.style.display = '';
  empty.style.display = 'none';

  tbody.innerHTML = rows.map(t => {
    const cust       = custMap[t.customerId];
    const name       = cust ? (`${cust.firstName || ''} ${cust.lastName || ''}`.trim() || '—') : '—';
    const phone      = cust?.phone || '—';
    const stars      = '★'.repeat(t.rating) + '☆'.repeat(5 - t.rating);
    const starColor  = t.rating === 5 ? 'var(--warn)' : t.rating >= 3 ? 'var(--accent)' : 'var(--danger)';
    const googleBadge = t.googleReviewClicked
      ? '<span class="badge bg">✓ Clicked</span>'
      : (t.rating === 5 ? '<span class="badge bw">Not yet</span>' : '<span class="muted">—</span>');

    return `<tr>
      <td style="white-space:nowrap">${fmtDateTimePerth(t.usedAt)}</td>
      <td>${escHtml(name)}</td>
      <td style="white-space:nowrap">${phone}</td>
      <td style="color:${starColor};letter-spacing:2px;font-size:1rem">${stars}</td>
      <td style="max-width:320px;white-space:pre-wrap">${t.remarks ? escHtml(t.remarks) : '<span class="muted">—</span>'}</td>
      <td>${googleBadge}</td>
    </tr>`;
  }).join('');
}

function escHtml(s) {
  return String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}
