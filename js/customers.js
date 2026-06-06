// ── CUSTOMERS ─────────────────────────────────────────────────────────────────
let _custSearch   = '';
let _custSegment  = 'all';
let _custSelected = new Set();
let _custPage     = 0;
let _sortCol      = 'name';
let _sortDesc     = false;
const PAGE_SIZE   = 100;

function sortBy(col) {
  if (_sortCol === col) _sortDesc = !_sortDesc;
  else { _sortCol = col; _sortDesc = false; }
  _custPage = 0;
  renderCustomers();
}

function applySort(rows) {
  return [...rows].sort((a, b) => {
    let av, bv;
    switch (_sortCol) {
      case 'name':
        av = ([a.firstName, a.lastName].filter(Boolean).join(' ') || '').toLowerCase();
        bv = ([b.firstName, b.lastName].filter(Boolean).join(' ') || '').toLowerCase();
        break;
      case 'phone':        av = a.phone || ''; bv = b.phone || ''; break;
      case 'email':        av = a.email || ''; bv = b.email || ''; break;
      case 'createdAt':    av = a.createdAt || ''; bv = b.createdAt || ''; break;
      case 'loyaltyPoints': av = a.loyaltyPoints || 0; bv = b.loyaltyPoints || 0; break;
      case 'visits':       av = a.visits || 0; bv = b.visits || 0; break;
      case 'lastVisit':    av = a.lastVisit || ''; bv = b.lastVisit || ''; break;
      case 'birthday': {
        // Sort by month-day only (ignore year) so birthdays sort chronologically through the year
        const toMD = b => { if (!b) return ''; const p = b.split('-'); return p.length === 2 ? b : p[1]+'-'+p[2]; };
        av = toMD(a.birthday); bv = toMD(b.birthday); break;
      }
      case 'lifetimeSpend': av = a.lifetimeSpend || 0; bv = b.lifetimeSpend || 0; break;
      case 'smsStatus':
        av = !a.phone ? 2 : db.optOuts.includes(a.phone) ? 1 : 0;
        bv = !b.phone ? 2 : db.optOuts.includes(b.phone) ? 1 : 0;
        break;
      case 'segment': {
        const order = ['VIP','Regular','Lapsed','New','Occasional','One-time','Lost'];
        av = order.indexOf(classifyCustomer(a));
        bv = order.indexOf(classifyCustomer(b));
        break;
      }
      default:             av = ''; bv = '';
    }
    if (av < bv) return _sortDesc ? 1 : -1;
    if (av > bv) return _sortDesc ? -1 : 1;
    return 0;
  });
}

// ── QUICK SYNC (profiles + loyalty points + recent orders) ────────────────────
async function syncSquareCustomers() {
  const token = db.settings.squareToken;
  if (!token) { alert('Set your Square Access Token in Settings first.'); return; }

  const btn = document.getElementById('sync-btn');
  btn.disabled = true; btn.textContent = '⏳ Syncing…';

  try {
    const resp = await fetch('/api/square-loyalty-sync', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ token }),
    });
    const data = await resp.json();
    if (!resp.ok) throw new Error(data.error || 'Sync failed');

    await loadDB();
    renderCustomers();
    const mode = data.incremental ? ' (incremental)' : ' (full scan)';
    toast(`Sync done — ${data.loyaltyUpdated||0} loyalty, ${data.visitsUpdated||0} visits, ${data.profilesUpdated||0}+${data.profilesAdded||0} profiles${mode}.`);
  } catch(e) {
    alert('Sync failed: ' + e.message);
  } finally {
    btn.disabled = false; btn.textContent = '⟳ Sync Square';
  }
}

// ── CELLCAST OPT-OUT SYNC ─────────────────────────────────────────────────────
async function syncOptOuts() {
  const apiKey = db.settings.cellcastKey;
  if (!apiKey) { alert('Set your Cellcast API Key in Settings first.'); return; }

  const btn = document.getElementById('optout-sync-btn');
  btn.disabled = true; btn.textContent = '⏳ Syncing…';

  try {
    const resp = await fetch('/api/cellcast-optouts', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ apiKey }),
    });
    const data = await resp.json();
    if (!resp.ok) throw new Error(data.error || 'Sync failed');

    const before = db.optOuts.length;
    db.optOuts = [...new Set([...db.optOuts, ...data.optouts])];
    const added = db.optOuts.length - before;
    await saveDB();
    renderCustomers();
    toast(`Opt-outs synced — ${data.optouts.length} from Cellcast, ${added} new.`);
  } catch(e) {
    alert('Opt-out sync failed: ' + e.message);
  } finally {
    btn.disabled = false; btn.textContent = '📵 Sync Opt-outs';
  }
}

