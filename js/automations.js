// ── AUTOMATIONS ────────────────────────────────────────────────────────────────

// ── Queue calculation (client-side) ───────────────────────────────────────────
function getAutomationQueue(auto) {
  const now     = new Date();
  const optOuts = db.optOuts || [];
  const sentTo  = auto.sentTo || {};
  const log     = db.smsLog  || [];

  function sentThisVisit(phone, triggerType, visitDate) {
    return log.some(e =>
      e.phone === phone &&
      e.triggerType === triggerType &&
      e.visitReferenceDate === visitDate &&
      e.status === 'sent'
    );
  }

  return db.customers.filter(c => {
    if (!c.phone || optOuts.includes(c.phone)) return false;
    if ((c.segment || classifyCustomer(c)) === 'Dead') return false;

    switch (auto.id) {
      case 'welcome': {
        if ((c.visits || 0) !== 0) return false;
        if (!c.createdAt) return false;
        const days = (now - new Date(c.createdAt)) / 86400000;
        const minDays = auto.config.minDaysSinceJoined || 7;
        const maxDays = auto.config.maxDaysSinceFirstVisit || 30;
        if (days < minDays || days > maxDays) return false;
        return !sentTo[c.phone];
      }
      case 'loyalty_ready': {
        const pts = c.loyaltyPoints || 0;
        if (pts < (auto.config.pointsThreshold || 5)) return false;
        if (!c.lastVisit) return false;
        const daysSince = (now - new Date(c.lastVisit)) / 86400000;
        const minDays   = auto.config.minDaysSinceVisit || 21;
        if (daysSince < minDays || daysSince >= (auto.config.winbackMinDays || 90)) return false;
        return !sentThisVisit(c.phone, 'loyalty_ready', c.lastVisit);
      }
      case 'loyalty_near': {
        const pts       = c.loyaltyPoints || 0;
        const threshold = auto.config.pointsThreshold || 5;
        const near      = auto.config.nearWithin || 1;
        if (pts >= threshold || pts < threshold - near) return false;
        if (!c.lastVisit) return false;
        const daysSince = (now - new Date(c.lastVisit)) / 86400000;
        const minDays   = auto.config.minDaysSinceVisit || 21;
        if (daysSince < minDays || daysSince >= (auto.config.winbackMinDays || 90)) return false;
        return !sentThisVisit(c.phone, 'loyalty_near', c.lastVisit);
      }
      case 'winback': {
        if (!c.lastVisit) return false;
        const days = (now - new Date(c.lastVisit)) / 86400000;
        if (days < (auto.config.minDays || 90) || days > (auto.config.maxDays || 365)) return false;
        return !sentThisVisit(c.phone, 'winback', c.lastVisit);
      }
      case 'last_chance': {
        const winbackEntry = log
          .filter(e => e.phone === c.phone && e.triggerType === 'winback' && e.status === 'sent')
          .sort((a, b) => new Date(b.sentAt) - new Date(a.sentAt))[0];
        if (!winbackEntry) return false;
        if ((now - new Date(winbackEntry.sentAt)) / 86400000 < (auto.config.daysSinceWinback || 90)) return false;
        if (c.lastVisit && new Date(c.lastVisit) > new Date(winbackEntry.sentAt)) return false;
        return !sentThisVisit(c.phone, 'last_chance', winbackEntry.visitReferenceDate);
      }
      case 'birthday': {
        if (!c.birthday) return false;
        const parts  = c.birthday.split('-');
        const bMonth = parts.length === 3 ? parseInt(parts[1]) - 1 : parseInt(parts[0]) - 1;
        if (bMonth !== now.getMonth()) return false;
        return !sentTo[`${c.phone}_${now.getFullYear()}`];
      }
      default: return false;
    }
  });
}

function personalizePreview(template, customer, auto) {
  const threshold = (auto.config && auto.config.pointsThreshold) || 100;
  const pts = customer.loyaltyPoints || 0;
  return template
    .replace(/\{first_name\}/gi, customer.firstName || 'there')
    .replace(/\{name\}/gi, [customer.firstName, customer.lastName].filter(Boolean).join(' ') || 'there')
    .replace(/\{loyalty_points\}/gi, pts)
    .replace(/\{points_needed\}/gi, Math.max(0, threshold - pts));
}

