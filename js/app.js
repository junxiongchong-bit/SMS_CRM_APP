// ── STATE ─────────────────────────────────────────────────────────────────────
let db = { customers: [], campaigns: [], optOuts: [], settings: {}, segments: [] };

const DEFAULT_SEGMENTS = [
  { id: 's1', name: 'VIP',       color: '#ffd700', conditionMode: 'AND', priority: 1,
    conditions: [{ field: 'visits', op: '>=', value: 10 }, { field: 'lifetimeSpend', op: '>=', value: 300 }] },
  { id: 's2', name: 'Regular',   color: '#4ecda4', conditionMode: 'OR',  priority: 2,
    conditions: [{ field: 'visits', op: '>=', value: 5 }, { field: 'lifetimeSpend', op: '>=', value: 150 }] },
  { id: 's3', name: 'Lapsed',    color: '#f5a623', conditionMode: 'AND', priority: 3,
    conditions: [{ field: 'visits', op: '>=', value: 3 }, { field: 'daysSinceLastVisit', op: '>=', value: 60 }, { field: 'daysSinceLastVisit', op: '<=', value: 180 }] },
  { id: 's4', name: 'New',       color: '#4e9eff', conditionMode: 'AND', priority: 4,
    conditions: [{ field: 'daysSinceJoined', op: '<=', value: 30 }] },
  { id: 's5', name: 'Lost',      color: '#ff5c5c', conditionMode: 'AND', priority: 5,
    conditions: [{ field: 'daysSinceLastVisit', op: '>', value: 180 }] },
  { id: 's6', name: 'One-time',  color: '#8899bb', conditionMode: 'AND', priority: 6,
    conditions: [{ field: 'visits', op: '<=', value: 1 }] },
  { id: 's7', name: 'Occasional',color: '#6b7a99', conditionMode: 'AND', priority: 7,
    conditions: [{ field: 'visits', op: '>=', value: 2 }] },
];

const DEFAULT_AUTOMATIONS = [
  {
    id: 'welcome', name: 'Welcome / First Visit', icon: '👋',
    description: 'Sends to new customers shortly after their first visit — great for feedback or encouraging a return visit.',
    enabled: false,
    template: 'Hi {first_name}! Thanks for visiting us for the first time 🎉 We\'d love to hear how your experience was — your feedback means a lot to us!',
    config: { minDaysSinceJoined: 7, maxDaysSinceFirstVisit: 30 },
    sentTo: {}, lastRunAt: null, lastRunStats: null,
  },
  {
    id: 'loyalty_ready', name: 'Loyalty Reward Ready', icon: '🎁',
    description: 'Notifies customers when they have enough points to redeem a reward.',
    enabled: false,
    template: 'Hi {first_name}! Great news — you have {loyalty_points} loyalty points at Woodpeckers, enough for a free Margherita or $10 off! Come in and treat yourself 🍕',
    config: { pointsThreshold: 100 },
    sentTo: {}, lastRunAt: null, lastRunStats: null,
  },
  {
    id: 'loyalty_near', name: 'Loyalty Almost There', icon: '⭐',
    description: 'Encourages customers who are just a visit or two away from earning their next reward.',
    enabled: false,
    template: 'Hi {first_name}! You\'re so close — just {points_needed} more points at Woodpeckers to earn a free reward! Pop in soon 🍕',
    config: { pointsThreshold: 100, nearWithin: 20 },
    sentTo: {}, lastRunAt: null, lastRunStats: null,
  },
  {
    id: 'winback', name: 'Win-back', icon: '💌',
    description: 'Re-engages lapsed customers who haven\'t visited in a while. Sends a reward reminder to customers with 5+ pts, and a special offer to everyone else.',
    enabled: false,
    templateReward:  'Hi {first_name}! We miss you at Woodpeckers Murdoch! You still have a Birdies reward waiting — don\'t let it go to waste. Come back and claim it soon! Reply STOP to unsubscribe.',
    templateMissYou: 'Hi {first_name}! It\'s been a while — we miss you! Show this message to our staff for $8 OFF any pizza, in-store only. Valid until {expiry_date}. Woodpeckers Murdoch. Reply STOP to unsubscribe.',
    config: { minDays: 90, maxDays: 365, rewardThreshold: 5 },
    sentTo: {}, lastRunAt: null, lastRunStats: null,
  },
  {
    id: 'last_chance', name: 'Last Chance', icon: '🚨',
    description: 'Final re-engagement sent 90 days after the win-back SMS. Reward reminder for 5+ pts customers, 50% off offer for everyone else.',
    enabled: false,
    templateReward:  'Hi {first_name}! We really miss you at Woodpeckers Murdoch! Your Birdies reward is still waiting — come back and treat yourself. Reply STOP to unsubscribe.',
    templateMissYou: 'Hi {first_name}! We miss you! 50% OFF any pizza — show to staff, in-store only. Valid til {expiry_date}. Woodpeckers Murdoch. Reply STOP to opt out.',
    config: { daysSinceWinback: 90, rewardThreshold: 5 },
    sentTo: {}, lastRunAt: null, lastRunStats: null,
  },
  {
    id: 'birthday', name: 'Birthday', icon: '🎂',
    description: 'Sends a birthday offer to customers whose birthday falls this month. Fires once per year per customer.',
    enabled: false,
    template: 'Happy birthday {first_name}! 🎂 Everyone at Woodpeckers wants to celebrate with you — enjoy a free dessert on us this month. Come in and claim it!',
    config: {},
    sentTo: {}, lastRunAt: null, lastRunStats: null,
  },
];