// ── CUSTOMER SEGMENT CLASSIFICATION ───────────────────────────────────────────
function classifyCustomer(c) {
  const segs = (db.segments && db.segments.length) ? db.segments : DEFAULT_SEGMENTS;
  const now  = new Date();
  const fields = {
    visits:             c.visits || 0,
    lifetimeSpend:      (c.lifetimeSpend || 0) / 100,
    daysSinceLastVisit: c.lastVisit   ? Math.floor((now - new Date(c.lastVisit))   / 86400000) : 9999,
    daysSinceJoined:    c.createdAt   ? Math.floor((now - new Date(c.createdAt))   / 86400000) : 9999,
    loyaltyPoints:      c.loyaltyPoints || 0,
  };
  for (const seg of segs) {
    if (!seg.conditions || !seg.conditions.length) continue;
    const results = seg.conditions.map(({ field, op, value }) => {
      const v = fields[field];
      if (op === '>=') return v >= value;
      if (op === '<=') return v <= value;
      if (op === '>')  return v >  value;
      if (op === '<')  return v <  value;
      if (op === '=')  return v === value;
      return false;
    });
    const match = seg.conditionMode === 'OR' ? results.some(Boolean) : results.every(Boolean);
    if (match) return seg.name;
  }
  return 'Unclassified';
}

function getSegmentColor(name) {
  const seg = (db.segments || DEFAULT_SEGMENTS).find(s => s.name === name);
  return seg ? seg.color : '#6b7a99';
}

// ── SEGMENTS ──────────────────────────────────────────────────────────────────
function getSegment(seg) {
  const now = new Date();
  switch(seg) {
    case 'all':       return db.customers;
    case 'has-phone': return db.customers.filter(c => c.phone);
    case 'has-email': return db.customers.filter(c => c.email);
    case 'birthday':  return db.customers.filter(c => {
      if (!c.birthday) return false;
      // Square birthday format: MM-DD or YYYY-MM-DD
      const parts = c.birthday.split('-');
      const month = parts.length === 2 ? parseInt(parts[0]) : parseInt(parts[1]);
      return month === now.getMonth() + 1;
    });
    case 'opt-out':   return db.customers.filter(c => db.optOuts.includes(c.phone));
    default:          return db.customers;
  }
}