function escHtml(s) {
  return String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

// ── Render ─────────────────────────────────────────────────────────────────────
function renderAutomations() {
  const page = document.getElementById('auto-cards');
  if (!page) return;

  const automations = db.automations || [];
  if (!automations.length) {
    page.innerHTML = '<div class="muted" style="text-align:center;padding:32px">No automations found. Try reloading.</div>';
    return;
  }

  page.innerHTML = automations.map(auto => buildAutoCard(auto)).join('');
  renderSmsLog();
}

function buildAutoCard(auto) {
  const queue       = getAutomationQueue(auto);
  const statusColor = auto.enabled ? 'var(--accent2)' : 'var(--muted)';
  const lastRunStr  = auto.lastRunAt
    ? `${fmtDate(auto.lastRunAt)} — Sent: ${(auto.lastRunStats && auto.lastRunStats.sent) || 0}, Skipped: ${(auto.lastRunStats && auto.lastRunStats.skipped) || 0}`
    : 'Never run';

  // Config section per automation type
  let configHtml = '';
  if (auto.id === 'welcome') {
    configHtml = `
      <div class="form-row" style="margin-bottom:0">
        <label class="label">Send between days after joining</label>
        <div style="display:flex;align-items:center;gap:8px">
          <input class="input" style="width:80px" type="number" min="1" max="365"
            id="auto-cfg-${auto.id}-minDays" value="${auto.config.minDaysSinceJoined || 7}"
            onchange="saveAutoConfig('${auto.id}')">
          <span class="muted">and</span>
          <input class="input" style="width:80px" type="number" min="1" max="365"
            id="auto-cfg-${auto.id}-maxDays" value="${auto.config.maxDaysSinceFirstVisit || 30}"
            onchange="saveAutoConfig('${auto.id}')">
          <span class="muted">days</span>
        </div>
      </div>`;
  } else if (auto.id === 'loyalty_ready') {
    configHtml = `
      <div style="display:flex;gap:16px;flex-wrap:wrap">
        <div class="form-row" style="margin-bottom:0">
          <label class="label">Minimum loyalty points to trigger</label>
          <input class="input" style="width:100px" type="number" min="1"
            id="auto-cfg-${auto.id}-threshold" value="${auto.config.pointsThreshold || 5}"
            onchange="saveAutoConfig('${auto.id}')">
        </div>
        <div class="form-row" style="margin-bottom:0">
          <label class="label">Send X days after visit</label>
          <input class="input" style="width:100px" type="number" min="1" max="89"
            id="auto-cfg-${auto.id}-minDays" value="${auto.config.minDaysSinceVisit || 21}"
            onchange="saveAutoConfig('${auto.id}')">
        </div>
      </div>`;
  } else if (auto.id === 'loyalty_near') {
    configHtml = `
      <div style="display:flex;gap:16px;flex-wrap:wrap">
        <div class="form-row" style="margin-bottom:0">
          <label class="label">Reward threshold (points)</label>
          <input class="input" style="width:100px" type="number" min="1"
            id="auto-cfg-${auto.id}-threshold" value="${auto.config.pointsThreshold || 5}"
            onchange="saveAutoConfig('${auto.id}')">
        </div>
        <div class="form-row" style="margin-bottom:0">
          <label class="label">Notify when within (points)</label>
          <input class="input" style="width:100px" type="number" min="1"
            id="auto-cfg-${auto.id}-nearWithin" value="${auto.config.nearWithin || 1}"
            onchange="saveAutoConfig('${auto.id}')">
        </div>
        <div class="form-row" style="margin-bottom:0">
          <label class="label">Send X days after visit</label>
          <input class="input" style="width:100px" type="number" min="1" max="89"
            id="auto-cfg-${auto.id}-minDays" value="${auto.config.minDaysSinceVisit || 21}"
            onchange="saveAutoConfig('${auto.id}')">
        </div>
      </div>`;
  } else if (auto.id === 'winback') {
    configHtml = `
      <div style="display:flex;gap:16px;flex-wrap:wrap">
        <div class="form-row" style="margin-bottom:0">
          <label class="label">Min days since last visit</label>
          <input class="input" style="width:100px" type="number" min="1"
            id="auto-cfg-${auto.id}-minDays" value="${auto.config.minDays || 60}"
            onchange="saveAutoConfig('${auto.id}')">
        </div>
        <div class="form-row" style="margin-bottom:0">
          <label class="label">Max days since last visit</label>
          <input class="input" style="width:100px" type="number" min="1"
            id="auto-cfg-${auto.id}-maxDays" value="${auto.config.maxDays || 180}"
            onchange="saveAutoConfig('${auto.id}')">
        </div>
      </div>`;
  } else if (auto.id === 'last_chance') {
    configHtml = `
      <div style="display:flex;gap:16px;flex-wrap:wrap">
        <div class="form-row" style="margin-bottom:0">
          <label class="label">Days after win-back SMS</label>
          <input class="input" style="width:100px" type="number" min="1"
            id="auto-cfg-last_chance-daysSinceWinback" value="${auto.config.daysSinceWinback || 90}"
            onchange="saveAutoConfig('last_chance')">
        </div>
        <div class="form-row" style="margin-bottom:0">
          <label class="label">Reward threshold (points)</label>
          <input class="input" style="width:100px" type="number" min="1"
            id="auto-cfg-last_chance-rewardThreshold" value="${auto.config.rewardThreshold || 5}"
            onchange="saveAutoConfig('last_chance')">
        </div>
      </div>`;
  }

  // Build template section — winback and last_chance get two separate message areas
  let templateSectionHtml;
  if (auto.id === 'winback' || auto.id === 'last_chance') {
    const rewardTpl   = auto.templateReward  || '';
    const missYouTpl  = auto.templateMissYou || '';
    const threshold   = auto.config.rewardThreshold || 5;
    const testCust    = (db.customers || []).find(c => c.phone === db.settings.testPhone);
    const rewardSample  = queue.find(c => (c.loyaltyPoints || 0) >= threshold) || testCust;
    const missYouSample = queue.find(c => (c.loyaltyPoints || 0) < threshold)  || testCust;
    const placeholders  = `<div class="muted" style="font-size:.73rem;margin-top:3px">Placeholders: <code>{first_name}</code> <code>{name}</code> <code>{expiry_date}</code></div>`;
    templateSectionHtml = `
      <div class="form-row">
        <div style="display:flex;justify-content:space-between;margin-bottom:4px">
          <label class="label" style="margin:0">🏆 Reward message <span class="muted" style="font-weight:400">(${threshold}+ pts)</span></label>
          <span id="auto-char-${auto.id}-reward" class="muted" style="font-size:.73rem">${rewardTpl.length} / 160</span>
        </div>
        <textarea class="input" rows="3" id="auto-tpl-${auto.id}-reward"
          oninput="onAutoTemplateInput('${auto.id}-reward')"
          onblur="saveAutoTemplate('${auto.id}-reward')"
        >${escHtml(rewardTpl)}</textarea>
        ${placeholders}
      </div>
      <div id="auto-preview-${auto.id}-reward" style="font-size:.8rem;color:var(--muted);font-style:italic;padding:7px 10px;background:var(--surface2);border-radius:6px;margin-bottom:12px${rewardSample ? '' : ';display:none'}">
        ${rewardSample ? `Preview (${escHtml(rewardSample.firstName || '?')}): ${escHtml(personalizePreview(rewardTpl, rewardSample, auto))}` : ''}
      </div>
      <div class="form-row">
        <div style="display:flex;justify-content:space-between;margin-bottom:4px">
          <label class="label" style="margin:0">💔 Last chance message <span class="muted" style="font-weight:400">(less than ${threshold} pts)</span></label>
          <span id="auto-char-${auto.id}-missyou" class="muted" style="font-size:.73rem">${missYouTpl.length} / 160</span>
        </div>
        <textarea class="input" rows="3" id="auto-tpl-${auto.id}-missyou"
          oninput="onAutoTemplateInput('${auto.id}-missyou')"
          onblur="saveAutoTemplate('${auto.id}-missyou')"
        >${escHtml(missYouTpl)}</textarea>
        ${placeholders}
      </div>
      <div id="auto-preview-${auto.id}-missyou" style="font-size:.8rem;color:var(--muted);font-style:italic;padding:7px 10px;background:var(--surface2);border-radius:6px;margin-bottom:12px${missYouSample ? '' : ';display:none'}">
        ${missYouSample ? `Preview (${escHtml(missYouSample.firstName || '?')}): ${escHtml(personalizePreview(missYouTpl, missYouSample, auto))}` : ''}
      </div>`;
  } else {
    const sampleCustomer = queue[0];
    const tplText        = auto.template || '';
    const previewText    = sampleCustomer ? personalizePreview(tplText, sampleCustomer, auto) : '';
    templateSectionHtml = `
      <div class="form-row">
        <div style="display:flex;justify-content:space-between;margin-bottom:4px">
          <label class="label" style="margin:0">Message Template</label>
          <span id="auto-char-${auto.id}" class="muted" style="font-size:.73rem">${tplText.length} / 160</span>
        </div>
        <textarea class="input" rows="3" id="auto-tpl-${auto.id}"
          oninput="onAutoTemplateInput('${auto.id}')"
          onblur="saveAutoTemplate('${auto.id}')"
        >${escHtml(tplText)}</textarea>
        <div class="muted" style="font-size:.73rem;margin-top:3px">
          Placeholders: <code>{first_name}</code> <code>{name}</code>
          <code>{loyalty_points}</code> <code>{points_needed}</code>
        </div>
      </div>
      <div id="auto-preview-${auto.id}" style="font-size:.8rem;color:var(--muted);font-style:italic;padding:7px 10px;background:var(--surface2);border-radius:6px;margin-bottom:12px${sampleCustomer ? '' : ';display:none'}">
        ${sampleCustomer ? `Preview (${escHtml(sampleCustomer.firstName || '?')}): ${escHtml(previewText)}` : ''}
      </div>`;
  }

  return `
    <div class="card auto-card" id="auto-card-${auto.id}">
      <div class="fb" style="margin-bottom:10px">
        <div>
          <div style="font-size:1.05rem;font-weight:600">${auto.icon} ${auto.name}</div>
          <div class="muted" style="margin-top:3px;font-size:.82rem">${auto.description}</div>
        </div>
        <label class="toggle" title="${auto.enabled ? 'Click to disable' : 'Click to enable'}">
          <input type="checkbox" ${auto.enabled ? 'checked' : ''} onchange="toggleAutomation('${auto.id}', this.checked)">
          <span class="toggle-track"></span>
        </label>
      </div>

      <div style="display:flex;gap:8px;align-items:center;margin-bottom:14px;flex-wrap:wrap">
        <span class="badge" style="background:${auto.enabled ? 'rgba(78,205,164,.15)' : 'var(--surface2)'};color:${statusColor};border:1px solid ${statusColor}40">
          ${auto.enabled ? '● Active' : '○ Disabled'}
        </span>
        <span class="badge ${queue.length ? 'bg' : 'bb'}">${queue.length} in queue</span>
        <span class="muted" style="font-size:.75rem">Last run: ${lastRunStr}</span>
      </div>

      ${templateSectionHtml}

      ${configHtml ? `<div style="margin-bottom:14px;padding:12px;background:var(--surface2);border-radius:8px">${configHtml}</div>` : ''}

      <div style="border-top:1px solid var(--border);padding-top:12px">
        <div class="fb">
          <div style="font-size:.82rem">
            <b>${queue.length}</b> customer${queue.length !== 1 ? 's' : ''} ready
            ${queue.length ? `<button class="btn btn-ghost btn-sm" style="margin-left:8px" onclick="toggleAutoQueue('${auto.id}')">▾ Show</button>` : ''}
          </div>
          <div style="display:flex;gap:8px;flex-wrap:wrap">
            ${(auto.id === 'winback' || auto.id === 'last_chance') ? `
              <button class="btn btn-ghost btn-sm" onclick="sendAutoTest('${auto.id}','reward')">📱 Test 🏆</button>
              <button class="btn btn-ghost btn-sm" onclick="sendAutoTest('${auto.id}','missyou')">📱 Test 💔</button>
            ` : `
              <button class="btn btn-ghost btn-sm" onclick="sendAutoTest('${auto.id}')">📱 Test</button>
            `}
            <button id="auto-run-${auto.id}" class="btn btn-primary btn-sm" onclick="runAutomation('${auto.id}')"
              ${!queue.length ? 'disabled title="No customers in queue"' : ''}>
              ▶ Send to Selected (${queue.length})
            </button>
          </div>
        </div>

        <div id="auto-queue-${auto.id}" style="display:none;margin-top:10px;max-height:220px;overflow-y:auto">
          ${queue.length === 0
            ? '<div class="muted" style="font-size:.78rem;padding:8px 0">No customers currently match this automation\'s conditions.</div>'
            : `<div style="display:flex;justify-content:space-between;align-items:center;padding:4px 0 6px;border-bottom:1px solid var(--border);margin-bottom:2px">
                <label style="font-size:.75rem;color:var(--muted);cursor:pointer;display:flex;align-items:center;gap:6px">
                  <input type="checkbox" id="auto-chk-all-${auto.id}" checked onchange="toggleAllQueueChecks('${auto.id}', this.checked)">
                  Select all
                </label>
                <span id="auto-sel-count-${auto.id}" class="muted" style="font-size:.75rem">${queue.length} selected</span>
              </div>` +
            `<input class="input" type="text" placeholder="Search name or phone…" style="margin-bottom:6px;padding:4px 8px;font-size:.78rem"
                oninput="filterAutoQueue('${auto.id}', this.value)">` +
            queue.slice(0, 100).map(c => {
              const name = [c.firstName, c.lastName].filter(Boolean).join(' ') || '?';
              return `<div class="auto-queue-row-${auto.id}" data-search="${escHtml((name + ' ' + c.phone).toLowerCase())}"
                style="font-size:.78rem;padding:5px 0;border-bottom:1px solid var(--border);display:flex;gap:8px;align-items:center;flex-wrap:wrap">
                <input type="checkbox" class="auto-queue-chk-${auto.id}" data-phone="${escHtml(c.phone)}" checked onchange="onQueueCheckChange('${auto.id}')">
                <span style="font-weight:500">${escHtml(name)}</span>
                <span class="muted">${escHtml(c.phone)}</span>
                ${c.loyaltyPoints != null ? `<span class="badge bg">${c.loyaltyPoints} pts</span>` : ''}
                ${c.visits        != null ? `<span class="muted">${c.visits} visits</span>` : ''}
                ${c.lastVisit              ? `<span class="muted">last: ${fmtDate(c.lastVisit)}</span>` : ''}
              </div>`;
            }).join('') +
            (queue.length > 100 ? `<div class="muted" style="padding:6px 0;font-size:.75rem">…and ${queue.length - 100} more (showing first 100)</div>` : '')}
        </div>
      </div>

      <div id="auto-result-${auto.id}" style="display:none;margin-top:10px;font-size:.82rem;padding:8px 12px;border-radius:6px;background:var(--surface2)"></div>
    </div>`;
}

function toggleAutoQueue(id) {
  const el = document.getElementById(`auto-queue-${id}`);
  if (el) el.style.display = el.style.display === 'none' ? 'block' : 'none';
}

function toggleAllQueueChecks(id, checked) {
  document.querySelectorAll(`.auto-queue-chk-${id}`).forEach(cb => cb.checked = checked);
  onQueueCheckChange(id);
}

function onQueueCheckChange(id) {
  const checked = [...document.querySelectorAll(`.auto-queue-chk-${id}:checked`)];
  const total   = document.querySelectorAll(`.auto-queue-chk-${id}`).length;
  const countEl = document.getElementById(`auto-sel-count-${id}`);
  const runBtn  = document.getElementById(`auto-run-${id}`);
  const allChk  = document.getElementById(`auto-chk-all-${id}`);
  if (countEl) countEl.textContent = `${checked.length} selected`;
  if (runBtn)  {
    runBtn.textContent = `▶ Send to Selected (${checked.length})`;
    runBtn.disabled    = checked.length === 0;
  }
  if (allChk) allChk.checked = checked.length === total;
}

function getSelectedPhones(id) {
  return [...document.querySelectorAll(`.auto-queue-chk-${id}:checked`)].map(cb => cb.dataset.phone);
}

function filterAutoQueue(id, term) {
  const q = term.trim().toLowerCase();
  document.querySelectorAll(`.auto-queue-row-${id}`).forEach(row => {
    row.style.display = (!q || row.dataset.search.includes(q)) ? '' : 'none';
  });
}

function onAutoTemplateInput(key) {
  // key is either an auto.id (e.g. 'welcome') or a winback variant ('winback-reward', 'winback-missyou')
  const tpl    = document.getElementById(`auto-tpl-${key}`);
  const charEl = document.getElementById(`auto-char-${key}`);
  if (!tpl || !charEl) return;
  const len = tpl.value.length;
  charEl.textContent = `${len} / 160`;
  charEl.style.color = len > 160 ? 'var(--danger)' : len > 144 ? 'var(--warn)' : 'var(--muted)';

  const isDual = key.endsWith('-reward') || key.endsWith('-missyou');
  const autoId = isDual ? key.replace(/-reward$|-missyou$/, '') : key;
  const auto      = getAutoById(autoId);
  const previewEl = document.getElementById(`auto-preview-${key}`);
  if (!auto || !previewEl) return;
  const queue     = getAutomationQueue(auto);
  if (key.endsWith('-reward')) {
    const threshold = auto.config.rewardThreshold || 5;
    const sample = queue.find(c => (c.loyaltyPoints || 0) >= threshold);
    if (sample) previewEl.textContent = `Preview (${sample.firstName || '?'}): ${personalizePreview(tpl.value, sample, auto)}`;
  } else if (key.endsWith('-missyou')) {
    const threshold = auto.config.rewardThreshold || 5;
    const sample = queue.find(c => (c.loyaltyPoints || 0) < threshold);
    if (sample) previewEl.textContent = `Preview (${sample.firstName || '?'}): ${personalizePreview(tpl.value, sample, auto)}`;
  } else {
    const sample = queue[0];
    if (sample) previewEl.textContent = `Preview (${sample.firstName || '?'}): ${personalizePreview(tpl.value, sample, auto)}`;
  }
}

// ── Helpers ────────────────────────────────────────────────────────────────────
function getAutoById(id) {
  return (db.automations || []).find(a => a.id === id);
}

// ── Save / toggle ──────────────────────────────────────────────────────────────
async function toggleAutomation(id, enabled) {
  const auto = getAutoById(id);
  if (!auto) return;
  auto.enabled = enabled;
  await saveDB();
  toast(`${auto.name} ${enabled ? 'enabled' : 'disabled'}.`);
  renderAutomations();
}

async function saveAutoTemplate(key) {
  const isDual = key.endsWith('-reward') || key.endsWith('-missyou');
  const autoId = isDual ? key.replace(/-reward$|-missyou$/, '') : key;
  const auto   = getAutoById(autoId);
  const tpl    = document.getElementById(`auto-tpl-${key}`);
  if (!auto || !tpl) return;
  if (key.endsWith('-reward')) {
    if (auto.templateReward === tpl.value) return;
    auto.templateReward = tpl.value;
  } else if (key.endsWith('-missyou')) {
    if (auto.templateMissYou === tpl.value) return;
    auto.templateMissYou = tpl.value;
  } else {
    if (auto.template === tpl.value) return;
    auto.template = tpl.value;
  }
  await saveDB();
  toast('Template saved.');
}

async function saveAutoConfig(id) {
  const auto = getAutoById(id);
  if (!auto) return;

  if (id === 'welcome') {
    auto.config.minDaysSinceJoined     = parseInt(document.getElementById(`auto-cfg-${id}-minDays`)?.value)    || 7;
    auto.config.maxDaysSinceFirstVisit = parseInt(document.getElementById(`auto-cfg-${id}-maxDays`)?.value)    || 30;
  } else if (id === 'loyalty_ready') {
    auto.config.pointsThreshold        = parseInt(document.getElementById(`auto-cfg-${id}-threshold`)?.value)  || 5;
    auto.config.minDaysSinceVisit      = parseInt(document.getElementById(`auto-cfg-${id}-minDays`)?.value)    || 21;
  } else if (id === 'loyalty_near') {
    auto.config.pointsThreshold        = parseInt(document.getElementById(`auto-cfg-${id}-threshold`)?.value)  || 5;
    auto.config.nearWithin             = parseInt(document.getElementById(`auto-cfg-${id}-nearWithin`)?.value) || 1;
    auto.config.minDaysSinceVisit      = parseInt(document.getElementById(`auto-cfg-${id}-minDays`)?.value)    || 21;
  } else if (id === 'winback') {
    auto.config.minDays                = parseInt(document.getElementById(`auto-cfg-${id}-minDays`)?.value)    || 90;
    auto.config.maxDays                = parseInt(document.getElementById(`auto-cfg-${id}-maxDays`)?.value)    || 365;
  } else if (id === 'last_chance') {
    auto.config.daysSinceWinback       = parseInt(document.getElementById('auto-cfg-last_chance-daysSinceWinback')?.value) || 90;
    auto.config.rewardThreshold        = parseInt(document.getElementById('auto-cfg-last_chance-rewardThreshold')?.value)  || 5;
  }

  await saveDB();
  toast('Config saved.');
  renderAutomations();
}

// ── Test send ──────────────────────────────────────────────────────────────────
async function sendAutoTest(id, variant) {
  if (!db.settings.testPhone)   { alert('Set a Test Phone Number in Settings first.'); return; }
  if (!db.settings.cellcastKey) { alert('Set your Cellcast API key in Settings first.'); return; }

  const auto = getAutoById(id);
  if (!auto) return;

  const isDual = id === 'winback' || id === 'last_chance';
  const body = isDual
    ? { id, test: true, testVariant: variant,
        templateReward:  document.getElementById(`auto-tpl-${id}-reward`)?.value  || auto.templateReward,
        templateMissYou: document.getElementById(`auto-tpl-${id}-missyou`)?.value || auto.templateMissYou }
    : { id, test: true, template: document.getElementById(`auto-tpl-${id}`)?.value || auto.template };

  const resultEl = document.getElementById(`auto-result-${id}`);
  resultEl.style.display = 'block';
  resultEl.style.color   = 'var(--muted)';
  resultEl.textContent   = '⏳ Sending test…';

  try {
    const resp = await fetch('/api/run-automation', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    });
    const data = await resp.json();
    if (!resp.ok) throw new Error(data.error || 'Failed');
    resultEl.style.color = 'var(--accent2)';
    resultEl.textContent = `✓ Test sent to ${db.settings.testPhone}.`;
  } catch(e) {
    resultEl.style.color = 'var(--danger)';
    resultEl.textContent = '✗ ' + e.message;
  }
}