// ── DB (server-side) ──────────────────────────────────────────────────────────
async function loadDB() {
  try {
    const r = await fetch('/api/data');
    db = await r.json();
    db.customers   = db.customers  || [];
    db.campaigns   = db.campaigns  || [];
    db.optOuts     = db.optOuts    || [];
    db.settings    = db.settings   || {};
    db.segments    = (db.segments    && db.segments.length)    ? db.segments    : JSON.parse(JSON.stringify(DEFAULT_SEGMENTS));
    if (db.automations && db.automations.length) {
      const FILL = ['name', 'icon', 'description', 'template', 'templateReward', 'templateMissYou', 'enabled'];
      for (const auto of db.automations) {
        const def = DEFAULT_AUTOMATIONS.find(d => d.id === auto.id);
        if (!def) continue;
        for (const f of FILL) { if (auto[f] == null && def[f] != null) auto[f] = def[f]; }
      }
    } else {
      db.automations = JSON.parse(JSON.stringify(DEFAULT_AUTOMATIONS));
    }
  } catch(e) { console.error('loadDB failed', e); }
}

async function saveDB() {
  try {
    await fetch('/api/data', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(db) });
  } catch(e) { console.error('saveDB failed', e); }
}

// ── UTILS ─────────────────────────────────────────────────────────────────────
function uid() { return Date.now().toString(36) + Math.random().toString(36).slice(2, 6); }

function toast(msg, type = 'ok') {
  const el = document.createElement('div');
  el.className = 'toast';
  el.style.borderColor = type === 'error' ? 'var(--danger)' : type === 'warn' ? 'var(--warn)' : 'var(--accent2)';
  el.textContent = msg;
  document.body.appendChild(el);
  setTimeout(() => el.remove(), 3000);
}

function openModal(id)  { document.getElementById(id).classList.add('open'); }
function closeModal(id) { document.getElementById(id).classList.remove('open'); }

function fmtDate(iso) {
  if (!iso) return '—';
  return new Date(iso).toLocaleDateString(undefined, { year: 'numeric', month: 'short', day: 'numeric' });
}