// ── RENDER ────────────────────────────────────────────────────────────────────
function renderCustomers() {
  // Summary stats
  const withPhone = db.customers.filter(c => c.phone).length;
  const withEmail = db.customers.filter(c => c.email).length;
  const optedOut  = db.optOuts.length;
  const thisMonth = getSegment('birthday').length;

  const lastSync = fmtDateTimePerth(db.lastOrderSyncAt || db.lastLoyaltySync);
  document.getElementById('cust-stats').innerHTML = `
    <div class="stat-card"><div class="val">${db.customers.length}</div><div class="lbl">Total Customers</div></div>
    <div class="stat-card"><div class="val">${withPhone}</div><div class="lbl">Have Phone</div></div>
    <div class="stat-card"><div class="val">${withEmail}</div><div class="lbl">Have Email</div></div>
    <div class="stat-card"><div class="val">${thisMonth}</div><div class="lbl">Birthdays This Month</div></div>
    <div class="stat-card"><div class="val">${optedOut}</div><div class="lbl">Opted Out</div></div>
    <div class="stat-card"><div class="val" style="font-size:1rem">${lastSync}</div><div class="lbl">Loyalty Last Synced</div></div>`;

  // Segment buttons
  document.querySelectorAll('.segment-btn').forEach(b => {
    b.classList.toggle('active', b.dataset.seg === _custSegment);
  });

  // Filter + sort
  const q = _custSearch.toLowerCase();
  let rows = getSegment(_custSegment).filter(c => {
    if (!q) return true;
    return [c.firstName, c.lastName, c.email, c.phone, ...(c.tags||[])].join(' ').toLowerCase().includes(q);
  });
  rows = applySort(rows);

  // Update sort indicators on headers
  document.querySelectorAll('th.sortable').forEach(th => {
    th.classList.toggle('sort-active', th.querySelector('.sort-icon')?.dataset.col === _sortCol);
    th.classList.toggle('sort-desc', th.querySelector('.sort-icon')?.dataset.col === _sortCol && _sortDesc);
  });

  const selectedCount = _custSelected.size;
  document.getElementById('cust-selection-bar').style.display = selectedCount ? 'flex' : 'none';
  document.getElementById('cust-selected-count').textContent = selectedCount;

  const tb      = document.getElementById('cust-table');
  const pgBar   = document.getElementById('cust-pagination');
  const total   = rows.length;
  const pages   = Math.ceil(total / PAGE_SIZE);
  _custPage     = Math.min(_custPage, Math.max(0, pages - 1));
  const pageRows = rows.slice(_custPage * PAGE_SIZE, (_custPage + 1) * PAGE_SIZE);

  if (!total) {
    tb.innerHTML = '<tr><td colspan="12" style="text-align:center;color:var(--muted);padding:32px">No customers found.</td></tr>';
    pgBar.innerHTML = '';
    return;
  }

  tb.innerHTML = pageRows.map(c => {
    const optedOut = db.optOuts.includes(c.phone);
    const name = [c.firstName, c.lastName].filter(Boolean).join(' ') || '—';
    const checked = _custSelected.has(c.id);
    const tags = (c.tags||[]).map(t => `<span class="tag">${t}</span>`).join('');
    const seg = c.segment || classifyCustomer(c);
    const segStyle = segBadgeStyle(getSegmentColor(seg));
    return `<tr>
      <td><input type="checkbox" ${checked?'checked':''} ${!c.phone||optedOut?'disabled title="No phone or opted out"':''}
        onchange="toggleSelectCust('${c.id}',this.checked)" style="accent-color:var(--accent);width:14px;height:14px;cursor:pointer"></td>
      <td><strong>${name}</strong>${tags ? '<div style="margin-top:2px">'+tags+'</div>' : ''}</td>
      <td style="white-space:nowrap">${c.phone || '<span class="muted">—</span>'}</td>
      <td><span style="font-size:.72rem;font-weight:700;padding:2px 8px;border-radius:4px;${segStyle}">${seg}</span></td>
      <td style="text-align:center">${
        !c.phone ? '<span class="muted">—</span>'
        : optedOut ? '<span style="background:rgba(255,92,92,.15);color:#ff5c5c;font-size:.7rem;font-weight:700;padding:2px 6px;border-radius:4px;border:1px solid rgba(255,92,92,.3)">OUT</span>'
        : '<span style="background:rgba(78,205,164,.15);color:#4ecda4;font-size:.7rem;font-weight:700;padding:2px 6px;border-radius:4px;border:1px solid rgba(78,205,164,.3)">✓</span>'
      }</td>
      <td style="text-align:center">${c.loyaltyPoints ? `<span style="color:var(--accent2);font-weight:600">${c.loyaltyPoints}</span>` : '<span class="muted">0</span>'}</td>
      <td style="text-align:center">${c.visits ? `<span style="font-weight:600">${c.visits}</span>` : '<span class="muted">0</span>'}</td>
      <td style="white-space:nowrap" class="muted">${c.lastVisit ? fmtDate(c.lastVisit) : '—'}</td>
      <td style="white-space:nowrap">${c.lifetimeSpend ? `<span style="color:var(--accent2)">${fmtCurrency(c.lifetimeSpend)}</span>` : '<span class="muted">—</span>'}</td>
      <td style="white-space:nowrap" class="muted">${fmtDate(c.createdAt)}</td>
      <td style="white-space:nowrap">${fmtBirthday(c.birthday)}</td>
      <td style="white-space:nowrap">
        <button class="btn btn-ghost btn-sm" onclick="openCustModal('${c.id}')">Edit</button>
        ${c.phone && !optedOut ? `<button class="btn btn-ghost btn-sm" onclick="markOptOut('${c.id}')">Opt-out</button>` : ''}
        ${c.phone && optedOut  ? `<button class="btn btn-ghost btn-sm" onclick="removeOptOut('${c.id}')">Re-opt</button>` : ''}
      </td>
    </tr>`;
  }).join('');

  // Pagination bar
  const from = _custPage * PAGE_SIZE + 1;
  const to   = Math.min((_custPage + 1) * PAGE_SIZE, total);
  pgBar.innerHTML = pages <= 1 ? '' : `
    <div class="flex" style="justify-content:space-between;align-items:center;padding:10px 14px;border-top:1px solid var(--border)">
      <span class="muted">${from}–${to} of ${total} customers</span>
      <div class="flex" style="gap:4px">
        <button class="btn btn-ghost btn-sm" onclick="custGoPage(0)" ${_custPage===0?'disabled':''}>«</button>
        <button class="btn btn-ghost btn-sm" onclick="custGoPage(_custPage-1)" ${_custPage===0?'disabled':''}>‹ Prev</button>
        ${Array.from({length:pages},(_,i)=>i).filter(i=>Math.abs(i-_custPage)<=2).map(i=>`
          <button class="btn btn-sm ${i===_custPage?'btn-primary':'btn-ghost'}" onclick="custGoPage(${i})">${i+1}</button>`).join('')}
        <button class="btn btn-ghost btn-sm" onclick="custGoPage(_custPage+1)" ${_custPage>=pages-1?'disabled':''}>Next ›</button>
        <button class="btn btn-ghost btn-sm" onclick="custGoPage(${pages-1})" ${_custPage>=pages-1?'disabled':''}>»</button>
      </div>
    </div>`;
}