// ── Run now ────────────────────────────────────────────────────────────────────
async function runAutomation(id) {
  const auto = getAutoById(id);
  if (!auto) return;
  const queue = getAutomationQueue(auto);
  if (!queue.length)             { toast('No customers in queue.', 'warn'); return; }
  if (!db.settings.cellcastKey) { alert('Set your Cellcast API key in Settings first.'); return; }
  const selectedPhones = getSelectedPhones(id);
  const sendCount = selectedPhones.length || queue.length;
  if (!confirm(`Send "${auto.name}" to ${sendCount} customer${sendCount !== 1 ? 's' : ''}?\n\nThey will be removed from the queue after sending.`)) return;

  const isDualRun = id === 'winback' || id === 'last_chance';
  const payload = isDualRun
    ? { id, test: false, phones: selectedPhones,
        templateReward:  document.getElementById(`auto-tpl-${id}-reward`)?.value  || auto.templateReward,
        templateMissYou: document.getElementById(`auto-tpl-${id}-missyou`)?.value || auto.templateMissYou }
    : { id, test: false, phones: selectedPhones,
        template: document.getElementById(`auto-tpl-${id}`)?.value || auto.template };

  const resultEl = document.getElementById(`auto-result-${id}`);
  resultEl.style.display = 'block';
  resultEl.style.color   = 'var(--muted)';
  resultEl.textContent   = `⏳ Sending to ${sendCount} customers…`;

  try {
    const resp = await fetch('/api/run-automation', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload),
    });
    const data = await resp.json();
    if (!resp.ok) throw new Error(data.error || 'Failed');

    await loadDB(); // refresh sentTo counts and smsLog
    resultEl.style.color = 'var(--accent2)';
    resultEl.textContent = `✓ Sent to ${data.sent} customer${data.sent !== 1 ? 's' : ''}.`
      + (data.errors && data.errors.length ? ` (${data.errors.length} error${data.errors.length !== 1 ? 's' : ''})` : '');
    renderAutomations();
  } catch(e) {
    resultEl.style.color = 'var(--danger)';
    resultEl.textContent = '✗ ' + e.message;
  }
}

