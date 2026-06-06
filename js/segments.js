// ── SEGMENTS PAGE ─────────────────────────────────────────────────────────────
const FIELD_LABELS = {
  visits:              'Visits',
  lifetimeSpend:       'Lifetime Spend ($)',
  daysSinceLastVisit:  'Days Since Last Visit',
  daysSinceJoined:     'Days Since Joined',
  loyaltyPoints:       'Loyalty Points',
};
const OPS = ['>=', '<=', '>', '<', '='];
const PRESET_COLORS = [
  '#ffd700','#4ecda4','#4e9eff','#f5a623','#ff5c5c',
  '#b388ff','#f48fb1','#80cbc4','#a5d6a7','#ff8a65',
  '#8899bb','#6b7a99',
];

function segBadgeStyle(color) {
  return `color:${color};background:${color}22;border:1px solid ${color}55;font-size:.72rem;font-weight:700;padding:2px 8px;border-radius:4px`;
}

function renderSegments() {
  const segs = db.segments || [];

  document.getElementById('seg-list').innerHTML = segs.length ? segs.map((s, i) => `
    <tr>
      <td style="width:36px;text-align:center;color:var(--muted);font-size:.8rem">${i + 1}</td>
      <td><span style="${segBadgeStyle(s.color)}">${s.name}</span></td>
      <td style="font-size:.78rem;color:var(--muted)">${fmtConditions(s)}</td>
      <td style="width:80px;text-align:center">
        <span style="font-size:.72rem;padding:2px 8px;border-radius:10px;background:var(--surface2);color:var(--muted)">${s.conditionMode}</span>
      </td>
      <td style="width:160px;white-space:nowrap">
        <button class="btn btn-ghost btn-sm" onclick="moveSegment('${s.id}',-1)" ${i===0?'disabled':''}>↑</button>
        <button class="btn btn-ghost btn-sm" onclick="moveSegment('${s.id}',1)" ${i===segs.length-1?'disabled':''}>↓</button>
        <button class="btn btn-ghost btn-sm" onclick="openSegmentModal('${s.id}')">Edit</button>
        <button class="btn btn-ghost btn-sm" style="color:var(--danger)" onclick="deleteSegment('${s.id}')">✕</button>
      </td>
    </tr>`).join('') :
    '<tr><td colspan="5" style="text-align:center;color:var(--muted);padding:32px">No segments yet. Click "+ New Segment" to create one.</td></tr>';

  // Segment counts
  const counts = {};
  db.customers.forEach(c => {
    const name = c.segment || classifyCustomer(c);
    counts[name] = (counts[name] || 0) + 1;
  });
  document.getElementById('seg-stats').innerHTML = segs.map(s =>
    `<div class="stat-card">
      <div class="val" style="color:${s.color};font-size:1.6rem">${counts[s.name] || 0}</div>
      <div class="lbl"><span style="${segBadgeStyle(s.color)}">${s.name}</span></div>
    </div>`
  ).join('') + (counts['Unclassified'] ? `
    <div class="stat-card">
      <div class="val" style="color:var(--muted);font-size:1.6rem">${counts['Unclassified']}</div>
      <div class="lbl" style="color:var(--muted)">Unclassified</div>
    </div>` : '');
}

function fmtConditions(seg) {
  if (!seg.conditions || !seg.conditions.length) return '<em>No conditions</em>';
  return seg.conditions.map(c =>
    `<strong>${FIELD_LABELS[c.field] || c.field}</strong> ${c.op} ${c.field === 'lifetimeSpend' ? '$' + c.value : c.value}`
  ).join(` <span style="color:var(--accent)">${seg.conditionMode}</span> `);
}

// ── SEGMENT MODAL ─────────────────────────────────────────────────────────────
let _editSegId = null;

function openSegmentModal(id) {
  _editSegId = id || null;
  const seg = id ? db.segments.find(s => s.id === id) : null;

  document.getElementById('seg-modal-title').textContent = seg ? 'Edit Segment' : 'New Segment';
  document.getElementById('seg-modal-name').value = seg ? seg.name : '';
  document.getElementById('seg-modal-mode').value = seg ? seg.conditionMode : 'AND';

  // Color swatches
  const selectedColor = seg ? seg.color : PRESET_COLORS[0];
  document.getElementById('seg-modal-color-input').value = selectedColor;
  renderColorSwatches(selectedColor);

  // Conditions
  const conditions = seg ? seg.conditions : [{ field: 'visits', op: '>=', value: 1 }];
  renderConditionRows(conditions);

  openModal('modal-segment');
}