function fmtDateTimePerth(iso) {
  if (!iso) return 'Never';
  return new Date(iso).toLocaleString('en-AU', {
    timeZone: 'Australia/Perth',
    day: 'numeric', month: 'short', year: 'numeric',
    hour: '2-digit', minute: '2-digit', hour12: true
  });
}

function fmtBirthday(raw) {
  if (!raw) return '<span class="muted">—</span>';
  // Square format: MM-DD or YYYY-MM-DD (year may be 0000)
  const parts = raw.split('-');
  const [month, day] = parts.length === 2 ? [parseInt(parts[0]), parseInt(parts[1])] : [parseInt(parts[1]), parseInt(parts[2])];
  if (!month || !day) return '<span class="muted">—</span>';
  const d = new Date(2000, month - 1, day);
  return d.toLocaleDateString(undefined, { month: 'short', day: 'numeric' });
}

function fmtCurrency(cents) {
  if (!cents) return '—';
  return '$' + (cents / 100).toFixed(2).replace(/\B(?=(\d{3})+(?!\d))/g, ',');
}

function fmtPhone(p) {
  if (!p) return '';
  // Normalise to E.164 Australian format
  const d = p.replace(/\D/g, '');
  if (d.startsWith('61')) return '+' + d;
  if (d.startsWith('0'))  return '+61' + d.slice(1);
  return '+61' + d;
}

// ── NAVIGATION ────────────────────────────────────────────────────────────────
function goPage(id, btn) {
  document.querySelectorAll('.page').forEach(p => p.classList.remove('active'));
  document.querySelectorAll('nav button.nav-tab').forEach(b => b.classList.remove('active'));
  document.getElementById('page-' + id).classList.add('active');
  if (btn) btn.classList.add('active');
  ({ customers: renderCustomers, campaigns: renderCampaigns, segments: renderSegments, automations: renderAutomations, replies: renderReplies, feedback: renderFeedback, settings: renderSettings })[id]?.();
}

// ── SETTINGS ─────────────────────────────────────────────────────────────────
function onSenderTypeChange() {
  const isName = document.getElementById('set-sender-type').value === 'name';
  document.getElementById('set-sender-name-row').style.display = isName ? 'block' : 'none';
}

async function renderSmsPayloads() {
  const el = document.getElementById('sms-payload-list');
  if (!el) return;
  el.innerHTML = '<div class="muted" style="text-align:center;padding:16px">Loading…</div>';
  try {
    const payloads = await fetch('/api/sms-payloads').then(r => r.json());
    if (!payloads.length) {
      el.innerHTML = '<div class="muted" style="text-align:center;padding:24px">No inbound payloads received yet.</div>';
      return;
    }
    el.innerHTML = `<table style="width:100%;border-collapse:collapse;font-size:.82rem">
      <thead><tr style="border-bottom:1px solid var(--border)">
        <th style="text-align:left;padding:6px 8px;white-space:nowrap">Received (Perth)</th>
        <th style="text-align:left;padding:6px 8px">From</th>
        <th style="text-align:left;padding:6px 8px">Type</th>
        <th style="text-align:left;padding:6px 8px">Message</th>
        <th style="text-align:left;padding:6px 8px">Raw</th>
      </tr></thead>
      <tbody>${payloads.map(p => {
        const r = p.raw || {};
        const from = r.sender || r.from || r.source || r.mobile || r.msisdn || '—';
        const msg  = r.reply   || r.body || r.text || r.msg || r.content || r.message || '—';
        const type = r.type || '—';
        const time = fmtDateTimePerth(p.receivedAt);
        return `<tr style="border-bottom:1px solid var(--border)">
          <td style="padding:6px 8px;white-space:nowrap">${time}</td>
          <td style="padding:6px 8px;white-space:nowrap">${from}</td>
          <td style="padding:6px 8px"><span class="badge bg">${type}</span></td>
          <td style="padding:6px 8px">${msg}</td>
          <td style="padding:6px 8px"><details><summary class="muted" style="cursor:pointer;font-size:.75rem">show</summary><pre style="font-size:.72rem;white-space:pre-wrap;word-break:break-all;margin:4px 0">${JSON.stringify(r, null, 2)}</pre></details></td>
        </tr>`;
      }).join('')}</tbody></table>`;
  } catch(e) {
    el.innerHTML = `<div class="muted" style="text-align:center;padding:16px;color:var(--danger)">Failed: ${e.message}</div>`;
  }
}