// ── SMS Log table ──────────────────────────────────────────────────────────────
const TRIGGER_LABELS = {
  loyalty_ready: '🏆 Loyalty Ready',
  loyalty_near:  '🎯 Loyalty Near',
  winback:       '💔 Win-back',
  last_chance:   '🚨 Last Chance',
  welcome:       '👋 Welcome',
  birthday:      '🎂 Birthday',
  feedback:      '⭐ Feedback',
};

function renderSmsLog() {
  const el = document.getElementById('sms-log-section');
  if (!el) return;

  const entries = (db.smsLog || []).slice().reverse().slice(0, 200);

  if (!entries.length) {
    el.innerHTML = '<div class="muted" style="font-size:.82rem;padding:8px 0">No SMS automation history yet.</div>';
    return;
  }

  const rows = entries.map(e => {
    const cust = (db.customers || []).find(c => c.phone === e.phone);
    const name = cust ? escHtml([cust.firstName, cust.lastName].filter(Boolean).join(' ') || '?') : escHtml(e.phone);
    const label = TRIGGER_LABELS[e.triggerType] || e.triggerType;
    const statusColor = e.status === 'sent' ? 'var(--accent2)' : 'var(--danger)';
    return `<tr>
      <td style="padding:5px 8px;white-space:nowrap">${fmtDate(e.sentAt)}</td>
      <td style="padding:5px 8px">${name}</td>
      <td style="padding:5px 8px;white-space:nowrap">${escHtml(e.phone)}</td>
      <td style="padding:5px 8px;white-space:nowrap">${label}</td>
      <td style="padding:5px 8px;white-space:nowrap;color:var(--muted)">${e.visitReferenceDate ? fmtDate(e.visitReferenceDate) : '—'}</td>
      <td style="padding:5px 8px;color:${statusColor};white-space:nowrap">${e.status}</td>
      <td style="padding:5px 8px;max-width:260px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;color:var(--muted)" title="${escHtml(e.messageBody || '')}">${escHtml((e.messageBody || '').slice(0, 60))}${(e.messageBody || '').length > 60 ? '…' : ''}</td>
    </tr>`;
  }).join('');

  el.innerHTML = `
    <div style="margin-top:28px">
      <div style="font-size:1rem;font-weight:600;margin-bottom:10px">📋 SMS Automation Log <span class="muted" style="font-weight:400;font-size:.8rem">(last ${entries.length})</span></div>
      <div style="overflow-x:auto">
        <table style="width:100%;border-collapse:collapse;font-size:.78rem">
          <thead>
            <tr style="border-bottom:1px solid var(--border);color:var(--muted);text-align:left">
              <th style="padding:5px 8px;white-space:nowrap">Sent</th>
              <th style="padding:5px 8px">Customer</th>
              <th style="padding:5px 8px">Phone</th>
              <th style="padding:5px 8px">Trigger</th>
              <th style="padding:5px 8px;white-space:nowrap">Visit date</th>
              <th style="padding:5px 8px">Status</th>
              <th style="padding:5px 8px">Message preview</th>
            </tr>
          </thead>
          <tbody>${rows}</tbody>
        </table>
      </div>
    </div>`;
}