function custGoPage(p) {
  _custPage = p;
  renderCustomers();
  document.getElementById('page-customers').scrollIntoView({ behavior: 'smooth', block: 'start' });
}

function toggleSelectCust(id, checked) {
  if (checked) _custSelected.add(id); else _custSelected.delete(id);
  const selectedCount = _custSelected.size;
  document.getElementById('cust-selection-bar').style.display = selectedCount ? 'flex' : 'none';
  document.getElementById('cust-selected-count').textContent = selectedCount;
}

function selectAllVisible() {
  const q = _custSearch.toLowerCase();
  getSegment(_custSegment)
    .filter(c => !q || [c.firstName, c.lastName, c.email, c.phone].join(' ').toLowerCase().includes(q))
    .filter(c => c.phone && !db.optOuts.includes(c.phone))
    .forEach(c => _custSelected.add(c.id));
  renderCustomers();
}

function clearSelection() { _custSelected.clear(); renderCustomers(); }

function setSegment(seg) { _custSegment = seg; _custPage = 0; renderCustomers(); }

function sendToSelected() {
  if (!_custSelected.size) return;
  goPage('campaigns', document.querySelectorAll('nav button.nav-tab')[1]);
  openNewCampaign([...db.customers.filter(c => _custSelected.has(c.id))]);
}

