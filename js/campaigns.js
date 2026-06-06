// ── CAMPAIGNS ─────────────────────────────────────────────────────────────────
let _campaignRecipients = []; // customers queued for current compose
let _campSegmentRecipients = []; // resolved recipients for segment campaign

const SMS_LIMIT = 160;

// ── COMPOSER ─────────────────────────────────────────────────────────────────
function openCampaignComposer(recipients) {
  _campaignRecipients = recipients.filter(c => c.phone && !db.optOuts.includes(c.phone));
  if (!_campaignRecipients.length) { toast('No reachable recipients (need phone, not opted out).', 'warn'); return; }

  document.getElementById('compose-count').textContent = _campaignRecipients.length;
  document.getElementById('compose-message').value = '';
  document.getElementById('compose-char').textContent = `0 / ${SMS_LIMIT}`;
  document.getElementById('compose-preview').textContent = '';
  renderRecipientList();
  openModal('modal-compose');
}

function renderRecipientList() {
  document.getElementById('compose-recipients').innerHTML = _campaignRecipients.map(c =>
    `<div style="padding:3px 0;font-size:.8rem">${[c.firstName,c.lastName].filter(Boolean).join(' ')||'?'} <span class="muted">${c.phone}</span></div>`
  ).join('');
}

function onComposeInput() {
  const msg = document.getElementById('compose-message').value;
  const len = msg.length;
  const charEl = document.getElementById('compose-char');
  charEl.textContent = `${len} / ${SMS_LIMIT}`;
  charEl.style.color = len > SMS_LIMIT ? 'var(--danger)' : len > SMS_LIMIT * 0.9 ? 'var(--warn)' : 'var(--muted)';

  // Preview with first recipient's name
  const sample = _campaignRecipients[0];
  if (sample) {
    const preview = msg.replace(/\{first_name\}/gi, sample.firstName || 'there').replace(/\{name\}/gi, [sample.firstName, sample.lastName].filter(Boolean).join(' ') || 'there');
    document.getElementById('compose-preview').textContent = preview;
  }
}

async function sendCampaign(bypassWeeklyGuard = false) {
  const message = document.getElementById('compose-message').value.trim();
  if (!message) { toast('Message is empty.', 'error'); return; }

  const apiKey = db.settings.cellcastKey;
  const sender = db.settings.cellcastSender || null;
  if (!apiKey) { alert('Set your Cellcast API key in Settings.'); return; }

  const recipients = _campaignRecipients.map(c => ({
    number:    c.phone,
    firstName: c.firstName || '',
    name:      [c.firstName, c.lastName].filter(Boolean).join(' '),
  }));

  const btn = document.getElementById('compose-send-btn');
  btn.disabled = true; btn.textContent = '⏳ Sending…';

  try {
    const resp = await fetch('/api/cellcast-send', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ apiKey, sender, recipients, message, bypassWeeklyGuard, segment: 'Campaign' }),
    });
    const data = await resp.json();
    if (!resp.ok) {
      const err = data.error || 'Send failed';
      if (err.startsWith('WEEKLY_GUARD:')) {
        const count = err.split(':')[1];
        btn.disabled = false; btn.textContent = '📤 Send';
        if (confirm(`⚠️ ${count} recipient(s) were already texted in the last 7 days.\n\nSend anyway?`))
          sendCampaign(true);
        return;
      }
      throw new Error(err);
    }

    await loadDB();
    closeModal('modal-compose');
    _custSelected.clear();
    toast(`Sent to ${recipients.length} recipient${recipients.length !== 1 ? 's' : ''}.`);
    renderCustomers();
    if (document.getElementById('page-campaigns').classList.contains('active')) renderCampaigns();
  } catch(e) {
    toast('Send failed: ' + e.message, 'error');
  } finally {
    btn.disabled = false; btn.textContent = '📤 Send';
  }
}