function renderColorSwatches(selected) {
  document.getElementById('seg-color-swatches').innerHTML = PRESET_COLORS.map(c =>
    `<div onclick="selectColor('${c}')" style="width:24px;height:24px;border-radius:50%;background:${c};cursor:pointer;border:3px solid ${c === selected ? '#fff' : 'transparent'};transition:border .1s" title="${c}"></div>`
  ).join('');
}

function selectColor(color) {
  document.getElementById('seg-modal-color-input').value = color;
  renderColorSwatches(color);
}

function renderConditionRows(conditions) {
  document.getElementById('seg-conditions').innerHTML = conditions.map((c, i) => conditionRowHTML(c, i)).join('');
}

function conditionRowHTML(c, i) {
  const fields = Object.entries(FIELD_LABELS).map(([v, l]) =>
    `<option value="${v}" ${c.field === v ? 'selected' : ''}>${l}</option>`).join('');
  const ops = OPS.map(o => `<option value="${o}" ${c.op === o ? 'selected' : ''}>${o}</option>`).join('');
  return `<div class="condition-row" style="display:flex;gap:6px;align-items:center;margin-bottom:6px">
    <select class="input" style="flex:2">${fields}</select>
    <select class="input" style="flex:0 0 60px">${ops}</select>
    <input class="input" type="number" style="flex:1" value="${c.value}" placeholder="Value">
    <button class="btn btn-ghost btn-sm" style="color:var(--danger);flex:0 0 auto" onclick="removeConditionRow(this)">✕</button>
  </div>`;
}

function addConditionRow() {
  const container = document.getElementById('seg-conditions');
  const i = container.children.length;
  container.insertAdjacentHTML('beforeend', conditionRowHTML({ field: 'visits', op: '>=', value: 1 }, i));
}

function removeConditionRow(btn) {
  btn.closest('.condition-row').remove();
}

function readConditions() {
  return [...document.querySelectorAll('#seg-conditions .condition-row')].map(row => {
    const selects = row.querySelectorAll('select');
    const input   = row.querySelector('input');
    return { field: selects[0].value, op: selects[1].value, value: parseFloat(input.value) || 0 };
  });
}

async function saveSegmentModal() {
  const name = document.getElementById('seg-modal-name').value.trim();
  if (!name) { alert('Segment name is required.'); return; }

  const seg = {
    id:            _editSegId || uid(),
    name,
    color:         document.getElementById('seg-modal-color-input').value,
    conditionMode: document.getElementById('seg-modal-mode').value,
    conditions:    readConditions(),
    priority:      _editSegId ? db.segments.find(s => s.id === _editSegId)?.priority : db.segments.length + 1,
  };

  if (_editSegId) {
    const idx = db.segments.findIndex(s => s.id === _editSegId);
    if (idx !== -1) db.segments[idx] = seg;
  } else {
    db.segments.push(seg);
  }

  await saveDB();
  closeModal('modal-segment');
  renderSegments();
  renderCustomers();
  toast(`Segment "${name}" saved.`);
}

async function deleteSegment(id) {
  const seg = db.segments.find(s => s.id === id);
  if (!seg || !confirm(`Delete segment "${seg.name}"?`)) return;
  db.segments = db.segments.filter(s => s.id !== id);
  await saveDB();
  renderSegments();
  renderCustomers();
  toast(`Segment "${seg.name}" deleted.`);
}

async function moveSegment(id, dir) {
  const idx = db.segments.findIndex(s => s.id === id);
  const newIdx = idx + dir;
  if (newIdx < 0 || newIdx >= db.segments.length) return;
  [db.segments[idx], db.segments[newIdx]] = [db.segments[newIdx], db.segments[idx]];
  await saveDB();
  renderSegments();
  renderCustomers();
}

async function resetSegments() {
  if (!confirm('Reset all segments to defaults? This cannot be undone.')) return;
  db.segments = JSON.parse(JSON.stringify(DEFAULT_SEGMENTS));
  await saveDB();
  renderSegments();
  renderCustomers();
  toast('Segments reset to defaults.');
}