async function renderSquarePayloads() {
  const el = document.getElementById('square-payload-list');
  if (!el) return;
  el.innerHTML = '<div class="muted" style="text-align:center;padding:16px">Loading…</div>';
  try {
    const payloads = await fetch('/api/webhook-payloads').then(r => r.json());
    if (!payloads.length) {
      el.innerHTML = '<div class="muted" style="text-align:center;padding:24px">No Square webhook payloads received yet.</div>';
      return;
    }
    el.innerHTML = `<table style="width:100%;border-collapse:collapse;font-size:.82rem">
      <thead><tr style="border-bottom:1px solid var(--border)">
        <th style="text-align:left;padding:6px 8px;white-space:nowrap">Received (Perth)</th>
        <th style="text-align:left;padding:6px 8px">Event Type</th>
        <th style="text-align:left;padding:6px 8px">Raw</th>
      </tr></thead>
      <tbody>${payloads.map(p => {
        const time = fmtDateTimePerth(p.receivedAt);
        return `<tr style="border-bottom:1px solid var(--border)">
          <td style="padding:6px 8px;white-space:nowrap">${time}</td>
          <td style="padding:6px 8px"><span class="badge bg">${p.type || '—'}</span></td>
          <td style="padding:6px 8px"><details><summary class="muted" style="cursor:pointer;font-size:.75rem">show</summary><pre style="font-size:.72rem;white-space:pre-wrap;word-break:break-all;margin:4px 0">${JSON.stringify(p.raw, null, 2)}</pre></details></td>
        </tr>`;
      }).join('')}</tbody></table>`;
  } catch(e) {
    el.innerHTML = `<div class="muted" style="text-align:center;padding:16px;color:var(--danger)">Failed: ${e.message}</div>`;
  }
}

function renderSettings() {
  document.getElementById('set-sq-token').value           = db.settings.squareToken        || '';
  document.getElementById('set-sq-webhook-secret').value  = db.settings.squareWebhookSecret || '';
  document.getElementById('set-cellcast-key').value       = db.settings.cellcastKey         || '';
  document.getElementById('set-cellcast-sender').value    = db.settings.cellcastSender      || '';
  document.getElementById('set-sender-type').value        = db.settings.senderType          || 'shared';
  document.getElementById('set-test-phone').value         = db.settings.testPhone            || '';
  document.getElementById('set-feedback-base-url').value  = db.settings.feedbackBaseUrl      || '';
  document.getElementById('set-send-limit').value         = db.settings.sendLimit            || '';
  document.getElementById('set-sms-cost').value           = db.settings.smsCostCents         || '';
  const crmBase = (db.settings.crmBaseUrl || 'https://crm.woodpeckers.pizza').replace(/\/$/, '');
  document.getElementById('webhook-url-display').textContent = `${crmBase}/api/square-webhook`;
  document.getElementById('set-crm-base-url').value = db.settings.crmBaseUrl || '';
  onSenderTypeChange();
  const limitNote = document.getElementById('safeguard-limit-note');
  if (limitNote) {
    const lim = db.settings.sendLimit;
    limitNote.textContent = lim ? `Currently set to ${lim}.` : 'No limit currently set.';
  }
  renderSyncLogs();
  renderSmsPayloads();
  renderSquarePayloads();
}