// ── SEGMENT-BASED CAMPAIGN COMPOSER ───────────────────────────────────────────
function openNewCampaign(preselectedCustomers) {
  // Populate segment dropdown
  const sel = document.getElementById('camp-segment-select');
  // Keep first two options, rebuild the segment ones
  while (sel.options.length > 2) sel.remove(2);
  (db.segments || DEFAULT_SEGMENTS).forEach(s => {
    const opt = document.createElement('option');
    opt.value = s.name;
    opt.textContent = `Segment: ${s.name}`;
    sel.appendChild(opt);
  });

  // If called from customer selection
  const selectedOpt = document.getElementById('camp-selected-opt');
  if (preselectedCustomers && preselectedCustomers.length) {
    _campSegmentRecipients = preselectedCustomers.filter(c => c.phone && !db.optOuts.includes(c.phone));
    selectedOpt.style.display = '';
    selectedOpt.textContent = `Selected customers (${preselectedCustomers.length})`;
    sel.value = '__selected__';
  } else {
    selectedOpt.style.display = 'none';
    sel.value = '__all__';
  }

  document.getElementById('camp-message').value = '';
  document.getElementById('camp-char').textContent = '0 / 160';
  document.getElementById('camp-preview').textContent = '';
  document.getElementById('camp-confirm-input') && (document.getElementById('camp-confirm-input').value = '');
  onCampSegmentChange();
  document.getElementById('campaign-compose-card').style.display = 'block';
  document.getElementById('campaign-compose-card').scrollIntoView({ behavior: 'smooth', block: 'start' });
}

function closeCampaignCompose() {
  document.getElementById('campaign-compose-card').style.display = 'none';
}

function onCampSegmentChange() {
  const val = document.getElementById('camp-segment-select').value;
  if (val === '__selected__') {
    // already set from openNewCampaign
  } else if (val === '__all__') {
    _campSegmentRecipients = db.customers.filter(c => c.phone && !db.optOuts.includes(c.phone));
  } else {
    _campSegmentRecipients = db.customers.filter(c => {
      if (!c.phone || db.optOuts.includes(c.phone)) return false;
      return (c.segment || classifyCustomer(c)) === val;
    });
  }
  document.getElementById('camp-recipient-count').textContent = _campSegmentRecipients.length;
  updateSafetyBar();
  onCampMessageInput();
}

function updateSafetyBar() {
  const count      = _campSegmentRecipients.length;
  const costCents  = db.settings.smsCostCents  || 9;
  const sendLimit  = db.settings.sendLimit     || null;
  const overLimit  = sendLimit && count > sendLimit;

  // Cost estimate
  const total = (count * costCents) / 100;
  document.getElementById('camp-cost-estimate').textContent =
    count ? `~$${total.toFixed(2)} AUD (${count} × $${(costCents/100).toFixed(2)})` : '—';

  // Limit warning
  document.getElementById('camp-limit-warning').style.display = overLimit ? 'block' : 'none';

  // Hard confirm block
  const confirmBlock = document.getElementById('camp-hard-confirm');
  confirmBlock.style.display = overLimit ? 'block' : 'none';
  document.getElementById('camp-confirm-count').textContent = count;
  if (!overLimit) {
    document.getElementById('camp-send-btn').disabled = false;
  } else {
    document.getElementById('camp-confirm-input').value = '';
    document.getElementById('camp-send-btn').disabled = true;
  }
}

function onConfirmInput() {
  const count   = _campSegmentRecipients.length;
  const entered = parseInt(document.getElementById('camp-confirm-input').value);
  document.getElementById('camp-send-btn').disabled = entered !== count;
}

async function sendTestSMS() {
  const testPhone = db.settings.testPhone;
  if (!testPhone) { alert('Set a Test Phone Number in Settings first.'); return; }
  const message = document.getElementById('camp-message').value.trim();
  if (!message) { toast('Write your message first.', 'warn'); return; }
  const apiKey = db.settings.cellcastKey;
  const sender = db.settings.cellcastSender || null;
  if (!apiKey) { alert('Set your Cellcast API key in Settings first.'); return; }

  const btn = document.getElementById('camp-test-btn');
  btn.disabled = true; btn.textContent = '⏳ Sending…';
  try {
    // Use your own name for the preview substitution
    const preview = message
      .replace(/\{first_name\}/gi, 'Test')
      .replace(/\{name\}/gi, 'Test User');
    const resp = await fetch('/api/cellcast-send', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ apiKey, sender, recipients: [{ number: testPhone }], message: preview }),
    });
    const data = await resp.json();
    if (!resp.ok) throw new Error(data.error || 'Send failed');
    toast(`Test SMS sent to ${testPhone}.`);
  } catch(e) {
    toast('Test failed: ' + e.message, 'error');
  } finally {
    btn.disabled = false; btn.textContent = '📱 Send Test';
  }
}