// ── CUSTOMER MODAL ────────────────────────────────────────────────────────────
let _editCustId = null;
function openCustModal(id) {
  _editCustId = id;
  const c = db.customers.find(x => x.id === id);
  if (!c) return;
  document.getElementById('cust-modal-title').textContent = [c.firstName, c.lastName].filter(Boolean).join(' ') || 'Customer';
  const segSelect = document.getElementById('cust-modal-segment');
  segSelect.innerHTML = '<option value="">Auto</option>' +
    (db.segments || DEFAULT_SEGMENTS).map(s =>
      `<option value="${s.name}" ${c.segment === s.name ? 'selected' : ''}>${s.name}</option>`
    ).join('');
  if (!c.segment) segSelect.value = '';
  document.getElementById('cust-modal-tags').value = (c.tags||[]).join(', ');
  document.getElementById('cust-modal-note').value = c.note || '';
  document.getElementById('cust-modal-loyalty').value = c.loyaltyPoints || 0;
  document.getElementById('cust-modal-visits').value = c.visits || 0;
  document.getElementById('cust-modal-lastvisit').value = c.lastVisit || '';

  // Birthday: Square sends MM-DD; date input requires YYYY-MM-DD
  const bdayEl = document.getElementById('cust-modal-birthday');
  if (c.birthday) {
    const parts = c.birthday.split('-');
    bdayEl.value = parts.length === 2 ? `2000-${parts[0].padStart(2,'0')}-${parts[1].padStart(2,'0')}` : c.birthday;
  } else {
    bdayEl.value = '';
  }

  document.getElementById('cust-modal-info').innerHTML = `
    <div style="display:grid;grid-template-columns:1fr 1fr;gap:6px 16px">
      <div><span class="label">Phone</span>${c.phone||'—'}</div>
      <div><span class="label">Email</span>${c.email||'—'}</div>
      <div><span class="label">Customer Since</span>${fmtDate(c.createdAt)}</div>
      <div><span class="label">Lifetime Spend</span><span style="color:var(--accent2);font-weight:600">${fmtCurrency(c.lifetimeSpend)}</span></div>
    </div>
    ${c.squareNote ? `<div style="margin-top:8px;padding-top:8px;border-top:1px solid var(--border)"><span class="label">Square Note</span>${c.squareNote}</div>` : ''}`;

  // SMS chat history — combine outbound (smsSent) and inbound (smsReplies), sorted oldest first
  const chatWrap = document.getElementById('cust-modal-chat-wrap');
  const chatEl   = document.getElementById('cust-modal-chat');
  const thread = [
    ...(c.smsSent   || []).map(m => ({ dir: 'out', text: m.message, date: m.sentAt,      label: m.label || 'Sent' })),
    ...(c.smsReplies|| []).map(m => ({ dir: 'in',  text: m.message, date: m.receivedAt,  label: m.birthdaySaved ? '🎂 Birthday saved' : '' })),
  ].sort((a, b) => new Date(a.date) - new Date(b.date));

  if (thread.length) {
    chatEl.innerHTML = thread.map(m => {
      const isOut = m.dir === 'out';
      const bubbleStyle = isOut
        ? 'background:var(--accent);color:#fff;border-radius:14px 14px 4px 14px;align-self:flex-end;max-width:80%'
        : 'background:var(--surface2);border-radius:14px 14px 14px 4px;align-self:flex-start;max-width:80%';
      const metaStyle  = isOut ? 'text-align:right' : '';
      return `<div style="${bubbleStyle};padding:8px 12px">
        <div style="font-size:.75rem;opacity:.7;margin-bottom:3px;${metaStyle}">${m.label ? m.label + ' · ' : ''}${m.date ? fmtDate(m.date) : ''}</div>
        <div style="line-height:1.4">${m.text || ''}</div>
      </div>`;
    }).join('');
    chatEl.scrollTop = chatEl.scrollHeight;
    chatWrap.style.display = '';
  } else {
    chatEl.innerHTML = '';
    chatWrap.style.display = 'none';
  }

  openModal('modal-customer');
}

async function saveCustModal() {
  const c = db.customers.find(x => x.id === _editCustId);
  if (!c) return;
  c.segment      = document.getElementById('cust-modal-segment').value || null;
  c.tags         = document.getElementById('cust-modal-tags').value.split(',').map(t => t.trim()).filter(Boolean);
  c.note         = document.getElementById('cust-modal-note').value.trim();
  c.loyaltyPoints = Math.max(0, parseInt(document.getElementById('cust-modal-loyalty').value) || 0);
  c.visits       = Math.max(0, parseInt(document.getElementById('cust-modal-visits').value) || 0);
  c.lastVisit    = document.getElementById('cust-modal-lastvisit').value || null;
  const bdayVal  = document.getElementById('cust-modal-birthday').value;
  c.birthday     = bdayVal || c.birthday || '';
  await saveDB();
  closeModal('modal-customer');
  renderCustomers();
  toast('Customer updated.');
}

// ── LOYALTY & VISIT HELPERS ───────────────────────────────────────────────────
function adjustLoyalty(delta) {
  const el = document.getElementById('cust-modal-loyalty');
  el.value = Math.max(0, (parseInt(el.value) || 0) + delta);
}

function adjustVisits(delta) {
  const el = document.getElementById('cust-modal-visits');
  el.value = Math.max(0, (parseInt(el.value) || 0) + delta);
}

function logVisitToday() {
  document.getElementById('cust-modal-lastvisit').value = new Date().toISOString().split('T')[0];
  adjustVisits(1);
}

async function quickLogVisit(id) {
  const c = db.customers.find(x => x.id === id);
  if (!c) return;
  c.visits    = (c.visits || 0) + 1;
  c.lastVisit = new Date().toISOString().split('T')[0];
  await saveDB();
  renderCustomers();
  toast(`Visit logged for ${c.firstName || 'customer'} — ${c.visits} total.`);
}

// ── OPT-OUT ───────────────────────────────────────────────────────────────────
async function markOptOut(id) {
  const c = db.customers.find(x => x.id === id);
  if (!c?.phone || !confirm(`Mark ${c.firstName || c.phone} as opted out?`)) return;
  if (!db.optOuts.includes(c.phone)) db.optOuts.push(c.phone);
  _custSelected.delete(id);
  await saveDB();
  renderCustomers();
  toast('Marked as opted out.');
}