async function renderSyncLogs() {
  const el = document.getElementById('sync-log-list');
  if (!el) return;
  el.innerHTML = '<div class="muted" style="text-align:center;padding:16px">Loading…</div>';
  try {
    const r = await fetch('/api/sync-logs');
    const logs = await r.json();
    if (!logs.length) {
      el.innerHTML = '<div class="muted" style="text-align:center;padding:24px">No syncs recorded yet. Auto-sync runs every 6 hours.</div>';
      return;
    }
    el.innerHTML = `
      <table style="width:100%;border-collapse:collapse;font-size:.82rem">
        <thead>
          <tr style="border-bottom:1px solid var(--border)">
            <th style="text-align:left;padding:6px 8px;white-space:nowrap">Date / Time</th>
            <th style="text-align:left;padding:6px 8px">Mode</th>
            <th style="text-align:left;padding:6px 8px">Status</th>
            <th style="text-align:left;padding:6px 8px">Detail</th>
          </tr>
        </thead>
        <tbody>
          ${logs.map(l => {
            const statusColor = l.status === 'ok' ? 'var(--accent2)' : l.status === 'partial' ? 'var(--warn)' : 'var(--danger)';
            const errTip = l.errors && l.errors.length ? ` title="${l.errors.join('; ')}"` : '';
            const modeLabel = l.mode === 'webhook' ? `webhook<br><span class="muted" style="font-size:.75em">${l.event || ''}</span>` : (l.mode || '—');
            const detail = l.mode === 'webhook'
              ? (l.detail || '—')
              : `+${l.customersAdded||0} customers, ${l.loyaltyUpdated||0} loyalty, ${l.visitsUpdated||0} visits`;
            return `<tr style="border-bottom:1px solid var(--border)">
              <td style="padding:6px 8px;white-space:nowrap">
                ${fmtDate(l.date)}<br>
                <span class="muted">${new Date(l.date).toLocaleTimeString(undefined,{hour:'2-digit',minute:'2-digit',second:'2-digit'})}</span>
              </td>
              <td style="padding:6px 8px"><span class="badge bg">${modeLabel}</span></td>
              <td style="padding:6px 8px">
                <span class="badge" style="background:${statusColor}20;color:${statusColor};border:1px solid ${statusColor}40"${errTip}>${l.status}</span>
              </td>
              <td style="padding:6px 8px;color:var(--muted)">${detail}</td>
            </tr>`;
          }).join('')}
        </tbody>
      </table>`;
  } catch(e) {
    el.innerHTML = `<div class="muted" style="text-align:center;padding:16px;color:var(--danger)">Failed to load logs: ${e.message}</div>`;
  }
}

async function saveSettings() {
  const settings = {
    squareToken:         document.getElementById('set-sq-token').value.trim(),
    squareWebhookSecret: document.getElementById('set-sq-webhook-secret').value.trim() || null,
    cellcastKey:         document.getElementById('set-cellcast-key').value.trim(),
    senderType:          document.getElementById('set-sender-type').value,
    cellcastSender:      document.getElementById('set-sender-type').value === 'name'
                           ? document.getElementById('set-cellcast-sender').value.trim()
                           : null,
    testPhone:           document.getElementById('set-test-phone').value.trim(),
    feedbackBaseUrl:     document.getElementById('set-feedback-base-url').value.trim(),
    crmBaseUrl:          document.getElementById('set-crm-base-url').value.trim().replace(/\/$/, '') || null,
    sendLimit:           parseInt(document.getElementById('set-send-limit').value) || null,
    smsCostCents:        parseInt(document.getElementById('set-sms-cost').value) || 9,
  };
  try {
    const r = await fetch('/api/settings', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(settings),
    });
    const data = await r.json();
    if (!r.ok) throw new Error(data.error || 'Save failed');
    Object.assign(db.settings, settings);
    toast('Settings saved.');
  } catch(e) {
    toast('Save failed: ' + e.message, 'error');
  }
}

// ── INIT ──────────────────────────────────────────────────────────────────────
(async () => {
  await loadDB();
  renderCustomers();
})();