function onCampMessageInput() {
  const msg  = document.getElementById('camp-message').value;
  const len  = msg.length;
  const el   = document.getElementById('camp-char');
  el.textContent = `${len} / 160`;
  el.style.color = len > 160 ? 'var(--danger)' : len > 144 ? 'var(--warn)' : 'var(--muted)';
  const sample = _campSegmentRecipients[0];
  document.getElementById('camp-preview').textContent = sample
    ? msg.replace(/\{first_name\}/gi, sample.firstName || 'there')
         .replace(/\{name\}/gi, [sample.firstName, sample.lastName].filter(Boolean).join(' ') || 'there')
    : '';
}

async function sendSegmentCampaign(bypassWeeklyGuard = false) {
  const message = document.getElementById('camp-message').value.trim();
  if (!message)                       { toast('Message is empty.', 'error'); return; }
  if (!_campSegmentRecipients.length) { toast('No recipients.', 'warn');    return; }
  const apiKey = db.settings.cellcastKey;
  const sender = db.settings.cellcastSender || null;
  if (!apiKey) { alert('Set your Cellcast API key in Settings first.'); return; }

  const segName = document.getElementById('camp-segment-select').value;
  const label   = segName === '__all__' ? 'All customers' : segName === '__selected__' ? 'Selected' : `Segment: ${segName}`;

  if (!bypassWeeklyGuard && !confirm(`Send to ${_campSegmentRecipients.length} recipients (${label})?`)) return;

  const btn = document.getElementById('camp-send-btn');
  btn.disabled = true; btn.textContent = '⏳ Sending…';

  try {
    const recipients = _campSegmentRecipients.map(c => ({
      number: c.phone,
      firstName: c.firstName || '',
      name: [c.firstName, c.lastName].filter(Boolean).join(' '),
    }));
    const resp = await fetch('/api/cellcast-send', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ apiKey, sender, recipients, message, bypassWeeklyGuard, segment: label }),
    });
    const data = await resp.json();
    if (!resp.ok) {
      const err = data.error || 'Send failed';
      if (err.startsWith('WEEKLY_GUARD:')) {
        const count = err.split(':')[1];
        btn.disabled = false; btn.textContent = '📤 Send Campaign';
        if (confirm(`⚠️ ${count} recipient(s) were already texted in the last 7 days.\n\nSend anyway?`))
          sendSegmentCampaign(true);
        return;
      }
      throw new Error(err);
    }

    await loadDB();
    closeCampaignCompose();
    toast(`Sent to ${recipients.length} recipients.`);
    renderCampaigns();
  } catch(e) {
    toast('Send failed: ' + e.message, 'error');
  } finally {
    btn.disabled = false; btn.textContent = '📤 Send Campaign';
  }
}

// ── CAMPAIGN HISTORY ──────────────────────────────────────────────────────────
function renderCampaigns() {
  const tb = document.getElementById('camp-table');
  if (!db.campaigns.length) {
    tb.innerHTML = '<tr><td colspan="5" style="text-align:center;color:var(--muted);padding:32px">No campaigns yet. Select customers and click "Send SMS".</td></tr>';
    return;
  }

  tb.innerHTML = db.campaigns.map(c => `<tr>
    <td style="white-space:nowrap">${fmtDate(c.date)}<div class="muted" style="font-size:.75rem">${new Date(c.date).toLocaleTimeString(undefined,{hour:'2-digit',minute:'2-digit'})}</div></td>
    <td><span class="muted" style="font-size:.78rem">${c.segment || '—'}</span></td>
    <td style="max-width:260px;word-break:break-word;font-size:.82rem">${c.message}</td>
    <td><span class="badge bg">${c.recipientCount} sent</span></td>
    <td><span class="badge bb">${c.sender}</span></td>
    <td><button class="btn btn-ghost btn-sm" onclick="viewCampaign('${c.id}')">View</button></td>
  </tr>`).join('');
}

function viewCampaign(id) {
  const c = db.campaigns.find(x => x.id === id);
  if (!c) return;
  document.getElementById('camp-view-date').textContent    = fmtDate(c.date);
  document.getElementById('camp-view-message').textContent = c.message;
  document.getElementById('camp-view-sender').textContent  = c.sender;
  document.getElementById('camp-view-numbers').innerHTML   = (c.recipients || []).map(n => `<div class="muted" style="font-size:.78rem">${n}</div>`).join('');
  openModal('modal-camp-view');
}