async function removeOptOut(id) {
  const c = db.customers.find(x => x.id === id);
  if (!c?.phone) return;
  db.optOuts = db.optOuts.filter(p => p !== c.phone);
  await saveDB();
  renderCustomers();
  toast('Opt-out removed.');
}

// ── SQUARE CSV IMPORT (one-time baseline) ──────────────────────────────────────
function parseCSVBrowser(text) {
  // Auto-detect delimiter: Square exports TSV, others may use CSV
  const firstLine = text.slice(0, text.indexOf('\n'));
  const delim = (firstLine.split('\t').length > firstLine.split(',').length) ? '\t' : ',';
  const rows = [];
  let row = [], field = '', inQuote = false;
  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    if (inQuote) {
      if (ch === '"' && text[i + 1] === '"') { field += '"'; i++; }
      else if (ch === '"') { inQuote = false; }
      else { field += ch; }
    } else {
      if      (ch === '"')   { inQuote = true; }
      else if (ch === delim) { row.push(field); field = ''; }
      else if (ch === '\n')  { row.push(field); field = ''; rows.push(row); row = []; }
      else if (ch !== '\r')  { field += ch; }
    }
  }
  if (field || row.length) { row.push(field); rows.push(row); }
  return rows;
}

async function importSquareCSV(input) {
  const file = input.files[0];
  if (!file) return;
  const btn = document.getElementById('csv-import-btn');
  btn.disabled = true; btn.textContent = '⏳ Parsing…';
  try {
    const text = await file.text();
    const rows = parseCSVBrowser(text);
    if (rows.length < 2) throw new Error('CSV appears empty.');

    // Find column indices from header
    const header = rows[0].map(h => h.trim().toLowerCase());
    const col = name => header.indexOf(name);
    const idxSquareId   = col('square customer id');
    const idxFirstName  = col('first name');
    const idxLastName   = col('surname') !== -1 ? col('surname') : col('last name');
    const idxEmail      = col('email address');
    const idxPhone      = col('phone number');
    const idxBirthday   = col('birthday');
    const idxLastVisit  = col('last visit');
    const idxTxCount    = col('transaction count');
    const idxSpend      = col('lifetime spend');
    const idxFirstVisit = col('first visit');
    if (idxSquareId === -1) throw new Error('Missing "Square Customer ID" column — wrong file?');

    const records = [];
    for (let i = 1; i < rows.length; i++) {
      const r = rows[i];
      const squareId = r[idxSquareId]?.trim();
      if (!squareId) continue;
      const spend = parseFloat((r[idxSpend] || '').replace(/[$,]/g, '').trim());
      records.push({
        squareId,
        firstName:     idxFirstName !== -1 ? r[idxFirstName]?.trim() || '' : '',
        lastName:      idxLastName  !== -1 ? r[idxLastName]?.trim()  || '' : '',
        email:         idxEmail     !== -1 ? r[idxEmail]?.trim()     || '' : '',
        phone:         idxPhone     !== -1 ? r[idxPhone]?.trim()     || '' : '',
        birthday:      idxBirthday  !== -1 ? r[idxBirthday]?.trim()  || '' : '',
        visits:        parseInt(r[idxTxCount]) || 0,
        lifetimeSpend: isNaN(spend) ? 0 : Math.round(spend * 100),
        lastVisit:     r[idxLastVisit]?.trim()  || '',
        createdAt:     r[idxFirstVisit]?.trim() || '',
      });
    }

    if (!confirm(`Import ${records.length} rows from CSV?\n\nThis will wipe and rebuild all customer records from the CSV. Your tags, notes, SMS replies, and loyalty points will be re-applied automatically after the rebuild.`)) {
      btn.disabled = false; btn.textContent = '📥 Import CSV'; input.value = ''; return;
    }

    btn.textContent = '⏳ Importing…';
    const resp = await fetch('/api/import-square-csv', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ records }),
    });
    const data = await resp.json();
    if (!resp.ok) throw new Error(data.error || 'Import failed');
    await loadDB();
    renderCustomers();
    toast(`CSV imported — ${data.added} customers, ${data.reapplied} with CRM data restored.`);
  } catch(e) {
    alert('Import failed: ' + e.message);
  } finally {
    btn.disabled = false; btn.textContent = '📥 Import CSV';
    input.value = '';
  }
}
