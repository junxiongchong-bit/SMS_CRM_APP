const http   = require('http');
const https  = require('https');
const fs     = require('fs');
const path   = require('path');
const crypto = require('crypto');

const PORT         = 3001;
const DB_FILE      = path.join(__dirname, 'data', 'db.json');
const OVERLAY_FILE = path.join(__dirname, 'data', 'crm_overlay.json');
const PAYLOAD_FILE = path.join(__dirname, 'data', 'payloads.json');
const PAYLOAD_TTL  = 7 * 24 * 60 * 60 * 1000; // 7 days in ms
let fullRescanJob = { status: 'idle', step: '', result: null };

const MIME = { '.html': 'text/html', '.css': 'text/css', '.js': 'application/javascript', '.json': 'application/json' };
const CORS = { 'Access-Control-Allow-Origin': '*', 'Access-Control-Allow-Methods': 'GET, POST, OPTIONS', 'Access-Control-Allow-Headers': 'Content-Type' };

function uid() { return Date.now().toString(36) + Math.random().toString(36).slice(2, 6); }

// Normalize birthday to MM-DD or YYYY-MM-DD regardless of source format
const MONTH_NAMES = ['january','february','march','april','may','june','july','august','september','october','november','december'];
function normalizeBirthday(raw) {
  if (!raw) return '';
  const s = raw.trim();
  // Already MM-DD or YYYY-MM-DD
  if (/^\d{2}-\d{2}$/.test(s) || /^\d{4}-\d{2}-\d{2}$/.test(s)) return s;
  // Square CSV format: "October 16" or "October 16, 1990"
  const textMatch = s.match(/^([A-Za-z]+)\s+(\d{1,2})(?:,\s*(\d{4}))?$/);
  if (textMatch) {
    const mIdx = MONTH_NAMES.indexOf(textMatch[1].toLowerCase());
    if (mIdx !== -1) {
      const mm = String(mIdx + 1).padStart(2, '0');
      const dd = textMatch[2].padStart(2, '0');
      return textMatch[3] ? `${textMatch[3]}-${mm}-${dd}` : `${mm}-${dd}`;
    }
  }
  // MM/DD/YYYY or MM/DD
  const slashMatch = s.match(/^(\d{1,2})\/(\d{1,2})(?:\/(\d{4}))?$/);
  if (slashMatch) {
    const mm = slashMatch[1].padStart(2, '0');
    const dd = slashMatch[2].padStart(2, '0');
    return slashMatch[3] ? `${slashMatch[3]}-${mm}-${dd}` : `${mm}-${dd}`;
  }
  return s;
}

// ── SEND SAFEGUARDS ────────────────────────────────────────────────────────────
// Perth is AWST = UTC+8 (no daylight saving)
function perthHour() {
  return (new Date().getUTCHours() + 8) % 24;
}
function perthDateStr(offsetDays = 0) {
  const d = new Date(Date.now() + 8 * 60 * 60 * 1000);
  d.setUTCDate(d.getUTCDate() + offsetDays);
  return d.toISOString().slice(0, 10);
}
function isWithinSendHours() {
  const h = perthHour();
  return h >= 9 && h < 21;
}
function sentInLastWeek(phone, db) {
  const cutoff = Date.now() - 7 * 24 * 60 * 60 * 1000;
  return (db.campaigns || []).some(c =>
    new Date(c.date).getTime() > cutoff &&
    c.status !== 'failed' &&
    (c.recipients || []).includes(phone)
  );
}
const AU_PHONE_RE = /^\+61[2-9]\d{8}$/;
function isAuPhone(phone) { return AU_PHONE_RE.test(fmtPhone(phone)); }

// Returns { safe: [], blocked: { optOut, tooSoon, duplicate, offHours, nonAu } }
function applyGuards(recipients, db, { skipHoursCheck = false, skipWeeklyGuard = false } = {}) {
  if (!skipHoursCheck && !isWithinSendHours()) {
    return { safe: [], offHours: true, blocked: { optOut: 0, tooSoon: 0, duplicate: 0, offHours: recipients.length, nonAu: 0 } };
  }
  const optOuts = new Set(db.optOuts || []);
  const seen    = new Set();
  const safe    = [];
  let   bOptOut = 0, bTooSoon = 0, bDupe = 0, bNonAu = 0;
  for (const r of recipients) {
    const phone = r.number || r.phone;
    if (!phone) continue;
    if (!isAuPhone(phone))                             { bNonAu++;  continue; }
    if (optOuts.has(phone))                            { bOptOut++;  continue; }
    if (seen.has(phone))                               { bDupe++;    continue; }
    if (!skipWeeklyGuard && sentInLastWeek(phone, db)) { bTooSoon++; continue; }
    seen.add(phone);
    safe.push(r);
  }
  return { safe, offHours: false, blocked: { optOut: bOptOut, tooSoon: bTooSoon, duplicate: bDupe, offHours: 0, nonAu: bNonAu } };
}
function recordSMSSent(db, phone, message, label) {
  const from = fmtPhone(phone);
  const c = db.customers.find(x => x.phone && fmtPhone(x.phone) === from);
  if (!c) return;
  if (!Array.isArray(c.smsSent)) c.smsSent = [];
  c.smsSent.unshift({ message, sentAt: new Date().toISOString(), label: label || '' });
  if (c.smsSent.length > 200) c.smsSent.length = 200;
}
function fmtPhone(p) {
  if (!p) return '';
  const d = p.replace(/\D/g, '');
  if (d.startsWith('610')) return '+61' + d.slice(3); // e.g. 610488070137 → +61488070137 (Square exports sometimes include erroneous 0 after country code)
  if (d.startsWith('61'))  return '+' + d;
  if (d.startsWith('0'))   return '+61' + d.slice(1);
  return '+61' + d;
}

// ── DB (server-side JSON file) ─────────────────────────────────────────────────
function loadDB() {
  // Try primary file
  try { if (fs.existsSync(DB_FILE)) return JSON.parse(fs.readFileSync(DB_FILE, 'utf8')); } catch (e) {
    console.error('[loadDB] db.json corrupted:', e.message, '— trying rolling backups');
  }
  // Fall back to most recent rolling backup (newest first)
  try {
    const backups = fs.readdirSync(path.join(__dirname, 'data'))
      .filter(f => /^db\.backup-.*\.json$/.test(f))
      .sort().reverse();
    for (const f of backups) {
      try {
        const data = JSON.parse(fs.readFileSync(path.join(__dirname, 'data', f), 'utf8'));
        console.warn(`[loadDB] Recovered from backup: ${f}`);
        return data;
      } catch (_) {}
    }
  } catch (_) {}
  console.error('[loadDB] All backups failed — starting with empty DB!');
  return { customers: [], campaigns: [], optOuts: [], settings: {} };
}
let _lastBackupAt = 0;
function saveDB(data) {
  const tmp = DB_FILE + '.tmp';
  fs.writeFileSync(tmp, JSON.stringify(data, null, 2));
  fs.renameSync(tmp, DB_FILE);
  // Rolling hourly backup — at most once per hour, keep last 5
  const now = Date.now();
  if (now - _lastBackupAt >= 60 * 60 * 1000) {
    _lastBackupAt = now;
    try {
      const ts      = new Date().toISOString().replace(/[:.]/g, '-');
      const dest    = path.join(__dirname, 'data', `db.backup-${ts}.json`);
      fs.copyFileSync(DB_FILE, dest);
      const old = fs.readdirSync(path.join(__dirname, 'data'))
        .filter(f => /^db\.backup-.*\.json$/.test(f))
        .sort()
        .slice(0, -5);
      old.forEach(f => fs.unlinkSync(path.join(__dirname, 'data', f)));
    } catch (_) { /* backup failure must never break the save */ }
  }
}
// Serialised DB access — prevents concurrent load→modify→save races.
// All writes go through this queue so only one runs at a time, always on fresh state.
let _dbQueue = Promise.resolve();
function withDB(fn) {
  const step = _dbQueue.then(() => {
    const db = loadDB();
    const r  = fn(db);
    if (r && typeof r.then === 'function') return r.then(() => saveDB(db));
    saveDB(db);
    return r;
  });
  _dbQueue = step.catch(() => {}); // error in one step must not break the queue
  return step;
}

// ── Payload log (separate file, 7-day rolling window) ─────────────────────────
// Stores raw webhook payloads from Square and Cellcast independently of the main
// DB so they survive any main-DB corruption and can be used for replay/debugging.
function loadPayloads() {
  try { if (fs.existsSync(PAYLOAD_FILE)) return JSON.parse(fs.readFileSync(PAYLOAD_FILE, 'utf8')); } catch(e) {}
  return { square: [], cellcast: [] };
}
function savePayloads(data) {
  const tmp = PAYLOAD_FILE + '.tmp';
  fs.writeFileSync(tmp, JSON.stringify(data, null, 2));
  fs.renameSync(tmp, PAYLOAD_FILE);
}
let _payloadQueue = Promise.resolve();
function withPayloads(fn) {
  const step = _payloadQueue.then(() => {
    const p = loadPayloads();
    fn(p);
    // Prune entries older than 7 days before every save, capped at 1000 each
    const cutoff = new Date(Date.now() - PAYLOAD_TTL).toISOString();
    p.square   = (p.square   || []).filter(e => e.receivedAt > cutoff).slice(0, 1000);
    p.cellcast = (p.cellcast || []).filter(e => e.receivedAt > cutoff).slice(0, 1000);
    savePayloads(p);
  });
  _payloadQueue = step.catch(e => console.error('[withPayloads] save failed:', e.message));
  return step;
}

// ── One-time migration: move legacy payload arrays out of db.json ──────────────
function migratePayloadsFromDB() {
  const db = loadDB();
  const hasSquare   = Array.isArray(db.webhookPayloads)      && db.webhookPayloads.length > 0;
  const hasCellcast = Array.isArray(db.smsInboundPayloads)   && db.smsInboundPayloads.length > 0;
  if (!hasSquare && !hasCellcast) return;

  const p      = loadPayloads();
  const cutoff = new Date(Date.now() - PAYLOAD_TTL).toISOString();

  if (hasSquare) {
    const incoming = db.webhookPayloads.filter(e => (e.receivedAt || '') > cutoff);
    p.square = [...incoming, ...(p.square || [])];
    delete db.webhookPayloads;
    console.log(`[Migration] Moved ${incoming.length} Square payload(s) from db.json → payloads.json`);
  }
  if (hasCellcast) {
    const incoming = db.smsInboundPayloads.filter(e => (e.receivedAt || '') > cutoff);
    p.cellcast = [...incoming, ...(p.cellcast || [])];
    delete db.smsInboundPayloads;
    console.log(`[Migration] Moved ${incoming.length} Cellcast payload(s) from db.json → payloads.json`);
  }

  savePayloads(p);
  saveDB(db);
}
// ── Startup: remove any stale .tmp files left by a crash during a write ───────
for (const stale of [DB_FILE + '.tmp', PAYLOAD_FILE + '.tmp', OVERLAY_FILE + '.tmp']) {
  try {
    if (fs.existsSync(stale)) {
      fs.unlinkSync(stale);
      console.warn(`[Startup] Removed stale temp file: ${path.basename(stale)}`);
    }
  } catch (_) {}
}

migratePayloadsFromDB();

// ── ONE-TIME MIGRATION: squareId → squareIds array ─────────────────────────────
function migrateSquareIds() {
  const db = loadDB();
  let migrated = 0;
  for (const c of db.customers) {
    if (!c.squareIds) {
      c.squareIds = c.squareId ? [c.squareId] : [];
      delete c.squareId;
      migrated++;
    }
  }
  if (migrated > 0) { saveDB(db); console.log(`[Migration] squareId → squareIds: ${migrated} customers converted.`); }
}
migrateSquareIds();


// Helper: get squareIds array (handles legacy single-string field)
function getSquareIds(c) { return c.squareIds || (c.squareId ? [c.squareId] : []); }

// Helper: map every squareId → customer across entire DB
function buildSqIdMap(customers) {
  const map = {};
  for (const c of customers) for (const sid of getSquareIds(c)) map[sid] = c;
  return map;
}

// Helper: aggregate visitMap (squareId→data) into per-customer sums
function aggregateVisits(visitMap, sqIdMap) {
  const byCustomer = new Map();
  for (const [sid, v] of Object.entries(visitMap)) {
    const c = sqIdMap[sid];
    if (!c) continue;
    if (!byCustomer.has(c.id)) byCustomer.set(c.id, { count: 0, spend: 0, lastDate: null, customer: c });
    const e = byCustomer.get(c.id);
    e.count += v.count;
    e.spend += v.spend;
    if (v.lastDate && (!e.lastDate || v.lastDate > e.lastDate)) e.lastDate = v.lastDate;
  }
  return byCustomer;
}

// ── SQUARE: fetch all customers (GET with cursor pagination) ───────────────────
function fetchAllSquareCustomers(token, cursor) {
  return new Promise((resolve, reject) => {
    const params = new URLSearchParams({ limit: 100, sort_field: 'CREATED_AT', sort_order: 'DESC' });
    if (cursor) params.set('cursor', cursor);
    const options = {
      hostname: 'connect.squareup.com',
      path: `/v2/customers?${params}`,
      method: 'GET',
      headers: { 'Authorization': `Bearer ${token}`, 'Square-Version': '2025-07-17' },
    };
    const req = https.request(options, res => {
      let data = '';
      res.on('data', c => data += c);
      res.on('end', async () => {
        try {
          const json = JSON.parse(data);
          if (json.errors) return reject(new Error(JSON.stringify(json.errors)));
          const customers = json.customers || [];
          if (json.cursor) {
            const more = await fetchAllSquareCustomers(token, json.cursor);
            resolve(customers.concat(more));
          } else { resolve(customers); }
        } catch(e) { reject(e); }
      });
    });
    req.on('error', reject);
    req.end();
  });
}

// ── SQUARE: fetch ALL loyalty accounts via paginated search (GET list endpoint returns NOT_FOUND) ──
async function fetchAllLoyaltyAccounts(token) {
  const accounts = [];
  let cursor = null;
  do {
    const body = JSON.stringify({ limit: 200, ...(cursor ? { cursor } : {}) });
    const result = await new Promise((resolve, reject) => {
      const options = {
        hostname: 'connect.squareup.com',
        path: `/v2/loyalty/accounts/search`,
        method: 'POST',
        headers: {
          'Authorization': `Bearer ${token}`,
          'Square-Version': '2024-01-18',
          'Content-Type': 'application/json',
          'Content-Length': Buffer.byteLength(body),
        },
      };
      const req = https.request(options, res => {
        let data = '';
        res.on('data', c => data += c);
        res.on('end', () => {
          try {
            const json = JSON.parse(data);
            if (json.errors) return reject(new Error(JSON.stringify(json.errors)));
            resolve(json);
          } catch(e) { reject(e); }
        });
      });
      req.on('error', reject);
      req.write(body);
      req.end();
    });
    accounts.push(...(result.loyalty_accounts || []));
    cursor = result.cursor;
  } while (cursor);
  return accounts;
}

const sleep = ms => new Promise(r => setTimeout(r, ms));

// ── SQUARE: fetch location IDs ─────────────────────────────────────────────────
function fetchLocationIds(token) {
  return new Promise((resolve, reject) => {
    const options = {
      hostname: 'connect.squareup.com',
      path: '/v2/locations',
      method: 'GET',
      headers: { 'Authorization': `Bearer ${token}`, 'Square-Version': '2025-07-17' },
    };
    const req = https.request(options, res => {
      let data = '';
      res.on('data', c => data += c);
      res.on('end', () => {
        try {
          const json = JSON.parse(data);
          if (json.errors) return reject(new Error(JSON.stringify(json.errors)));
          resolve((json.locations || []).map(l => l.id));
        } catch(e) { reject(e); }
      });
    });
    req.on('error', reject);
    req.end();
  });
}

// ── SQUARE: generic GET helper ────────────────────────────────────────────────
function squareGet(token, urlPath) {
  return new Promise((resolve, reject) => {
    const options = {
      hostname: 'connect.squareup.com',
      path: `/v2${urlPath}`,
      method: 'GET',
      headers: { 'Authorization': `Bearer ${token}`, 'Square-Version': '2025-07-17' },
    };
    const req = https.request(options, res => {
      let data = '';
      res.on('data', c => data += c);
      res.on('end', () => {
        try {
          const json = JSON.parse(data);
          if (json.errors) return reject(new Error(JSON.stringify(json.errors)));
          resolve(json);
        } catch(e) { reject(e); }
      });
    });
    req.on('error', reject);
    req.end();
  });
}

// ── SQUARE: generic POST helper ───────────────────────────────────────────────
function squarePost(token, urlPath, body) {
  return new Promise((resolve, reject) => {
    const payload = JSON.stringify(body);
    const options = {
      hostname: 'connect.squareup.com',
      path: `/v2${urlPath}`,
      method: 'POST',
      headers: { 'Authorization': `Bearer ${token}`, 'Square-Version': '2024-01-18', 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(payload) },
    };
    const req = https.request(options, res => {
      let data = '';
      res.on('data', c => data += c);
      res.on('end', () => {
        try {
          const json = JSON.parse(data);
          if (json.errors) return reject(new Error(JSON.stringify(json.errors)));
          resolve(json);
        } catch(e) { reject(e); }
      });
    });
    req.on('error', reject);
    req.write(payload);
    req.end();
  });
}

// ── SQUARE: fetch one page of completed orders ─────────────────────────────────
function fetchOrdersPage(token, locationIds, cursor, startAt) {
  return new Promise((resolve, reject) => {
    const filter = { state_filter: { states: ['COMPLETED', 'OPEN'] } }; // OPEN captures Square Online orders which stay OPEN after fulfilment
    if (startAt) filter.date_time_filter = { updated_at: { start_at: startAt } };
    const payload = {
      location_ids: locationIds,
      query: { filter },
      limit: 500,
    };
    if (cursor) payload.cursor = cursor;
    const body = JSON.stringify(payload);
    const options = {
      hostname: 'connect.squareup.com',
      path: '/v2/orders/search',
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${token}`,
        'Square-Version': '2025-07-17',
        'Content-Type': 'application/json',
        'Content-Length': Buffer.byteLength(body),
      },
    };
    const req = https.request(options, res => {
      let data = '';
      res.on('data', c => data += c);
      res.on('end', () => {
        try {
          const json = JSON.parse(data);
          if (json.errors) return reject(new Error(JSON.stringify(json.errors)));
          resolve({ orders: json.orders || [], cursor: json.cursor });
        } catch(e) { reject(e); }
      });
    });
    req.on('error', reject);
    req.write(body);
    req.end();
  });
}

// ── SQUARE: resolve payment-level customer IDs for orders missing order.customer_id ──
// Square links some POS orders to customers only at the payment level via card
// fingerprinting. For each { paymentId, order } in pendingPayments, fetches the payment
// and adds the resolved customer to visitMap. Applies 100ms throttle every 10 calls.
// resolvedOrderIds (optional): when provided (nightly sweep), order IDs are pushed here only
// after a successful API call — errors leave orders out so the next sweep can retry them.
// sqIdMap / phoneMap are optional — when provided, unknown squareIds are resolved inline
// by fetching the Square profile and matching by phone then email, so a customer with a new
// Square account (e.g. created via a different channel) is linked to their existing CRM record
// rather than silently dropped. Returns newSquareIdLinks for Phase 2 to persist.
async function resolvePaymentCustomers(token, pendingPayments, visitMap, logPrefix, resolvedOrderIds, sqIdMap, phoneMap) {
  if (!pendingPayments.length) return [];
  console.log(`${logPrefix} Resolving ${pendingPayments.length} orders via payment-level customer lookup…`);
  let resolved = 0;
  const newSquareIdLinks = []; // { cid, customerId } — new squareId linked to existing CRM customer

  for (let i = 0; i < pendingPayments.length; i++) {
    const { paymentId, order } = pendingPayments[i];
    try {
      const paymentData = await squareGet(token, `/payments/${paymentId}`);
      const cid = paymentData.payment?.customer_id;
      let credited = false;
      if (cid) {
        let mapKey = cid;

        // If this squareId isn't in our CRM, fetch the Square profile and match by phone/email
        if (sqIdMap && !sqIdMap[cid]) {
          try {
            const profileData = await squareGet(token, `/customers/${cid}`);
            const sq = profileData.customer;
            if (sq) {
              const phone = fmtPhone(sq.phone_number || '');
              const email = (sq.email_address || '').toLowerCase().trim();
              const existing = (phone && phoneMap?.[phone])
                || (email && Object.values(phoneMap || {}).find(c => c.email?.toLowerCase().trim() === email));
              if (existing?.squareIds?.length) {
                mapKey = existing.squareIds[0]; // remap to known squareId so aggregateVisits finds the customer
                newSquareIdLinks.push({ cid, customerId: existing.id });
                console.log(`\n${logPrefix} Linked new squareId → ${existing.firstName} ${existing.lastName} (${existing.phone}) via ${phone ? 'phone' : 'email'}`);
              }
            }
          } catch (e) { /* profile fetch failed — fall through, use cid as-is */ }
        }

        // Credit if: squareId is known in CRM (direct or phone/email remapped above)
        // or it's a brand-new squareId that Phase 2 will create a record for.
        // Do NOT mark processed if cid is still unknown after all attempts — let next sweep retry.
        const willBeKnown = sqIdMap ? (!!sqIdMap[mapKey] || mapKey !== cid) : true;
        if (willBeKnown || !sqIdMap) {
          if (!visitMap[mapKey]) visitMap[mapKey] = { count: 0, lastDate: null, spend: 0 };
          visitMap[mapKey].count++;
          visitMap[mapKey].spend += (order.total_money?.amount) || 0;
          const d = order.closed_at || order.created_at;
          if (d && (!visitMap[mapKey].lastDate || d > visitMap[mapKey].lastDate)) visitMap[mapKey].lastDate = d;
          resolved++;
          credited = true;
        } else {
          console.warn(`\n${logPrefix} Could not match customer_id ${cid} to any CRM record — order ${order.id} deferred to next sweep.`);
        }
      } else {
        credited = true; // no customer_id = genuinely anonymous, safe to mark done
      }
      // Only mark processed once credit is confirmed (or order is genuinely anonymous)
      if (resolvedOrderIds && credited) resolvedOrderIds.push(order.id);
    } catch (e) {
      console.warn(`${logPrefix} Payment lookup failed for ${paymentId} (order ${order.id}): ${e.message}`);
      // Do NOT push to resolvedOrderIds — let the next sweep retry this order
    }
    if ((i + 1) % 50 === 0) process.stdout.write(`\r${logPrefix} Payment lookup ${i + 1}/${pendingPayments.length} (${resolved} resolved)…`);
    if (i % 10 === 9) await sleep(100);
  }
  console.log(`\n${logPrefix} Payment lookup done — ${resolved}/${pendingPayments.length} resolved.`);
  return newSquareIdLinks;
}

// ── SQUARE: batch retrieve customer profiles by ID (up to 100 per call) ────────
function fetchCustomersBatch(token, customerIds) {
  return new Promise((resolve, reject) => {
    const body = JSON.stringify({ customer_ids: customerIds });
    const options = {
      hostname: 'connect.squareup.com',
      path: '/v2/customers/bulk-retrieve',
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${token}`,
        'Square-Version': '2025-07-17',
        'Content-Type': 'application/json',
        'Content-Length': Buffer.byteLength(body),
      },
    };
    const req = https.request(options, res => {
      let data = '';
      res.on('data', c => data += c);
      res.on('end', () => {
        try {
          const json = JSON.parse(data);
          if (json.errors) return reject(new Error(JSON.stringify(json.errors)));
          // Returns { responses: { [id]: { customer: {...} } } }
          resolve(json.responses || {});
        } catch(e) { reject(e); }
      });
    });
    req.on('error', reject);
    req.write(body);
    req.end();
  });
}

// ── CELLCAST: send bulk SMS ────────────────────────────────────────────────────
// Cellcast REST API: https://app.cellcast.com.au
// Docs: https://developer.cellcast.com.au
function cellcastPost(apiKey, payload) {
  return new Promise((resolve, reject) => {
    const body = JSON.stringify(payload);
    const options = {
      hostname: 'api.cellcast.com',
      path: '/api/v1/gateway',
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${apiKey}`,
        'Content-Type': 'application/json',
        'Accept': 'application/json',
        'Content-Length': Buffer.byteLength(body),
      },
    };
    const req = https.request(options, res => {
      let data = '';
      res.on('data', c => data += c);
      res.on('end', () => {
        console.log('[Cellcast] status:', res.statusCode, '| raw:', data.slice(0, 300));
        if (res.statusCode >= 400) {
          try { const j = JSON.parse(data); return reject(new Error(j.message || JSON.stringify(j))); } catch(_) {}
          return reject(new Error(`Cellcast error ${res.statusCode}: ${data.slice(0, 200)}`));
        }
        try { resolve(JSON.parse(data)); } catch(_) { resolve({ success: true }); }
      });
    });
    req.on('error', reject);
    req.write(body);
    req.end();
  });
}

async function sendCellcastSMS(apiKey, sender, recipients, message) {
  const hasPersonalisation = /\{first_name\}|\{name\}/i.test(message);
  const _siteDb  = loadDB();
  const siteBase = (_siteDb.settings?.crmBaseUrl || _siteDb.settings?.feedbackBaseUrl || 'https://crm.woodpeckers.pizza').replace(/\/$/, '');

  const payload = (msg, contacts) => {
    const p = { message: msg, contacts, reply_url: `${siteBase}/webhook` };
    if (sender) p.sender = sender;   // omit entirely for shared number
    return p;
  };

  if (hasPersonalisation) {
    console.log('[Cellcast] Personalised send —', recipients.length, 'individual calls');
    const results = [];
    for (const r of recipients) {
      const personalised = message
        .replace(/\{first_name\}/gi, r.firstName || '')
        .replace(/\{name\}/gi, r.name || '');
      results.push(await cellcastPost(apiKey, payload(personalised, [r.number])));
    }
    return { sent: results.length, personalised: true };
  } else {
    console.log('[Cellcast] Bulk send —', recipients.length, 'recipients');
    return cellcastPost(apiKey, payload(message, recipients.map(r => r.number)));
  }
}

// ── CELLCAST: fetch all opted-out numbers (paginated) ─────────────────────────
async function fetchAllCellcastOptouts(apiKey) {
  const optouts = [];
  let page = 1;
  while (true) {
    const result = await new Promise((resolve, reject) => {
      const params = new URLSearchParams({ page, size: 200 });
      const options = {
        hostname: 'api.cellcast.com',
        path: `/api/v1/apiClient/getOptout?${params}`,
        method: 'GET',
        headers: { 'Authorization': `Bearer ${apiKey}`, 'Accept': 'application/json' },
        timeout: 45000,
      };
      const req = https.request(options, res => {
        let data = '';
        res.on('data', c => data += c);
        res.on('end', () => {
          try {
            const json = JSON.parse(data);
            console.log('[Cellcast Optout] status:', res.statusCode, '| raw:', data.slice(0, 500));
            if (res.statusCode >= 400) return reject(new Error(json.message || `Cellcast error ${res.statusCode}`));
            resolve(json);
          } catch(e) { reject(e); }
        });
      });
      req.on('timeout', () => { req.destroy(); reject(new Error('Cellcast request timed out')); });
      req.on('error', reject);
      req.end();
    });
    const records = (result.data && result.data.items) || [];
    if (!Array.isArray(records) || records.length === 0) break;
    for (const r of records) {
      const raw = r.number || r.phone || r.mobile || r.contact;
      if (raw) optouts.push(fmtPhone(String(raw).trim()));
    }
    if (records.length < 200) break;
    page++;
  }
  return optouts;
}

// ── Apply a Square customer profile to our DB ──────────────────────────────────
// Match priority: 1) phone number, 2) any squareId in the array
function applySquareProfile(sq, db) {
  const phone = sq.phone_number ? fmtPhone(sq.phone_number) : '';
  let existing = phone ? db.customers.find(c => c.phone && fmtPhone(c.phone) === phone) : null;
  if (!existing) existing = db.customers.find(c => getSquareIds(c).includes(sq.id));
  if (existing) {
    // Accumulate Square IDs — keep all, never discard
    if (!existing.squareIds) existing.squareIds = existing.squareId ? [existing.squareId] : [];
    if (!existing.squareIds.includes(sq.id)) existing.squareIds.push(sq.id);
    delete existing.squareId;
    if (sq.given_name)  existing.firstName = sq.given_name;
    if (sq.family_name) existing.lastName  = sq.family_name;
    existing.email      = sq.email_address || existing.email || '';
    existing.phone      = phone || (existing.phone ? fmtPhone(existing.phone) : '');
    if (sq.birthday) existing.birthday = sq.birthday;
    if (sq.created_at) existing.createdAt = sq.created_at.split('T')[0];
    else if (!existing.createdAt) existing.createdAt = new Date().toISOString().split('T')[0];
    existing.squareNote = sq.note || '';
    existing.syncedAt   = new Date().toISOString();
    return 'updated';
  } else {
    db.customers.push({
      id: uid(), squareIds: [sq.id],
      firstName: sq.given_name   || '',
      lastName:  sq.family_name  || '',
      email:     sq.email_address || '',
      phone,
      birthday:  sq.birthday || '',
      createdAt: (sq.created_at || new Date().toISOString()).split('T')[0],
      lastVisit: '', visits: 0, lifetimeSpend: 0,
      squareNote: sq.note || '',
      tags: [], note: '',
      syncedAt: new Date().toISOString(),
    });
    return 'added';
  }
}

// ── HTTP SERVER ────────────────────────────────────────────────────────────────
const server = http.createServer(async (req, res) => {
  if (req.method === 'OPTIONS') { res.writeHead(204, CORS); res.end(); return; }

  // Load DB
  if (req.url === '/api/data' && req.method === 'GET') {
    res.writeHead(200, { 'Content-Type': 'application/json', ...CORS });
    res.end(JSON.stringify(loadDB()));
    return;
  }

  // Sync logs
  if (req.url === '/api/sync-logs' && req.method === 'GET') {
    const d = loadDB();
    res.writeHead(200, { 'Content-Type': 'application/json', ...CORS });
    res.end(JSON.stringify(d.syncLogs || []));
    return;
  }

  // Cellcast inbound SMS payloads (debug)
  if (req.url === '/api/sms-payloads' && req.method === 'GET') {
    res.writeHead(200, { 'Content-Type': 'application/json', ...CORS });
    res.end(JSON.stringify(loadPayloads().cellcast || []));
    return;
  }

  // Square webhook payloads (debug)
  if (req.url === '/api/webhook-payloads' && req.method === 'GET') {
    res.writeHead(200, { 'Content-Type': 'application/json', ...CORS });
    res.end(JSON.stringify(loadPayloads().square || []));
    return;
  }

  // Save DB
  if (req.url === '/api/data' && req.method === 'POST') {
    let body = '';
    req.on('data', c => body += c);
    req.on('end', () => {
      try { saveDB(JSON.parse(body)); res.writeHead(200, { 'Content-Type': 'application/json', ...CORS }); res.end(JSON.stringify({ ok: true })); }
      catch(e) { res.writeHead(400, { 'Content-Type': 'application/json', ...CORS }); res.end(JSON.stringify({ error: e.message })); }
    });
    return;
  }

  // Save settings only (avoids sending entire db)
  if (req.url === '/api/settings' && req.method === 'POST') {
    let body = '';
    req.on('data', c => body += c);
    req.on('end', async () => {
      try {
        const settings = JSON.parse(body);
        await withDB(freshDb => { freshDb.settings = { ...freshDb.settings, ...settings }; });
        console.log('[Settings] Saved:', Object.keys(settings).join(', '));
        res.writeHead(200, { 'Content-Type': 'application/json', ...CORS });
        res.end(JSON.stringify({ ok: true }));
      } catch(e) {
        console.error('[Settings] Save failed:', e.message);
        res.writeHead(400, { 'Content-Type': 'application/json', ...CORS });
        res.end(JSON.stringify({ error: e.message }));
      }
    });
    return;
  }

  // Square loyalty + visits sync
  if (req.url === '/api/square-loyalty-sync' && req.method === 'POST') {
    let body = '';
    req.on('data', c => body += c);
    req.on('end', async () => {
      try {
        const { token } = JSON.parse(body);
        if (!token) throw new Error('Missing Square token.');

        // Read lastOrderSyncAt before long API calls so we know the incremental window
        const { lastOrderSyncAt, processedOrderIds: _processedIds } = loadDB();
        const processedSet = new Set(_processedIds || []);
        const syncStart = new Date().toISOString();

        // Phase 1: gather everything from Square API (no DB writes yet)
        // 1. Loyalty accounts
        const allAccounts = await fetchAllLoyaltyAccounts(token);
        console.log('[Loyalty] accounts found:', allAccounts.length);

        // 2. Orders — incremental since last sync, skipping any already handled by webhook
        const locationIds = await fetchLocationIds(token);
        const visitMap = {};
        const pendingPayments = [];
        let cursor = null, pageCount = 0, skipped = 0;
        do {
          const result = await fetchOrdersPage(token, locationIds, cursor, lastOrderSyncAt);
          pageCount++;
          for (const order of result.orders) {
            if (processedSet.has(order.id)) { skipped++; continue; }
            const cid = order.customer_id;
            if (cid) {
              if (!visitMap[cid]) visitMap[cid] = { count: 0, lastDate: null, spend: 0 };
              visitMap[cid].count++;
              visitMap[cid].spend += (order.total_money && order.total_money.amount) || 0;
              const d = order.closed_at || order.created_at;
              if (d && (!visitMap[cid].lastDate || d > visitMap[cid].lastDate)) visitMap[cid].lastDate = d;
            } else {
              const paymentId = order.tenders?.[0]?.payment_id;
              if (paymentId) pendingPayments.push({ paymentId, order });
            }
          }
          cursor = result.cursor;
        } while (cursor);
        console.log(`[Loyalty] order pages: ${pageCount} | skipped (webhook-processed): ${skipped} | mode: ${lastOrderSyncAt ? 'incremental' : 'full'}`);
        await resolvePaymentCustomers(token, pendingPayments, visitMap, '[Loyalty]');

        // 3. Batch-fetch profiles for active customers
        const activeSquareIds = Object.keys(visitMap);
        const profileMap = {};
        for (let i = 0; i < activeSquareIds.length; i += 100) {
          const responses = await fetchCustomersBatch(token, activeSquareIds.slice(i, i + 100));
          Object.assign(profileMap, responses);
        }

        // Phase 2: apply everything atomically on a fresh DB state
        let visitsUpdated = 0, profilesUpdated = 0, profilesAdded = 0;
        await withDB(freshDb => {
          const sqIdMap = buildSqIdMap(freshDb.customers);

          // Loyalty points
          for (const account of allAccounts) {
            let c = account.customer_id ? sqIdMap[account.customer_id] : null;
            if (!c && account.mapping?.phone_number) {
              c = freshDb.customers.find(x => x.phone === fmtPhone(account.mapping.phone_number));
            }
            if (c) c.loyaltyPoints = account.balance || 0;
          }

          // Visit counts — add incremental delta on top of existing CSV baseline
          for (const [, { count, spend, lastDate, customer: c }] of aggregateVisits(visitMap, sqIdMap)) {
            c.visits        = (c.visits || 0) + count;
            c.lifetimeSpend = (c.lifetimeSpend || 0) + spend;
            if (lastDate) { const d = lastDate.split('T')[0]; if (!c.lastVisit || d > c.lastVisit) c.lastVisit = d; }
            visitsUpdated++;
          }

          // Profiles for customers with new orders
          for (const [, entry] of Object.entries(profileMap)) {
            if (entry && entry.customer) {
              const r = applySquareProfile(entry.customer, freshDb);
              if (r === 'added') profilesAdded++; else profilesUpdated++;
            }
          }

          freshDb.lastOrderSyncAt = syncStart;
        });

        const mode = lastOrderSyncAt ? 'incremental' : 'full scan';
        console.log(`[Loyalty] Done (${mode}) — loyalty: ${allAccounts.length}, visits: ${visitsUpdated}, profiles: ${profilesUpdated}+${profilesAdded}`);

        res.writeHead(200, { 'Content-Type': 'application/json', ...CORS });
        res.end(JSON.stringify({ ok: true, loyaltyUpdated: allAccounts.length, visitsUpdated, profilesUpdated, profilesAdded, incremental: !!lastOrderSyncAt }));
      } catch(e) {
        console.error('[Loyalty] error:', e.message);
        res.writeHead(500, { 'Content-Type': 'application/json', ...CORS });
        res.end(JSON.stringify({ error: e.message }));
      }
    });
    return;
  }

  // Deduplicate customers — merge records sharing the same phone or squareId
  if (req.url === '/api/deduplicate' && req.method === 'POST') {
    try {
      let before = 0, after = 0;
      await withDB(freshDb => {
        before = freshDb.customers.length;
        const keep = [], seenPhone = {}, seenSqId = {};
        for (const c of freshDb.customers) {
          const phone = c.phone ? fmtPhone(c.phone) : null;
          const sqIds = c.squareIds || (c.squareId ? [c.squareId] : []);
          let master = null;
          if (phone && seenPhone[phone]) master = seenPhone[phone];
          if (!master) for (const sid of sqIds) if (seenSqId[sid]) { master = seenSqId[sid]; break; }
          if (master) {
            for (const sid of sqIds) if (!master.squareIds.includes(sid)) master.squareIds.push(sid);
            delete master.squareId;
            if (!master.firstName && c.firstName) master.firstName = c.firstName;
            if (!master.lastName  && c.lastName)  master.lastName  = c.lastName;
            if (!master.email     && c.email)      master.email     = c.email;
            if (!master.phone     && c.phone)      master.phone     = c.phone;
            if (!master.birthday  && c.birthday)   master.birthday  = c.birthday;
            if (c.tags && c.tags.length && !(master.tags && master.tags.length)) master.tags = c.tags;
            if (c.note && !master.note) master.note = c.note;
            if (c.visits > (master.visits || 0)) master.visits = c.visits;
            if (c.lifetimeSpend > (master.lifetimeSpend || 0)) master.lifetimeSpend = c.lifetimeSpend;
            if (c.loyaltyPoints > (master.loyaltyPoints || 0)) master.loyaltyPoints = c.loyaltyPoints;
            if (c.lastVisit && (!master.lastVisit || c.lastVisit > master.lastVisit)) master.lastVisit = c.lastVisit;
          } else {
            if (!c.squareIds) { c.squareIds = sqIds; delete c.squareId; }
            keep.push(c);
            master = c;
          }
          if (phone) seenPhone[phone] = master;
          for (const sid of sqIds) seenSqId[sid] = master;
        }
        freshDb.customers = keep;
        after = keep.length;
      });
      const removed = before - after;
      console.log(`[Deduplicate] ${before} → ${after} customers (${removed} duplicates removed).`);
      res.writeHead(200, { 'Content-Type': 'application/json', ...CORS });
      res.end(JSON.stringify({ ok: true, before, after, removed }));
    } catch(e) {
      console.error('[Deduplicate] error:', e.message);
      res.writeHead(500, { 'Content-Type': 'application/json', ...CORS });
      res.end(JSON.stringify({ error: e.message }));
    }
    return;
  }

  // Full rescan status poll
  if (req.url === '/api/full-rescan-status' && req.method === 'GET') {
    res.writeHead(200, { 'Content-Type': 'application/json', ...CORS });
    res.end(JSON.stringify(fullRescanJob));
    return;
  }

  // Full rescan — runs in background, client polls for status
  if (req.url === '/api/full-rescan' && req.method === 'POST') {
    let body = '';
    req.on('data', c => body += c);
    req.on('end', async () => {
      try {
        const { token } = JSON.parse(body);
        if (!token) throw new Error('Missing Square token.');
        if (fullRescanJob.status === 'running') {
          res.writeHead(200, { 'Content-Type': 'application/json', ...CORS });
          res.end(JSON.stringify({ started: false, error: 'Already running' }));
          return;
        }
        // Respond immediately — client will poll status
        fullRescanJob = { status: 'running', step: 'Starting…', startedAt: new Date().toISOString(), result: null };
        res.writeHead(200, { 'Content-Type': 'application/json', ...CORS });
        res.end(JSON.stringify({ started: true }));

        // Run in background
        // Phase 1: gather everything from Square API (no DB mutations — can run concurrently with webhooks)
        // Phase 2: apply all changes atomically inside withDB so webhook writes aren't overwritten
        (async () => {
          try {
            const syncStart = new Date().toISOString();

            fullRescanJob.step = 'Fetching all customer profiles…';
            console.log('[FullRescan] Step 1: Fetching all customer profiles…');
            const squareCustomers = await fetchAllSquareCustomers(token);

            fullRescanJob.step = 'Scanning all historical orders…';
            console.log('[FullRescan] Step 2: Scanning all historical orders…');
            const locationIds = await fetchLocationIds(token);
            const visitMap = {};
            const pendingPayments = [];
            let cursor = null, pageCount = 0;
            do {
              const result = await fetchOrdersPage(token, locationIds, cursor, null);
              pageCount++;
              fullRescanJob.step = `Scanning orders… (${pageCount} pages so far)`;
              for (const order of result.orders) {
                const cid = order.customer_id;
                if (cid) {
                  if (!visitMap[cid]) visitMap[cid] = { count: 0, lastDate: null, spend: 0 };
                  visitMap[cid].count++;
                  visitMap[cid].spend += (order.total_money && order.total_money.amount) || 0;
                  const d = order.closed_at || order.created_at;
                  if (d && (!visitMap[cid].lastDate || d > visitMap[cid].lastDate)) visitMap[cid].lastDate = d;
                } else {
                  const paymentId = order.tenders?.[0]?.payment_id;
                  if (paymentId) pendingPayments.push({ paymentId, order });
                }
              }
              cursor = result.cursor;
            } while (cursor);
            console.log(`[FullRescan] ${pageCount} order pages, ${Object.keys(visitMap).length} Square IDs at order level.`);
            fullRescanJob.step = 'Resolving payment-level customers…';
            await resolvePaymentCustomers(token, pendingPayments, visitMap, '[FullRescan]');

            fullRescanJob.step = 'Syncing loyalty points…';
            console.log('[FullRescan] Step 3: Syncing loyalty points…');
            const allAccounts = await fetchAllLoyaltyAccounts(token);

            // Phase 2: apply atomically on a fresh DB state so concurrent webhook writes aren't lost
            fullRescanJob.step = 'Applying changes…';
            let profilesAdded = 0, profilesUpdated = 0, visitsUpdated = 0, loyaltyUpdated = 0;
            await withDB(freshDb => {
              // Profiles
              for (const sq of squareCustomers) {
                const r = applySquareProfile(sq, freshDb);
                if (r === 'added') profilesAdded++; else profilesUpdated++;
              }

              // Visit counts — use the higher value so CSV baseline is never reduced
              const sqIdMap = buildSqIdMap(freshDb.customers);
              for (const [, { count, spend, lastDate, customer: c }] of aggregateVisits(visitMap, sqIdMap)) {
                c.visits        = Math.max(c.visits || 0, count);
                c.lifetimeSpend = Math.max(c.lifetimeSpend || 0, spend);
                if (lastDate) { const d = lastDate.split('T')[0]; if (!c.lastVisit || d > c.lastVisit) c.lastVisit = d; }
                visitsUpdated++;
              }

              // Loyalty
              for (const account of allAccounts) {
                let c = account.customer_id ? sqIdMap[account.customer_id] : null;
                if (!c && account.mapping?.phone_number) {
                  c = freshDb.customers.find(x => x.phone === fmtPhone(account.mapping.phone_number));
                }
                if (c) { c.loyaltyPoints = account.balance || 0; loyaltyUpdated++; }
              }

              freshDb.lastOrderSyncAt = syncStart;
            });

            console.log(`[FullRescan] Done — ${profilesAdded} new, ${profilesUpdated} profiles, ${visitsUpdated} visits, ${loyaltyUpdated} loyalty.`);
            fullRescanJob = { status: 'done', step: 'Complete', result: { profilesAdded, profilesUpdated, visitsUpdated, loyaltyUpdated, pages: pageCount } };
          } catch(e) {
            console.error('[FullRescan] error:', e.message);
            fullRescanJob = { status: 'error', step: e.message, result: null };
          }
        })();
      } catch(e) {
        res.writeHead(400, { 'Content-Type': 'application/json', ...CORS });
        res.end(JSON.stringify({ error: e.message }));
      }
    });
    return;
  }

  // Cellcast opt-out sync
  if (req.url === '/api/cellcast-optouts' && req.method === 'POST') {
    let body = '';
    req.on('data', c => body += c);
    req.on('end', async () => {
      try {
        const { apiKey } = JSON.parse(body);
        if (!apiKey) throw new Error('Missing Cellcast API key.');
        const optouts = await fetchAllCellcastOptouts(apiKey);
        console.log('[Cellcast] opt-outs fetched:', optouts.length);
        let added = 0;
        await withDB(freshDb => {
          if (!Array.isArray(freshDb.optOuts)) freshDb.optOuts = [];
          const existing = new Set(freshDb.optOuts);
          for (const phone of optouts) {
            if (phone && !existing.has(phone)) { freshDb.optOuts.push(phone); existing.add(phone); added++; }
          }
        });
        console.log(`[Cellcast] opt-outs synced — ${added} new added, ${optouts.length} total.`);
        res.writeHead(200, { 'Content-Type': 'application/json', ...CORS });
        res.end(JSON.stringify({ optouts, added }));
      } catch(e) {
        console.error('[Cellcast optout] error:', e.message);
        res.writeHead(500, { 'Content-Type': 'application/json', ...CORS });
        res.end(JSON.stringify({ error: e.message }));
      }
    });
    return;
  }

  // Cellcast send
  if (req.url === '/api/cellcast-send' && req.method === 'POST') {
    let body = '';
    req.on('data', c => body += c);
    req.on('end', async () => {
      try {
        const { apiKey, sender, recipients, message, bypassWeeklyGuard, segment } = JSON.parse(body);
        if (!apiKey) throw new Error('Missing Cellcast API key — set it in Settings.');
        if (!recipients || !recipients.length) throw new Error('No recipients selected.');
        if (!message || !message.trim()) throw new Error('Message is empty.');

        const db = loadDB();
        const { safe, offHours, blocked } = applyGuards(recipients, db, { skipWeeklyGuard: !!bypassWeeklyGuard });
        if (offHours) throw new Error('Messages can only be sent between 9am and 9pm Perth time.');
        if (!safe.length) throw new Error(
          blocked.tooSoon
            ? `WEEKLY_GUARD:${blocked.tooSoon}:All recipients were texted in the last 7 days.`
            : `All recipients blocked — opt-outs: ${blocked.optOut}, duplicates: ${blocked.duplicate}, non-AU numbers: ${blocked.nonAu}.`
        );

        const result = await sendCellcastSMS(apiKey, sender, safe, message);

        // Record smsSent per recipient and log campaign atomically via withDB
        // to prevent race conditions with other concurrent DB writes.
        const hasPersonalisation = /\{first_name\}|\{name\}/i.test(message);
        const sentAt = new Date().toISOString();
        await withDB(freshDb => {
          for (const r of safe) {
            const msg = hasPersonalisation
              ? message.replace(/\{first_name\}/gi, r.firstName || '').replace(/\{name\}/gi, r.name || '')
              : message;
            recordSMSSent(freshDb, r.number, msg, 'Campaign');
          }
          if (!Array.isArray(freshDb.campaigns)) freshDb.campaigns = [];
          freshDb.campaigns.unshift({
            id: uid(), date: sentAt, message,
            sender: sender || '#SharedNum#',
            segment: segment || 'Campaign',
            recipientCount: safe.length,
            recipients: safe.map(r => r.number),
            status: 'sent',
          });
        });

        res.writeHead(200, { 'Content-Type': 'application/json', ...CORS });
        res.end(JSON.stringify({ ...result, blocked }));
      } catch(e) {
        console.error('[CellcastSend] error:', e.message, e.stack);
        res.writeHead(500, { 'Content-Type': 'application/json', ...CORS });
        res.end(JSON.stringify({ error: e.message }));
      }
    });
    return;
  }

  // Run automation (test or real)
  if (req.url === '/api/run-automation' && req.method === 'POST') {
    let body = '';
    req.on('data', c => body += c);
    req.on('end', async () => {
      try {
        const { id, test, testVariant, phones, template, templateReward, templateMissYou } = JSON.parse(body);
        const db = loadDB();
        const auto = (db.automations || []).find(a => a.id === id);
        if (!auto) throw new Error('Automation not found: ' + id);

        const apiKey = db.settings && db.settings.cellcastKey;
        const sender = db.settings && db.settings.cellcastSender || null;
        if (!apiKey) throw new Error('Cellcast API key not configured.');

        // For winback: two templates; for all others: single template
        const isWinback       = id === 'winback' || id === 'last_chance';
        const tplReward   = isWinback ? (templateReward  || auto.templateReward  || '') : null;
        const tplMissYou  = isWinback ? (templateMissYou || auto.templateMissYou || '') : null;
        const tpl         = isWinback ? null : (template || auto.template || '');
        const rewardThreshold = (auto.config && auto.config.rewardThreshold) || 5;

        function pickTemplate(customer) {
          if (!isWinback) return tpl;
          return (customer.loyaltyPoints || 0) >= rewardThreshold ? tplReward : tplMissYou;
        }

        if (test) {
          const testPhone = db.settings.testPhone;
          if (!testPhone) throw new Error('No test phone configured in Settings.');
          // Use real customer data if the test phone matches a customer
          const testCust = (db.customers || []).find(c => c.phone === testPhone);
          const fakeCustomer = testCust || { phone: testPhone, firstName: 'Test', lastName: 'User', loyaltyPoints: 0 };
          // For winback: testVariant selects which message; if no variant, pick based on actual points
          let testTpl;
          if (isWinback) {
            if (testVariant === 'missyou') testTpl = tplMissYou;
            else if (testVariant === 'reward') testTpl = tplReward;
            else testTpl = (fakeCustomer.loyaltyPoints || 0) >= rewardThreshold ? tplReward : tplMissYou;
          } else {
            testTpl = tpl;
          }
          const preview = personalizeAutoMessage(testTpl, fakeCustomer, auto);
          await sendCellcastSMS(apiKey, sender, [{ number: testPhone, firstName: fakeCustomer.firstName || '', name: [fakeCustomer.firstName, fakeCustomer.lastName].filter(Boolean).join(' ') }], preview);
          res.writeHead(200, { 'Content-Type': 'application/json', ...CORS });
          res.end(JSON.stringify({ sent: 1, test: true }));
          return;
        }

        // Real run — compute queue, then filter to user-selected phones if provided
        let queue = getAutomationQueue(auto, db.customers, db.optOuts || [], db.smsLog || [], db.segments || []);
        if (phones && phones.length) {
          const allowed = new Set(phones);
          queue = queue.filter(c => allowed.has(c.phone));
        }
        if (!queue.length) {
          res.writeHead(200, { 'Content-Type': 'application/json', ...CORS });
          res.end(JSON.stringify({ sent: 0, skipped: 0, errors: [] }));
          return;
        }

        const { safe: safeQueue, offHours, blocked } = applyGuards(
          queue.map(c => ({ ...c, number: c.phone })), db
        );
        if (offHours) throw new Error('Messages can only be sent between 9am and 9pm Perth time.');

        // Phase 1: send SMS outside the DB lock
        const now        = new Date();
        const sentRecords = [], errors = [];
        for (const c of safeQueue) {
          try {
            const msg = personalizeAutoMessage(pickTemplate(c), c, auto);
            await sendCellcastSMS(apiKey, sender, [{ number: c.phone, firstName: c.firstName || '', name: [c.firstName, c.lastName].filter(Boolean).join(' ') }], msg);
            const key = auto.id === 'birthday' ? `${c.phone}_${now.getFullYear()}` : c.phone;
            sentRecords.push({ phone: c.phone, lastVisit: c.lastVisit || null, msg, key });
          } catch(e) {
            errors.push(`${c.phone}: ${e.message}`);
          }
        }

        // Phase 2: record everything atomically on a fresh DB state
        await withDB(freshDb => {
          const freshAuto = (freshDb.automations || []).find(a => a.id === id);
          if (!freshDb.smsLog) freshDb.smsLog = [];
          for (const { phone, lastVisit, msg, key } of sentRecords) {
            recordSMSSent(freshDb, phone, msg, auto.name || 'Automation');
            if (freshAuto) {
              if (!freshAuto.sentTo) freshAuto.sentTo = {};
              freshAuto.sentTo[key] = now.toISOString();
            }
            freshDb.smsLog.push({
              id: uid(), phone, triggerType: id,
              visitReferenceDate: lastVisit,
              sentAt: now.toISOString(), messageBody: msg, status: 'sent',
            });
          }
          if (freshAuto) {
            freshAuto.lastRunAt    = now.toISOString();
            freshAuto.lastRunStats = { sent: sentRecords.length, skipped: 0, errors: errors.length };
          }
          if (!freshDb.campaigns) freshDb.campaigns = [];
          freshDb.campaigns.unshift({
            id: uid(), date: now.toISOString(),
            message: tpl, sender: sender || '#SharedNum#',
            segment: `Auto: ${auto.name}`,
            recipientCount: sentRecords.length,
            recipients: sentRecords.map(r => r.phone),
            status: errors.length ? 'partial' : 'sent',
          });
        });

        const sent = sentRecords.length;
        res.writeHead(200, { 'Content-Type': 'application/json', ...CORS });
        res.end(JSON.stringify({ sent, skipped: queue.length - safeQueue.length + (safeQueue.length - sent), blocked, errors }));
      } catch(e) {
        console.error('[run-automation]', e.message);
        res.writeHead(500, { 'Content-Type': 'application/json', ...CORS });
        res.end(JSON.stringify({ error: e.message }));
      }
    });
    return;
  }

  // Square CSV import — wipe & rebuild from CSV, then re-apply CRM-native fields from previous DB
  if (req.url === '/api/import-square-csv' && req.method === 'POST') {
    let body = '';
    req.on('data', c => body += c);
    req.on('end', async () => {
      try {
        const { records } = JSON.parse(body);
        if (!records || !records.length) throw new Error('No records provided.');

        // Fields that come from Square/CSV — everything else is CRM-native and must survive the wipe
        const CSV_FIELDS = new Set([
          'id', 'squareIds', 'firstName', 'lastName', 'email', 'phone',
          'birthday', 'createdAt', 'visits', 'lifetimeSpend', 'lastVisit',
          'squareNote', 'syncedAt',
        ]);

        let added = 0, reapplied = 0;
        await withDB(freshDb => {
          // Step 1: Snapshot CRM-native fields from every existing customer
          // Primary key: phone. Fallback: any squareId they currently have.
          const overlay      = {};   // normPhone → overlay entry
          const sqIdToOverlay = {};  // squareId  → overlay entry (direct, handles no-phone case)

          if (freshDb.customers.length > 0) {
            // Extract overlay from current customers and persist to file before wipe.
            // If the server crashes after the wipe, the file survives for the next run.
            for (const c of freshDb.customers) {
              const phone = c.phone ? fmtPhone(c.phone) : null;
              // Include phone and squareIds explicitly so the file is self-contained for re-matching
              const entry = { id: c.id, phone: phone || '', squareIds: c.squareIds || [] };
              for (const [k, v] of Object.entries(c)) {
                if (!CSV_FIELDS.has(k)) entry[k] = v;
              }
              if (phone) overlay[phone] = entry;
              for (const sid of (c.squareIds || [])) sqIdToOverlay[sid] = entry;
            }
            // Deduplicate entries (a customer with 2 squareIds appears twice in sqIdToOverlay
            // but should only appear once in the file)
            const seen = new Set();
            const arr  = [];
            for (const e of [...Object.values(overlay), ...Object.values(sqIdToOverlay)]) {
              if (!seen.has(e.id)) { seen.add(e.id); arr.push(e); }
            }
            const overlayTmp = OVERLAY_FILE + '.tmp';
            fs.writeFileSync(overlayTmp, JSON.stringify(arr, null, 2));
            fs.renameSync(overlayTmp, OVERLAY_FILE);
          } else {
            // Crash recovery: db.customers was already wiped — reload from saved overlay file
            try {
              for (const entry of JSON.parse(fs.readFileSync(OVERLAY_FILE, 'utf8'))) {
                const phone = entry.phone ? fmtPhone(entry.phone) : null;
                if (phone) overlay[phone] = entry;
                for (const sid of (entry.squareIds || [])) sqIdToOverlay[sid] = entry;
              }
              console.log(`[CSV Import] Crash recovery: loaded ${Object.keys(overlay).length} overlay entries from file.`);
            } catch(e) { /* no saved overlay — fresh import */ }
          }

          // Step 2: Wipe
          freshDb.customers = [];

          // Step 3: Rebuild from CSV rows, deduplicating by phone then squareId
          const phoneMap = {}, sqIdMap = {};
          for (const r of records) {
            const phone = r.phone ? fmtPhone(r.phone) : null;
            let c = (phone && phoneMap[phone]) || (r.squareId && sqIdMap[r.squareId]) || null;

            if (c) {
              // Second row = same person, different Square profile — accumulate stats, pick best identity
              if (r.squareId && !c.squareIds.includes(r.squareId)) {
                c.squareIds.push(r.squareId);
                sqIdMap[r.squareId] = c;
              }
              // Sum visits and spend (separate Square profiles, non-overlapping histories)
              if (r.visits > 0)        c.visits        = (c.visits || 0) + r.visits;
              if (r.lifetimeSpend > 0) c.lifetimeSpend = (c.lifetimeSpend || 0) + r.lifetimeSpend;
              // Name/email from whichever profile had the most recent visit
              const rIsNewer = r.lastVisit && (!c.lastVisit || r.lastVisit > c.lastVisit);
              if (rIsNewer) {
                if (r.firstName) c.firstName = r.firstName;
                if (r.lastName)  c.lastName  = r.lastName;
                if (r.email)     c.email     = r.email;
              } else {
                if (r.email && !c.email) c.email = r.email;
              }
              if (r.birthday && !c.birthday) c.birthday = normalizeBirthday(r.birthday);
              // Widest date range
              if (r.lastVisit  && (!c.lastVisit  || r.lastVisit  > c.lastVisit))  c.lastVisit  = r.lastVisit;
              if (r.createdAt  && (!c.createdAt  || r.createdAt  < c.createdAt))  c.createdAt  = r.createdAt;
            } else {
              // New row — look up CRM overlay by phone, then by squareId
              const ov = (phone && overlay[phone])
                || (r.squareId && sqIdToOverlay[r.squareId])
                || null;

              c = {
                id:            ov?.id || uid(),
                squareIds:     r.squareId ? [r.squareId] : [],
                firstName:     r.firstName     || '',
                lastName:      r.lastName      || '',
                email:         r.email         || '',
                phone:         phone           || '',
                birthday:      normalizeBirthday(r.birthday),
                createdAt:     r.createdAt     || '',
                lastVisit:     r.lastVisit     || '',
                visits:        r.visits        || 0,
                lifetimeSpend: r.lifetimeSpend || 0,
                squareNote:    '',
                syncedAt:      new Date().toISOString(),
                // CRM defaults — overwritten below when overlay matches
                tags: [], note: '', smsReplies: [], loyaltyPoints: 0,
              };

              if (ov) {
                for (const [k, v] of Object.entries(ov)) {
                  if (k !== 'id') c[k] = v;
                }
                reapplied++;
              }

              freshDb.customers.push(c);
              if (phone)      phoneMap[phone]     = c;
              if (r.squareId) sqIdMap[r.squareId] = c;
              added++;
            }
          }

          freshDb.lastOrderSyncAt = new Date().toISOString();
        });

        console.log(`[CSV Import] added=${added} crm-reapplied=${reapplied}`);
        res.writeHead(200, { 'Content-Type': 'application/json', ...CORS });
        res.end(JSON.stringify({ ok: true, added, reapplied }));
      } catch(e) {
        console.error('[CSV Import] error:', e.message);
        res.writeHead(500, { 'Content-Type': 'application/json', ...CORS });
        res.end(JSON.stringify({ error: e.message }));
      }
    });
    return;
  }

  // ── Square webhook ────────────────────────────────────────────────────────────
  // Handles: customer.created, customer.updated, order.created, order.updated,
  //          loyalty.account.updated, loyalty.event.created
  // Verify: HMAC-SHA256 of raw body with db.settings.squareWebhookSecret
  if (req.url === '/api/square-webhook' && req.method === 'POST') {
    let raw = '';
    req.on('data', c => raw += c);
    req.on('end', async () => {
      try {
        const db = loadDB();
        const secret = db.settings?.squareWebhookSecret;

        // Signature verification (skip only if no secret configured)
        if (secret) {
          const sig      = req.headers['x-square-hmacsha256-signature'] || '';
          const crmBase  = (db.settings?.crmBaseUrl || '').replace(/\/$/, '');
          const proto    = req.headers['x-forwarded-proto'] || 'https';
          const host     = req.headers['x-forwarded-host'] || req.headers.host || '';
          const url      = crmBase ? `${crmBase}/api/square-webhook` : `${proto}://${host}/api/square-webhook`;
          const expected = crypto.createHmac('sha256', secret).update(url + raw).digest('base64');
          if (sig !== expected) {
            console.warn(`[SquareWebhook] Signature mismatch — rejected. URL used: ${url} | Got: ${sig} | Expected: ${expected}`);
            res.writeHead(401, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ error: 'Invalid signature' }));
            return;
          }
        }

        const event = JSON.parse(raw);
        const type  = event.type || '';
        const data  = event.data?.object || {};
        console.log(`[SquareWebhook] ${type}`);

        withPayloads(p => {
          if (!Array.isArray(p.square)) p.square = [];
          p.square.unshift({ id: uid(), receivedAt: new Date().toISOString(), type, raw: event });
        });

        const log = { id: uid(), date: new Date().toISOString(), mode: 'webhook', event: type, status: 'ok', detail: '', errors: [] };

        if (type === 'customer.created' || type === 'customer.updated') {
          const sq = data.customer;
          if (sq) {
            const sqToken = db.settings?.squareToken;
            // Phase 1: Fetch orders BEFORE acquiring the DB lock (async, no lock held)
            let initialOrders = [], extraOrders = [];
            try {
              if (sqToken) {
                const locationIds = await fetchLocationIds(sqToken);

                if (type === 'customer.updated') {
                  // Recent window only — enough to catch orders that triggered the update
                  // and discover any newly linked squareIds from them
                  const since = new Date(Date.now() - 2 * 60 * 60 * 1000).toISOString();
                  const r = await squarePost(sqToken, '/orders/search', {
                    location_ids: locationIds,
                    query: { filter: { customer_filter: { customer_ids: [sq.id] }, date_time_filter: { updated_at: { start_at: since } }, state_filter: { states: ['COMPLETED', 'OPEN'] } } },
                    limit: 10,
                  });
                  initialOrders = r.orders || [];
                } else {
                  // New customer: paginate through full order history
                  let cursor = null, pages = 0;
                  do {
                    const body = { location_ids: locationIds, query: { filter: { customer_filter: { customer_ids: [sq.id] } } }, limit: 500 };
                    if (cursor) body.cursor = cursor;
                    const r = await squarePost(sqToken, '/orders/search', body);
                    initialOrders.push(...(r.orders || []));
                    cursor = r.cursor;
                    pages++;
                  } while (cursor && pages < 10);
                }

                // Collect all customer_ids from returned orders → discover old/merged squareIds
                const seenIds   = new Set(initialOrders.map(o => o.customer_id).filter(Boolean));
                const newOldIds = [...seenIds].filter(id => id !== sq.id);

                // Fetch full order history for any newly discovered old squareIds
                if (newOldIds.length > 0) {
                  console.log(`[SquareWebhook] ${sq.id} — discovered ${newOldIds.length} linked squareId(s): ${newOldIds.join(', ')}`);
                  let cursor2 = null, pages2 = 0;
                  do {
                    const body = { location_ids: locationIds, query: { filter: { customer_filter: { customer_ids: newOldIds } } }, limit: 500 };
                    if (cursor2) body.cursor = cursor2;
                    const r = await squarePost(sqToken, '/orders/search', body);
                    extraOrders.push(...(r.orders || []));
                    cursor2 = r.cursor;
                    pages2++;
                  } while (cursor2 && pages2 < 10);
                }
              }
            } catch(e) {
              console.warn(`[SquareWebhook] Order fetch failed for ${sq.id}:`, e.message);
            }

            // Deduplicate orders by ID and collect the full set of discovered squareIds
            const orderMap = new Map();
            for (const o of [...initialOrders, ...extraOrders]) orderMap.set(o.id, o);
            const allOrders        = [...orderMap.values()];
            const allDiscoveredIds = new Set([sq.id, ...allOrders.map(o => o.customer_id).filter(Boolean)]);

            // Apply profile + link discovered squareIds + backfill — all atomically
            await withDB(freshDb => {
              const result = applySquareProfile(sq, freshDb);
              const phone  = sq.phone_number ? fmtPhone(sq.phone_number) : '';
              const freshC = freshDb.customers.find(x => (x.squareIds||[]).includes(sq.id))
                          || (phone ? freshDb.customers.find(x => fmtPhone(x.phone) === phone) : null);
              if (freshC) {
                log.detail = result === 'added'
                  ? `New customer: ${freshC.firstName} ${freshC.lastName}`.trim()
                  : `Updated: ${freshC.firstName} ${freshC.lastName}`.trim();
                console.log(`[SquareWebhook] ${result === 'added' ? 'Added' : 'Updated'} customer ${freshC.id}`);

                // Link any newly discovered old squareIds
                if (!Array.isArray(freshC.squareIds)) freshC.squareIds = [sq.id];
                let linked = 0;
                for (const id of allDiscoveredIds) {
                  if (!freshC.squareIds.includes(id)) { freshC.squareIds.push(id); linked++; }
                }
                if (linked) {
                  log.detail += ` | +${linked} squareId(s) linked`;
                  console.log(`[SquareWebhook] Linked ${linked} old squareId(s) to ${freshC.firstName} ${freshC.lastName}`);
                }

                // Backfill orders — skip already processed, skip orders with no payment tender
                if (!Array.isArray(freshDb.processedOrderIds)) freshDb.processedOrderIds = [];
                let backfilled = 0;
                for (const order of allOrders) {
                  if (freshDb.processedOrderIds.includes(order.id)) continue;
                  if (!order.tenders || order.tenders.length === 0) continue;
                  freshDb.processedOrderIds.unshift(order.id);
                  const amount = order.total_money?.amount || 0;
                  freshC.visits        = (freshC.visits || 0) + 1;
                  freshC.lifetimeSpend = (freshC.lifetimeSpend || 0) + amount;
                  const d = (order.closed_at || order.updated_at || '').split('T')[0];
                  if (d && (!freshC.lastVisit  || d > freshC.lastVisit)) freshC.lastVisit  = d;
                  if (d && result === 'added' && (!freshC.createdAt || d < freshC.createdAt)) freshC.createdAt = d;
                  backfilled++;
                }
                if (freshDb.processedOrderIds.length > 5000) freshDb.processedOrderIds.length = 5000;
                if (backfilled) {
                  log.detail += ` | Backfilled ${backfilled} order(s)`;
                  console.log(`[SquareWebhook] Backfilled ${backfilled} order(s) for ${freshC.firstName} ${freshC.lastName}`);
                }
              }
            });
          }
        }

        else if (type === 'order.created' || type === 'order.updated') {
          const state = (data.order_updated || data.order_created || {}).state;
          log.detail = `deferred to 11pm nightly sweep (${type}, state: ${state || '?'})`;
        }

        else if (type === 'loyalty.account.updated') {
          const acc     = data.loyalty_account;
          const sqToken = db.settings?.squareToken;
          if (acc) {
            // Fetch recent orders OUTSIDE the lock
            let backfillOrders = [];
            if (sqToken && acc.customer_id) {
              try {
                const since = new Date(Date.now() - 2 * 60 * 60 * 1000).toISOString();
                const ordersResult = await squarePost(sqToken, '/orders/search', {
                  location_ids: await fetchLocationIds(sqToken),
                  query: {
                    filter: {
                      customer_filter: { customer_ids: [acc.customer_id] },
                      date_time_filter: { updated_at: { start_at: since } },
                      state_filter: { states: ['COMPLETED', 'OPEN'] },
                    },
                  },
                  limit: 10,
                });
                backfillOrders = ordersResult.orders || [];
              } catch(e) {
                console.warn('[SquareWebhook] Recent order backfill (loyalty) failed:', e.message);
              }
            }

            await withDB(freshDb => {
              const sqIdMap = buildSqIdMap(freshDb.customers);
              let c = acc.customer_id ? sqIdMap[acc.customer_id] : null;
              if (!c && acc.mapping?.phone_number) {
                c = freshDb.customers.find(x => x.phone === fmtPhone(acc.mapping.phone_number));
              }
              if (c) {
                c.loyaltyPoints = acc.balance || 0;
                log.detail = `Loyalty: ${c.firstName} ${c.lastName} — ${c.loyaltyPoints} pts`;
                console.log(`[SquareWebhook] Loyalty updated for ${c.firstName} — ${c.loyaltyPoints} pts`);

                if (backfillOrders.length) {
                  if (!Array.isArray(freshDb.processedOrderIds)) freshDb.processedOrderIds = [];
                  let backfilled = 0;
                  for (const order of backfillOrders) {
                    if (freshDb.processedOrderIds.includes(order.id)) continue;
                    if (!order.tenders || order.tenders.length === 0) continue;
                    freshDb.processedOrderIds.unshift(order.id);
                    const amount = order.total_money?.amount || 0;
                    c.visits        = (c.visits || 0) + 1;
                    c.lifetimeSpend = (c.lifetimeSpend || 0) + amount;
                    const d = (order.closed_at || order.updated_at || '').split('T')[0];
                    if (d && (!c.lastVisit || d > c.lastVisit)) c.lastVisit = d;
                    backfilled++;
                  }
                  if (freshDb.processedOrderIds.length > 5000) freshDb.processedOrderIds.length = 5000;
                  if (backfilled) {
                    log.detail += ` | Backfilled ${backfilled} order(s)`;
                    console.log(`[SquareWebhook] Backfilled ${backfilled} recent order(s) via loyalty for ${c.firstName} ${c.lastName}`);
                  }
                }
              }
            });
          }
        }

        else if (type === 'loyalty.event.created') {
          const evt   = data.loyalty_event;
          const token = db.settings?.squareToken;
          if (evt && token) {
            const eventType = evt.type;
            const accountId = evt.loyalty_account_id;
            try {
              // Fetch fresh account OUTSIDE the lock
              const result = await squareGet(token, `/loyalty/accounts/${accountId}`);
              const acc    = result.loyalty_account;
              if (acc) {
                await withDB(freshDb => {
                  const sqIdMap = buildSqIdMap(freshDb.customers);
                  let c = acc.customer_id ? sqIdMap[acc.customer_id] : null;
                  if (!c && acc.mapping?.phone_number) {
                    c = freshDb.customers.find(x => x.phone === fmtPhone(acc.mapping.phone_number));
                  }
                  if (c) {
                    c.loyaltyPoints = acc.balance || 0;
                    log.detail = `Loyalty event (${eventType}): ${c.firstName} ${c.lastName} — ${c.loyaltyPoints} pts`;
                    console.log(`[SquareWebhook] Loyalty event ${eventType} for ${c.firstName} — balance now ${c.loyaltyPoints} pts`);
                  } else {
                    log.detail = `Loyalty event (${eventType}): account ${accountId} not matched to CRM customer`;
                  }
                });
              }
            } catch(e) {
              log.detail = `Loyalty event (${eventType}): fetch failed — ${e.message}`;
              log.status = 'partial';
            }
          }
        }

        else if (type === 'customer.deleted') {
          const sqId = event.data?.id;
          if (sqId) {
            await withDB(freshDb => {
              const c = freshDb.customers.find(x => (x.squareIds || []).includes(sqId));
              if (c) {
                c.squareIds = c.squareIds.filter(id => id !== sqId);
                log.detail = `Customer deleted from Square: ${c.firstName} ${c.lastName} (squareId removed)`;
              } else {
                log.detail = `Customer deleted (not in CRM: ${sqId})`;
              }
            });
          }
        }

        else {
          log.detail = `Unhandled event type`;
        }

        await withDB(freshDb => {
          if (!Array.isArray(freshDb.syncLogs)) freshDb.syncLogs = [];
          freshDb.syncLogs.unshift(log);
          if (freshDb.syncLogs.length > 200) freshDb.syncLogs.length = 200;
        });

        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ ok: true }));
      } catch(e) {
        console.error('[SquareWebhook] error:', e.message);
        res.writeHead(500, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: e.message }));
      }
    });
    return;
  }

  // Inbound SMS webhook — GET (Cellcast URL verification)
  if (req.method === 'GET' && (req.url.startsWith('/api/sms-inbound') || req.url.startsWith('/webhook'))) {
    res.writeHead(200, { 'Content-Type': 'text/plain', ...CORS });
    res.end('OK');
    return;
  }

  // Inbound SMS webhook — POST (customer reply received)
  if (req.method === 'POST' && (req.url.startsWith('/api/sms-inbound') || req.url.startsWith('/webhook'))) {
    let raw = '';
    req.on('data', chunk => raw += chunk);
    req.on('end', async () => {
      try {
        let payload = {};
        const ct = (req.headers['content-type'] || '').toLowerCase();
        if (ct.includes('application/json')) {
          try { payload = JSON.parse(raw); } catch(e) {}
        } else {
          const qs = raw || (req.url.split('?')[1] || '');
          for (const [k, v] of new URLSearchParams(qs)) payload[k] = v;
        }
        console.log('[InboundSMS] raw payload:', JSON.stringify(payload).slice(0, 300));

        // Store raw payload immediately in separate log — survives main DB issues
        withPayloads(p => {
          if (!Array.isArray(p.cellcast)) p.cellcast = [];
          p.cellcast.unshift({ id: uid(), receivedAt: new Date().toISOString(), raw: payload });
        });

        // Cellcast opt-out webhook: {"type":"optout","contact":"404000000",...}
        if (payload.type === 'optout') {
          const phone = fmtPhone(String(payload.contact || '').trim());
          if (!phone) {
            res.writeHead(400, { 'Content-Type': 'application/json', ...CORS });
            res.end(JSON.stringify({ error: 'Missing contact in opt-out payload' }));
            return;
          }
          await withDB(freshDb => {
            if (!Array.isArray(freshDb.optOuts)) freshDb.optOuts = [];
            if (!freshDb.optOuts.includes(phone)) freshDb.optOuts.push(phone);
            // Also save to smsReplies so the STOP shows up in the chat UI
            const c = freshDb.customers.find(x => x.phone && fmtPhone(x.phone) === phone);
            if (c) {
              if (!Array.isArray(c.smsReplies)) c.smsReplies = [];
              const alreadyLogged = c.smsReplies.some(r => r.message === 'STOP' && r.optout);
              if (!alreadyLogged) c.smsReplies.unshift({ from: phone, message: 'STOP', receivedAt: new Date().toISOString(), optout: true });
            }
          });
          console.log(`[InboundSMS] Opt-out recorded for ${phone}`);
          res.writeHead(200, { 'Content-Type': 'application/json', ...CORS });
          res.end(JSON.stringify({ ok: true, optout: phone }));
          return;
        }

        const result = await withDB(freshDb => {
          // Ignore delivery receipts — only process inbound replies
          if (payload.type && payload.type !== 'receive') {
            return { ignored: true, type: payload.type };
          }

          const fromRaw = payload.sender || payload.from || payload.source || payload.mobile || payload.msisdn || '';
          // Cellcast: "reply" = customer's inbound text, "message" = outbound campaign text sent to customer
          const message = payload.reply || payload.body || payload.text || payload.msg || payload.content || payload.message || '';
          const from    = fmtPhone(fromRaw);
          if (!from || !message) return { missing: true };

          const c    = freshDb.customers.find(x => x.phone && fmtPhone(x.phone) === from);
          const name = c ? [c.firstName, c.lastName].filter(Boolean).join(' ') || from : '(unknown)';

          // Auto-detect birthday in DDMMYYYY format
          let birthdaySaved = false;
          const bdayMatch = message.trim().match(/^(\d{2})(\d{2})(\d{4})$/);
          if (bdayMatch && c) {
            const [, dd, mm, yyyy] = bdayMatch;
            const d = parseInt(dd), mo = parseInt(mm), yr = parseInt(yyyy);
            if (mo >= 1 && mo <= 12 && d >= 1 && d <= 31 && yr >= 1900 && yr <= 2100) {
              c.birthday = `${yyyy}-${mm.padStart(2,'0')}-${dd.padStart(2,'0')}`;
              birthdaySaved = true;
              console.log(`[InboundSMS] Birthday saved for ${name}: ${c.birthday}`);
            }
          }

          if (c) {
            if (!Array.isArray(c.smsReplies)) c.smsReplies = [];
            c.smsReplies.unshift({ from, message, receivedAt: new Date().toISOString(), birthdaySaved });
          }
          console.log(`[InboundSMS] from ${from}: "${message}" → ${name}`);
          return { ok: true, customer: name, birthdaySaved, birthday: c ? c.birthday : null };
        });

        if (result.ignored) {
          res.writeHead(200, { 'Content-Type': 'application/json', ...CORS });
          res.end(JSON.stringify({ ok: true, ignored: true, type: result.type }));
        } else if (result.missing) {
          res.writeHead(400, { 'Content-Type': 'application/json', ...CORS });
          res.end(JSON.stringify({ error: 'Missing from/message' }));
        } else {
          res.writeHead(200, { 'Content-Type': 'application/json', ...CORS });
          res.end(JSON.stringify(result));
        }
      } catch(e) {
        console.error('[InboundSMS] error:', e.message);
        res.writeHead(500, { 'Content-Type': 'application/json', ...CORS });
        res.end(JSON.stringify({ error: e.message }));
      }
    });
    return;
  }

  // ── Feedback: auto-send queue (customers with lastVisit = yesterday Perth) ──
  if (req.url === '/api/feedback-auto-queue' && req.method === 'GET') {
    const db        = loadDB();
    const optOuts   = new Set(db.optOuts || []);
    const yesterday = perthDateStr(-1);
    const weekStart = perthDateStr(-7);
    const queue = (db.customers || []).filter(c =>
      c.phone &&
      isAuPhone(c.phone) &&
      !optOuts.has(c.phone) &&
      !c.googleReviewDone &&
      c.lastVisit >= weekStart &&
      c.lastVisit <= yesterday
    ).map(c => ({ id: c.id, firstName: c.firstName, lastName: c.lastName, phone: c.phone, lastVisit: c.lastVisit }));
    res.writeHead(200, { 'Content-Type': 'application/json', ...CORS });
    res.end(JSON.stringify({ ok: true, dateFrom: weekStart, dateTo: yesterday, queue }));
    return;
  }

  // ── Feedback: send SMS requests ─────────────────────────────────────────────
  if (req.url === '/api/feedback-send' && req.method === 'POST') {
    let body = '';
    req.on('data', c => body += c);
    req.on('end', async () => {
      try {
        const { customerIds, testMode, baseUrl, template } = JSON.parse(body);
        const db      = loadDB();
        const apiKey  = db.settings?.cellcastKey;
        const sender  = db.settings?.cellcastSender || null;
        const testPhone = db.settings?.testPhone;
        const base    = (baseUrl || db.settings?.crmBaseUrl || db.settings?.feedbackBaseUrl || 'https://crm.woodpeckers.pizza').replace(/\/$/, '');

        if (!apiKey)              throw new Error('Cellcast API key not configured — set it in Settings.');
        if (!customerIds?.length) throw new Error('No customers selected.');
        if (testMode && !testPhone) throw new Error('Test phone not configured — set it in Settings.');

        const optOuts = new Set(db.optOuts || []);
        const sentAt  = new Date().toISOString();
        const newTokens  = [];
        const toSend     = [];

        for (const custId of customerIds) {
          const cust = (db.customers || []).find(c => c.id === custId);
          if (!cust || !cust.phone) continue;
          if (!testMode && cust.googleReviewDone) continue;
          if (!testMode && !isAuPhone(cust.phone)) continue;
          const destPhone = testMode ? testPhone : cust.phone;
          if (!testMode && optOuts.has(cust.phone)) continue;

          const token = uid();
          const link  = `${base}/fb?t=${token}`;
          const name  = (cust.firstName || '').trim();
          const tpl   = template || 'Hi {name}, how was your Woodpeckers Murdoch order? {link}\nReply STOP to opt out.';
          const msg   = tpl.replace('{name}', name || 'there').replace('{link}', link);

          newTokens.push({ token, customerId: custId, orderId: '', createdAt: sentAt, usedAt: null, rating: null, remarks: '', googleReviewClicked: false });
          toSend.push({ custId, number: destPhone, firstName: cust.firstName || '', msg });
        }

        if (!toSend.length) throw new Error('No eligible customers — they may all have completed a Google review or have no phone.');

        // Persist tokens before sending so they exist even if send partially fails
        await withDB(freshDb => {
          if (!freshDb.feedbackTokens) freshDb.feedbackTokens = [];
          for (const t of newTokens) freshDb.feedbackTokens.push(t);
        });

        let sent = 0;
        const errors = [];
        for (const r of toSend) {
          try {
            const payload = { message: r.msg, contacts: [r.number], reply_url: `${base}/webhook` };
            if (sender) payload.sender = sender;
            await cellcastPost(apiKey, payload);
            sent++;
          } catch (e) {
            errors.push({ number: r.number, error: e.message });
          }
        }

        await withDB(freshDb => {
          if (!freshDb.campaigns) freshDb.campaigns = [];
          freshDb.campaigns.unshift({
            id: uid(), date: sentAt,
            message: `Feedback request (personalised link)`,
            sender: sender || '#SharedNum#',
            segment: testMode ? 'Feedback SMS — Test' : 'Feedback SMS',
            recipientCount: sent,
            recipients: toSend.map(r => r.number),
            status: sent > 0 ? 'sent' : 'failed',
          });
          if (!freshDb.smsLog) freshDb.smsLog = [];
          for (const r of toSend) {
            const cust = (freshDb.customers || []).find(c => c.id === r.custId);
            if (!cust) continue;
            if (!Array.isArray(cust.smsSent)) cust.smsSent = [];
            cust.smsSent.unshift({ message: r.msg, sentAt, label: testMode ? 'Feedback SMS (Test)' : 'Feedback SMS' });
            if (!testMode) {
              freshDb.smsLog.push({
                id: uid(), phone: cust.phone, triggerType: 'feedback',
                visitReferenceDate: cust.lastVisit || null,
                sentAt, messageBody: r.msg, status: 'sent',
              });
            }
          }
        });

        res.writeHead(200, { 'Content-Type': 'application/json', ...CORS });
        res.end(JSON.stringify({ ok: true, sent, errors }));
      } catch (e) {
        res.writeHead(500, { 'Content-Type': 'application/json', ...CORS });
        res.end(JSON.stringify({ ok: false, error: e.message }));
      }
    });
    return;
  }

  // ── Feedback: validate token ────────────────────────────────────────────────
  if (req.url.startsWith('/api/feedback/check') && req.method === 'GET') {
    const token = new URL(req.url, 'http://x').searchParams.get('t');
    const db = loadDB();
    const rec = (db.feedbackTokens || []).find(r => r.token === token);
    res.writeHead(200, { 'Content-Type': 'application/json', ...CORS });
    if (!rec) return res.end(JSON.stringify({ ok: false, reason: 'invalid' }));
    if (rec.usedAt) return res.end(JSON.stringify({ ok: false, reason: 'used' }));
    res.end(JSON.stringify({ ok: true }));
    return;
  }

  // ── Feedback: submit rating + remarks ───────────────────────────────────────
  if (req.url === '/api/feedback' && req.method === 'POST') {
    let body = '';
    req.on('data', c => body += c);
    req.on('end', () => {
      try {
        const { token, rating, remarks } = JSON.parse(body);
        withDB(db => {
          const rec = (db.feedbackTokens || []).find(r => r.token === token);
          if (!rec || rec.usedAt) return;
          rec.usedAt  = new Date().toISOString();
          rec.rating  = Number(rating);
          rec.remarks = remarks || '';
          const cust = (db.customers || []).find(c => c.id === rec.customerId);
          if (cust) {
            if (!cust.feedbackHistory) cust.feedbackHistory = [];
            cust.feedbackHistory.push({
              sentAt:              rec.createdAt,
              token:               token,
              rating:              rec.rating,
              remarks:             rec.remarks,
              clickedGoogleReview: false,
            });
          }
        });
        res.writeHead(200, { 'Content-Type': 'application/json', ...CORS });
        res.end(JSON.stringify({ ok: true }));
      } catch (e) {
        res.writeHead(400, { 'Content-Type': 'application/json', ...CORS });
        res.end(JSON.stringify({ ok: false }));
      }
    });
    return;
  }

  // ── Feedback: record Google Review click + redirect ─────────────────────────
  if (req.url.startsWith('/api/feedback/redirect') && req.method === 'GET') {
    const token = new URL(req.url, 'http://x').searchParams.get('t');
    withDB(db => {
      const rec = (db.feedbackTokens || []).find(r => r.token === token);
      if (!rec) return;
      rec.googleReviewClicked = true;
      const cust = (db.customers || []).find(c => c.id === rec.customerId);
      if (cust) {
        cust.googleReviewDone = true;
        const entry = (cust.feedbackHistory || []).slice().reverse().find(h => h.token === token);
        if (entry) entry.clickedGoogleReview = true;
      }
    });
    res.writeHead(302, { Location: 'https://g.page/r/CeYL1u9Z2or0EAI/review' });
    res.end();
    return;
  }

  // Static files
  let url = req.url.split('?')[0];
  if (url === '/') url = '/index.html';
  if (url === '/fb') url = '/feedback.html';
  let fp = path.join(__dirname, url);
  if ((!fs.existsSync(fp) || !fs.statSync(fp).isFile()) && fs.existsSync(fp + '.html')) fp = fp + '.html';
  if (!fs.existsSync(fp) || !fs.statSync(fp).isFile()) { res.writeHead(404); res.end('Not found'); return; }
  res.writeHead(200, { 'Content-Type': MIME[path.extname(fp)] || 'text/plain' });
  fs.createReadStream(fp).pipe(res);
});

server.listen(PORT, '0.0.0.0', () => {
  console.log(`Restaurant CRM running at http://localhost:${PORT}`);
  console.log('Accessible on network at http://<NAS-IP>:3001');
});

// ── Graceful shutdown — let in-flight DB writes finish before exiting ──────────
function gracefulShutdown(signal) {
  console.log(`[Shutdown] ${signal} — waiting for in-flight writes…`);
  const killer = setTimeout(() => {
    console.error('[Shutdown] Timed out — forcing exit');
    process.exit(1);
  }, 10_000);
  _dbQueue.finally(() => {
    clearTimeout(killer);
    console.log('[Shutdown] Clean exit');
    process.exit(0);
  });
}
process.on('SIGTERM', () => gracefulShutdown('SIGTERM'));
process.on('SIGINT',  () => gracefulShutdown('SIGINT'));

// ── AUTOMATION HELPERS ─────────────────────────────────────────────────────────
const DEFAULT_AUTOMATIONS = [
  { id: 'welcome',       config: { maxDaysSinceFirstVisit: 3 } },
  { id: 'loyalty_ready', config: { pointsThreshold: 5, minDaysSinceVisit: 21 } },
  { id: 'loyalty_near',  config: { pointsThreshold: 5, nearWithin: 1, minDaysSinceVisit: 21 } },
  { id: 'winback',       config: { minDays: 90, maxDays: 365, rewardThreshold: 5 },
    templateReward:  'Hi {first_name}! We miss you at Woodpeckers Murdoch! You still have a Birdies reward waiting — don\'t let it go to waste. Come back and claim it soon! Reply STOP to unsubscribe.',
    templateMissYou: 'Hi {first_name}! It\'s been a while — we miss you! Show this message to our staff for $8 OFF any pizza, in-store only. Valid until {expiry_date}. Woodpeckers Murdoch. Reply STOP to unsubscribe.' },
  { id: 'last_chance', name: 'Last Chance', icon: '🚨',
    description: 'Final re-engagement sent 90 days after the win-back SMS. Reward reminder for 5+ pts, 50% off offer for everyone else.',
    enabled: false,
    templateReward:  'Hi {first_name}! We really miss you at Woodpeckers Murdoch! Your Birdies reward is still waiting — come back and treat yourself. Reply STOP to unsubscribe.',
    templateMissYou: 'Hi {first_name}! We miss you! 50% OFF any pizza — show to staff, in-store only. Valid til {expiry_date}. Woodpeckers Murdoch. Reply STOP to opt out.',
    config: { daysSinceWinback: 90, rewardThreshold: 5 },
    sentTo: {}, lastRunAt: null, lastRunStats: null },
  { id: 'birthday',      config: {} },
];

// Mirror of client-side classifyCustomer — evaluates segment conditions against a customer
function getCustomerSegment(c, segments) {
  if (c.segment) return c.segment; // manual override wins
  const now = new Date();
  const fields = {
    visits:             c.visits || 0,
    lifetimeSpend:      (c.lifetimeSpend || 0) / 100,
    daysSinceLastVisit: c.lastVisit ? Math.floor((now - new Date(c.lastVisit)) / 86400000) : 9999,
    daysSinceJoined:    c.createdAt ? Math.floor((now - new Date(c.createdAt)) / 86400000) : 9999,
    loyaltyPoints:      c.loyaltyPoints || 0,
  };
  for (const seg of (segments || [])) {
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

function getAutomationQueue(auto, customers, optOuts, smsLog, segments) {
  const now    = new Date();
  const sentTo = auto.sentTo || {};
  const log    = smsLog || [];

  // Returns true if this trigger already fired for the customer's current visit cycle
  function sentThisVisit(phone, triggerType, visitDate) {
    return log.some(e =>
      e.phone === phone &&
      e.triggerType === triggerType &&
      e.visitReferenceDate === visitDate &&
      e.status === 'sent'
    );
  }

  return customers.filter(c => {
    if (!c.phone || optOuts.includes(c.phone)) return false;
    if (getCustomerSegment(c, segments) === 'Dead') return false;

    switch (auto.id) {
      case 'welcome': {
        if ((c.visits || 0) !== 0) return false;
        if (!c.createdAt) return false;
        const days = (now - new Date(c.createdAt)) / 86400000;
        const minDays = (auto.config && auto.config.minDaysSinceJoined) || 7;
        const maxDays = (auto.config && auto.config.maxDaysSinceFirstVisit) || 30;
        if (days < minDays || days > maxDays) return false;
        return !sentTo[c.phone];
      }
      case 'loyalty_ready': {
        const pts = c.loyaltyPoints || 0;
        if (pts < ((auto.config && auto.config.pointsThreshold) || 5)) return false;
        if (!c.lastVisit) return false;
        const daysSince = (now - new Date(c.lastVisit)) / 86400000;
        const minDays   = (auto.config && auto.config.minDaysSinceVisit) || 21;
        // Window: minDays to 89 days — beyond that is win-back territory
        if (daysSince < minDays || daysSince >= ((auto.config && auto.config.winbackMinDays) || 90)) return false;
        return !sentThisVisit(c.phone, 'loyalty_ready', c.lastVisit);
      }
      case 'loyalty_near': {
        const pts       = c.loyaltyPoints || 0;
        const threshold = (auto.config && auto.config.pointsThreshold) || 5;
        const near      = (auto.config && auto.config.nearWithin) || 1;
        if (pts >= threshold || pts < threshold - near) return false;
        if (!c.lastVisit) return false;
        const daysSince = (now - new Date(c.lastVisit)) / 86400000;
        const minDays   = (auto.config && auto.config.minDaysSinceVisit) || 21;
        // Window: minDays to 89 days — beyond that is win-back territory
        if (daysSince < minDays || daysSince >= ((auto.config && auto.config.winbackMinDays) || 90)) return false;
        return !sentThisVisit(c.phone, 'loyalty_near', c.lastVisit);
      }
      case 'winback': {
        if (!c.lastVisit) return false;
        const days = (now - new Date(c.lastVisit)) / 86400000;
        if (days < ((auto.config && auto.config.minDays) || 90) ||
            days > ((auto.config && auto.config.maxDays) || 365)) return false;
        return !sentThisVisit(c.phone, 'winback', c.lastVisit);
      }
      case 'last_chance': {
        // Fires 90 days after the win-back SMS was sent, provided customer hasn't returned since
        const winbackEntry = log
          .filter(e => e.phone === c.phone && e.triggerType === 'winback' && e.status === 'sent')
          .sort((a, b) => new Date(b.sentAt) - new Date(a.sentAt))[0];
        if (!winbackEntry) return false;
        if ((now - new Date(winbackEntry.sentAt)) / 86400000 < ((auto.config && auto.config.daysSinceWinback) || 90)) return false;
        // If customer visited after the win-back was sent, they restarted the cycle — not eligible
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

function personalizeAutoMessage(template, customer, auto) {
  const threshold = (auto.config && auto.config.pointsThreshold) || 5;
  const pts = customer.loyaltyPoints || 0;
  const expiry = new Date(Date.now() + 7 * 24 * 60 * 60 * 1000)
    .toLocaleDateString('en-AU', { day: 'numeric', month: 'short', year: 'numeric', timeZone: 'Australia/Perth' });
  return template
    .replace(/\{first_name\}/gi, customer.firstName || 'there')
    .replace(/\{name\}/gi, [customer.firstName, customer.lastName].filter(Boolean).join(' ') || 'there')
    .replace(/\{loyalty_points\}/gi, pts)
    .replace(/\{points_needed\}/gi, Math.max(0, threshold - pts))
    .replace(/\{expiry_date\}/gi, expiry);
}

// ── AUTO LOYALTY SYNC ──────────────────────────────────────────────────────────
// Auto-sync removed — using Square webhooks for real-time updates instead.

// ── AUTOMATION DAILY JOB (5pm Perth / 09:00 UTC) ──────────────────────────────
async function runAllAutomations() {
  // Read settings and automation config up-front (no mutations yet)
  const initDb = loadDB();
  const automations = initDb.automations || [];
  const enabled = automations.filter(a => a.enabled);
  if (!enabled.length) { console.log('[Automations] No enabled automations.'); return; }

  const apiKey = initDb.settings?.cellcastKey;
  const sender = initDb.settings?.cellcastSender || null;
  if (!apiKey) { console.log('[Automations] No Cellcast API key — skipping.'); return; }

  const now = new Date();
  console.log(`[Automations] Running ${enabled.length} automation(s)…`);

  // Phase 1: Compute queues and execute sends (no DB mutations)
  const results = [];
  for (const auto of enabled) {
    try {
      const queue = getAutomationQueue(auto, initDb.customers, initDb.optOuts || [], initDb.smsLog || [], initDb.segments || []);
      if (!queue.length) { console.log(`[Automations] ${auto.name}: 0 in queue, skipping.`); continue; }

      const { safe: safeQueue, blocked } = applyGuards(
        queue.map(c => ({ ...c, number: c.phone })), initDb, { skipHoursCheck: true }
      );
      console.log(`[Automations] ${auto.name}: ${queue.length} in queue, ${safeQueue.length} after guards (opt-out:${blocked.optOut} tooSoon:${blocked.tooSoon} dupe:${blocked.duplicate} nonAu:${blocked.nonAu}), sending…`);
      if (!safeQueue.length) { console.log(`[Automations] ${auto.name}: all blocked, skipping.`); continue; }

      const sentRecords = [];
      const errors = [];
      const isWinbackAuto     = auto.id === 'winback' || auto.id === 'last_chance';
      const autoRewardThresh  = (auto.config && auto.config.rewardThreshold) || 5;
      for (const c of safeQueue) {
        try {
          const tplForCustomer = isWinbackAuto
            ? ((c.loyaltyPoints || 0) >= autoRewardThresh ? (auto.templateReward || '') : (auto.templateMissYou || ''))
            : auto.template;
          const msg = personalizeAutoMessage(tplForCustomer, c, auto);
          await sendCellcastSMS(apiKey, sender, [{ number: c.phone, firstName: c.firstName || '', name: [c.firstName, c.lastName].filter(Boolean).join(' ') }], msg);
          const key = auto.id === 'birthday' ? `${c.phone}_${now.getFullYear()}` : c.phone;
          sentRecords.push({ phone: c.phone, lastVisit: c.lastVisit || null, msg, key });
        } catch(e) {
          errors.push(`${c.phone}: ${e.message}`);
        }
      }
      console.log(`[Automations] ${auto.name}: sent ${sentRecords.length}, errors ${errors.length}.`);
      results.push({ autoId: auto.id, autoName: auto.name, template: auto.template, sentRecords, errors, queueLength: queue.length });
    } catch(e) {
      console.error(`[Automations] ${auto.name} failed:`, e.message);
    }
  }

  if (!results.length) { console.log('[Automations] Daily run complete (nothing sent).'); return; }

  // Phase 2: Apply all mutations atomically on a fresh DB state
  await withDB(freshDb => {
    for (const r of results) {
      const auto = (freshDb.automations || []).find(a => a.id === r.autoId);
      if (auto) {
        if (!auto.sentTo) auto.sentTo = {};
        for (const { key } of r.sentRecords) auto.sentTo[key] = now.toISOString();
        auto.lastRunAt    = now.toISOString();
        auto.lastRunStats = { sent: r.sentRecords.length, skipped: r.queueLength - r.sentRecords.length, errors: r.errors.length };
      }
      if (!freshDb.smsLog) freshDb.smsLog = [];
      for (const { phone, lastVisit, msg } of r.sentRecords) {
        recordSMSSent(freshDb, phone, msg, r.autoName || 'Automation');
        freshDb.smsLog.push({
          id: uid(), phone, triggerType: r.autoId,
          visitReferenceDate: lastVisit,
          sentAt: now.toISOString(), messageBody: msg, status: 'sent',
        });
      }
      if (!freshDb.campaigns) freshDb.campaigns = [];
      freshDb.campaigns.unshift({
        id: uid(), date: now.toISOString(),
        message: r.template, sender: sender || '#SharedNum#',
        segment: `Auto: ${r.autoName}`,
        recipientCount: r.sentRecords.length,
        recipients: r.sentRecords.map(x => x.phone),
        status: r.errors.length ? 'partial' : 'sent',
      });
    }
  });
  console.log('[Automations] Daily run complete.');
}

function scheduleAutomations() {
  const now    = new Date();
  const next5pm  = new Date(now);
  next5pm.setUTCHours(9, 0, 0, 0); // 09:00 UTC = 5pm Perth (AWST UTC+8)
  if (next5pm <= now) next5pm.setUTCDate(next5pm.getUTCDate() + 1);
  const msUntil = next5pm - now;
  console.log(`[Automations] First daily run in ${Math.round(msUntil / 60000)} min (at 5pm Perth time).`);
  setTimeout(() => {
    runAllAutomations();
    setInterval(runAllAutomations, 24 * 60 * 60 * 1000);
  }, msUntil);
}
scheduleAutomations();

// ── Ensure any new automations added in DEFAULT_AUTOMATIONS exist in the DB ────
(function migrateAutomations() {
  const db = loadDB();
  const existing = db.automations || [];
  const existingIds = new Set(existing.map(a => a.id));
  const toAdd = DEFAULT_AUTOMATIONS.filter(a => !existingIds.has(a.id));
  // Patch missing display fields on automations already in the DB
  const fieldsToMerge = ['name', 'icon', 'description'];
  let patched = 0;
  for (const auto of existing) {
    const def = DEFAULT_AUTOMATIONS.find(d => d.id === auto.id);
    if (!def) continue;
    for (const f of fieldsToMerge) {
      if (!auto[f] && def[f]) { auto[f] = def[f]; patched++; }
    }
  }
  if (!toAdd.length && !patched) return;
  db.automations = [...existing, ...toAdd];
  saveDB(db);
  if (toAdd.length) console.log(`[Migration] Added automation(s): ${toAdd.map(a => a.id).join(', ')}`);
  if (patched)      console.log(`[Migration] Patched ${patched} missing field(s) on existing automations.`);
})();

// ── Scheduled loyalty + incremental orders sync (every 6h) ───────────────────
async function runLoyaltyOnlySync() {
  console.log('[AutoSync] Starting scheduled loyalty + orders sync…');

  // Read settings only — no mutations yet
  const initDb = loadDB();
  const token = initDb.settings?.squareToken;
  if (!token) { console.warn('[AutoSync] No Square token — skipping.'); return; }

  const syncStart       = new Date().toISOString();
  const lastOrderSyncAt = initDb.lastOrderSyncAt || null;
  const log = { id: uid(), date: syncStart, mode: 'auto', event: 'loyalty.sync', status: 'ok', detail: '', errors: [] };

  try {
    // ── Phase 1: Gather all data from Square API (no DB mutations) ────────────

    // 1a. Loyalty accounts
    const allAccounts = await fetchAllLoyaltyAccounts(token);

    // 1b. Incremental orders (paginated)
    const locationIds = await fetchLocationIds(token);
    const rawOrders = [];
    let cursor = null, pageCount = 0;
    do {
      const result = await fetchOrdersPage(token, locationIds, cursor, lastOrderSyncAt);
      pageCount++;
      for (const order of result.orders) {
        if (order.tenders && order.tenders.length > 0 && order.customer_id) rawOrders.push(order);
      }
      cursor = result.cursor;
    } while (cursor);

    // 1c. Batch-fetch profiles for customers with new orders
    const activeSquareIds = [...new Set(rawOrders.map(o => o.customer_id))];
    const profilesById = {};
    for (let i = 0; i < activeSquareIds.length; i += 100) {
      const responses = await fetchCustomersBatch(token, activeSquareIds.slice(i, i + 100));
      Object.assign(profilesById, responses);
    }

    // ── Phase 2: Apply everything atomically on a fresh DB state ─────────────
    await withDB(freshDb => {
      const sqIdMap = buildSqIdMap(freshDb.customers);

      // Loyalty points
      let loyaltyUpdated = 0;
      for (const account of allAccounts) {
        let c = account.customer_id ? sqIdMap[account.customer_id] : null;
        if (!c && account.mapping?.phone_number) {
          c = freshDb.customers.find(x => x.phone === fmtPhone(account.mapping.phone_number));
        }
        if (c) { c.loyaltyPoints = account.balance || 0; loyaltyUpdated++; }
      }

      // New orders — skip any already counted by a webhook or previous sync
      if (!Array.isArray(freshDb.processedOrderIds)) freshDb.processedOrderIds = [];
      const processedSet = new Set(freshDb.processedOrderIds);
      const visitMap = {};
      let skipped = 0, deferred = 0;
      for (const order of rawOrders) {
        if (processedSet.has(order.id)) { skipped++; continue; }
        const cid = order.customer_id;
        if (!sqIdMap[cid]) { deferred++; continue; } // unknown squareId — leave for NightlySweep
        processedSet.add(order.id);
        freshDb.processedOrderIds.unshift(order.id);
        if (!visitMap[cid]) visitMap[cid] = { count: 0, lastDate: null, spend: 0 };
        visitMap[cid].count++;
        visitMap[cid].spend += order.total_money?.amount || 0;
        const d = order.closed_at || order.created_at;
        if (d && (!visitMap[cid].lastDate || d > visitMap[cid].lastDate)) visitMap[cid].lastDate = d;
      }
      if (freshDb.processedOrderIds.length > 5000) freshDb.processedOrderIds.length = 5000;

      // Apply visit delta
      let visitsUpdated = 0;
      for (const [, { count, spend, lastDate, customer: c }] of aggregateVisits(visitMap, sqIdMap)) {
        c.visits        = (c.visits || 0) + count;
        c.lifetimeSpend = (c.lifetimeSpend || 0) + spend;
        if (lastDate) { const d = lastDate.split('T')[0]; if (!c.lastVisit || d > c.lastVisit) c.lastVisit = d; }
        visitsUpdated++;
      }

      // Apply customer profiles
      let profilesUpdated = 0, profilesAdded = 0;
      for (const [, entry] of Object.entries(profilesById)) {
        if (entry && entry.customer) {
          const r = applySquareProfile(entry.customer, freshDb);
          if (r === 'added') profilesAdded++; else profilesUpdated++;
        }
      }

      freshDb.lastOrderSyncAt = syncStart;
      const mode = lastOrderSyncAt ? 'incremental' : 'full';
      log.detail = `Auto sync (${mode}) — loyalty: ${loyaltyUpdated}, visits: ${visitsUpdated}, profiles: ${profilesUpdated}+${profilesAdded}, order pages: ${pageCount}, skipped (already counted): ${skipped}, deferred (unknown squareId): ${deferred}`;
      console.log(`[AutoSync] Done — ${log.detail}`);

      if (!Array.isArray(freshDb.syncLogs)) freshDb.syncLogs = [];
      freshDb.syncLogs.unshift(log);
      if (freshDb.syncLogs.length > 200) freshDb.syncLogs.length = 200;
    });

  } catch (e) {
    log.status = 'error';
    log.detail = `Auto sync failed: ${e.message}`;
    console.error('[AutoSync] Error:', e.message);
    await withDB(freshDb => {
      if (!Array.isArray(freshDb.syncLogs)) freshDb.syncLogs = [];
      freshDb.syncLogs.unshift(log);
      if (freshDb.syncLogs.length > 200) freshDb.syncLogs.length = 200;
    });
  }
}

async function runCellcastOptoutSync() {
  const db     = loadDB();
  const apiKey = db.settings?.cellcastKey;
  if (!apiKey) { console.log('[OptoutSync] No Cellcast API key — skipping.'); return; }
  try {
    const optouts = await fetchAllCellcastOptouts(apiKey);
    let added = 0;
    await withDB(freshDb => {
      if (!Array.isArray(freshDb.optOuts)) freshDb.optOuts = [];
      const existing = new Set(freshDb.optOuts);
      for (const phone of optouts) {
        if (phone && !existing.has(phone)) { freshDb.optOuts.push(phone); existing.add(phone); added++; }
      }
    });
    console.log(`[OptoutSync] Done — ${added} new opt-outs added, ${optouts.length} total.`);
  } catch (e) {
    console.error('[OptoutSync] Error:', e.message);
  }
}

// First run 15s after startup, then every 6 hours
setTimeout(() => {
  runLoyaltyOnlySync();
  runCellcastOptoutSync();
  setInterval(() => { runLoyaltyOnlySync(); runCellcastOptoutSync(); }, 6 * 60 * 60 * 1000);
}, 15_000);

// ── NIGHTLY ORDER SWEEP: 11pm Perth (15:00 UTC) ───────────────────────────────
// Fetches all orders created today (Perth date) from Square and reconciles any
// that were missed by the 6-hourly sync or deferred from webhook processing.
// Uses processedOrderIds to skip orders already counted, so no double-counting.
async function runNightlyOrderSweep() {
  console.log('[NightlySweep] Starting nightly order sweep…');
  const initDb = loadDB();
  const token  = initDb.settings?.squareToken;
  if (!token) { console.warn('[NightlySweep] No Square token — skipping.'); return; }

  const sweepStart = new Date().toISOString();
  const log = { id: uid(), date: sweepStart, mode: 'nightly-sweep', event: 'order.sweep', status: 'ok', detail: '', errors: [] };

  try {
    // Perth today: most recent 16:00 UTC (= Perth midnight) up to now (11pm Perth = 15:00 UTC)
    const now           = new Date();
    const startBoundary = new Date(now);
    startBoundary.setUTCHours(16, 0, 0, 0);
    if (startBoundary > now) startBoundary.setUTCDate(startBoundary.getUTCDate() - 1);
    const startAt = startBoundary.toISOString(); // Perth midnight
    const endAt   = now.toISOString();           // now (11pm Perth)
    console.log(`[NightlySweep] Fetching orders ${startAt} → ${endAt}`);

    const locationIds  = await fetchLocationIds(token);
    const processedSet = new Set(initDb.processedOrderIds || []);

    // Phase 1: page through all of today's orders, no DB writes
    const visitMap           = {};
    const pendingPayments    = []; // orders with no customer_id — resolve via payment record
    const pendingFulfillments = []; // $0 orders with no tender — resolve via fulfillment recipient phone
    const newOrderIds        = []; // order IDs processed this sweep (for processedOrderIds)
    let cursor = null, pageCount = 0, fetched = 0, skipped = 0;

    do {
      const body = {
        location_ids: locationIds,
        query: {
          filter: {
            date_time_filter: { created_at: { start_at: startAt, end_at: endAt } },
            state_filter: { states: ['COMPLETED', 'OPEN'] },
          },
        },
        limit: 500,
      };
      if (cursor) body.cursor = cursor;
      const result = await squarePost(token, '/orders/search', body);
      if (result.errors) throw new Error(JSON.stringify(result.errors));

      for (const order of (result.orders || [])) {
        fetched++;
        if (processedSet.has(order.id)) { skipped++; continue; }
        if (!order.tenders || order.tenders.length === 0) {
          // No payment tender — likely a fully-discounted $0 order (e.g. coupon covers full total).
          // Try to identify the customer via fulfillment recipient phone number.
          const recipientPhone =
            order.fulfillments?.[0]?.pickup_details?.recipient?.phone_number ||
            order.fulfillments?.[0]?.delivery_details?.recipient?.phone_number;
          if (recipientPhone) pendingFulfillments.push({ phone: recipientPhone, order });
          else newOrderIds.push(order.id); // no tender, no fulfillment — mark processed
          continue;
        }

        const cid = order.customer_id;
        if (cid) {
          newOrderIds.push(order.id); // direct match — safe to mark processed now
          if (!visitMap[cid]) visitMap[cid] = { count: 0, lastDate: null, spend: 0 };
          visitMap[cid].count++;
          visitMap[cid].spend += order.total_money?.amount || 0;
          const d = order.closed_at || order.created_at;
          if (d && (!visitMap[cid].lastDate || d > visitMap[cid].lastDate)) visitMap[cid].lastDate = d;
        } else {
          const paymentId = order.tenders[0]?.payment_id;
          if (paymentId) {
            pendingPayments.push({ paymentId, order });
            // do NOT mark processed yet — resolvePaymentCustomers will do it on success
          } else {
            newOrderIds.push(order.id); // no customer_id, no payment — genuinely anonymous
          }
        }
      }
      cursor = result.cursor || null;
      pageCount++;
    } while (cursor);

    console.log(`[NightlySweep] ${fetched} orders in ${pageCount} page(s), ${skipped} already processed`);

    // Build phone/sqId maps once — used by both payment sweep and fulfillment resolution
    const preSqIdMap = buildSqIdMap(loadDB().customers);
    const prePhoneMap = {};
    for (const c of loadDB().customers) if (c.phone) prePhoneMap[fmtPhone(c.phone)] = c;

    const resolvedFromPayments = [];
    const newSquareIdLinks = await resolvePaymentCustomers(
      token, pendingPayments, visitMap, '[NightlySweep]', resolvedFromPayments, preSqIdMap, prePhoneMap
    );
    newOrderIds.push(...resolvedFromPayments);

    // Resolve $0/no-tender orders via fulfillment recipient phone number
    if (pendingFulfillments.length > 0) {
      console.log(`[NightlySweep] Resolving ${pendingFulfillments.length} no-tender order(s) via fulfillment phone…`);
      let fulfillResolved = 0;
      for (const { phone, order } of pendingFulfillments) {
        const c = prePhoneMap[fmtPhone(phone)];
        if (c && c.squareIds?.length) {
          const sid = c.squareIds[0];
          if (!visitMap[sid]) visitMap[sid] = { count: 0, lastDate: null, spend: 0 };
          visitMap[sid].count++;
          visitMap[sid].spend += order.total_money?.amount || 0;
          const d = order.closed_at || order.created_at;
          if (d && (!visitMap[sid].lastDate || d > visitMap[sid].lastDate)) visitMap[sid].lastDate = d;
          fulfillResolved++;
        }
        newOrderIds.push(order.id);
      }
      console.log(`[NightlySweep] Fulfillment phone lookup done — ${fulfillResolved}/${pendingFulfillments.length} resolved.`);
    }

    // Fetch Square profiles for any remaining unknown squareIds — these are genuinely new customers
    // (no phone/email match found). Phase 2 will create CRM records for them.
    const unknownSqIds = Object.keys(visitMap).filter(sid => !preSqIdMap[sid]);
    const newProfilesBySqId = {};
    for (const sid of unknownSqIds) {
      try {
        const data = await squareGet(token, `/customers/${sid}`);
        if (data.customer) newProfilesBySqId[sid] = data.customer;
      } catch(e) {
        console.warn(`[NightlySweep] Could not fetch Square profile for ${sid}: ${e.message}`);
      }
    }
    if (unknownSqIds.length > 0)
      console.log(`[NightlySweep] Unknown Square IDs: ${unknownSqIds.length} — profiles fetched: ${Object.keys(newProfilesBySqId).length}`);

    // Phase 2: apply atomically
    let visitsUpdated = 0, newCustomersAdded = 0;
    await withDB(freshDb => {
      if (!Array.isArray(freshDb.processedOrderIds)) freshDb.processedOrderIds = [];
      const sqIdMap = buildSqIdMap(freshDb.customers);

      // Persist squareId links discovered inline during the payment sweep (new squareId → existing customer matched by phone/email)
      for (const { cid, customerId } of newSquareIdLinks) {
        const c = freshDb.customers.find(x => x.id === customerId);
        if (c && !c.squareIds.includes(cid)) {
          c.squareIds.push(cid);
          sqIdMap[cid] = c;
        }
      }

      // Create CRM records for any new Square customers found in today's orders
      for (const [sid, sq] of Object.entries(newProfilesBySqId)) {
        if (sqIdMap[sid]) continue; // already in CRM (added by concurrent sync)
        const phone = fmtPhone(sq.phone_number || '');
        const existing = phone ? freshDb.customers.find(c => c.phone === phone) : null;
        if (existing) {
          // Phone already in CRM under a different squareId — just link the new ID
          if (!existing.squareIds.includes(sid)) existing.squareIds.push(sid);
          if (!existing.createdAt && sq.created_at) existing.createdAt = sq.created_at.split('T')[0];
          sqIdMap[sid] = existing;
        } else {
          const newCrm = {
            id: uid(), squareIds: [sid],
            firstName: sq.given_name || '', lastName: sq.family_name || '',
            phone, email: sq.email_address || '',
            birthday: normalizeBirthday(sq.birthday || ''),
            createdAt: sq.created_at ? sq.created_at.split('T')[0] : new Date().toISOString().split('T')[0],
            lastVisit: '', visits: 0, lifetimeSpend: 0,
            tags: [], note: '', squareNote: '', syncedAt: new Date().toISOString(),
          };
          freshDb.customers.push(newCrm);
          sqIdMap[sid] = newCrm;
          newCustomersAdded++;
        }
      }

      for (const [, { count, spend, lastDate, customer: c }] of aggregateVisits(visitMap, sqIdMap)) {
        c.visits        = (c.visits || 0) + count;
        c.lifetimeSpend = (c.lifetimeSpend || 0) + spend;
        if (lastDate) { const d = lastDate.split('T')[0]; if (!c.lastVisit || d > c.lastVisit) c.lastVisit = d; }
        if (!c.createdAt) c.createdAt = c.lastVisit || new Date().toISOString().split('T')[0];
        visitsUpdated++;
      }

      // Mark every swept order as processed so the 6h sync and next sweep skip them
      for (const id of newOrderIds) {
        if (!freshDb.processedOrderIds.includes(id)) freshDb.processedOrderIds.unshift(id);
      }
      if (freshDb.processedOrderIds.length > 5000) freshDb.processedOrderIds.length = 5000;

      log.detail = `Swept ${fetched} orders (${skipped} skipped, ${visitsUpdated} customers updated, ${newCustomersAdded} new customers added)`;
      if (!Array.isArray(freshDb.syncLogs)) freshDb.syncLogs = [];
      freshDb.syncLogs.unshift(log);
      if (freshDb.syncLogs.length > 200) freshDb.syncLogs.length = 200;
    });

    console.log(`[NightlySweep] Done — ${log.detail}`);
  } catch (e) {
    log.status = 'error';
    log.detail = `Nightly sweep failed: ${e.message}`;
    console.error('[NightlySweep] Error:', e.message);
    await withDB(freshDb => {
      if (!Array.isArray(freshDb.syncLogs)) freshDb.syncLogs = [];
      freshDb.syncLogs.unshift(log);
      if (freshDb.syncLogs.length > 200) freshDb.syncLogs.length = 200;
    });
  }
}

function scheduleNightlyOrderSweep() {
  const now  = new Date();
  const next = new Date(now);
  next.setUTCHours(15, 0, 0, 0); // 15:00 UTC = 11pm Perth AWST
  if (next <= now) next.setUTCDate(next.getUTCDate() + 1);
  const ms = next - now;
  console.log(`[NightlySweep] First run in ${Math.round(ms / 60000)} min (11pm Perth).`);
  setTimeout(() => {
    runNightlyOrderSweep();
    setInterval(runNightlyOrderSweep, 24 * 60 * 60 * 1000);
  }, ms);
}
scheduleNightlyOrderSweep();

// ── AUTOMATED FEEDBACK SMS: 5pm Perth (09:00 UTC) ──────────────────────────────
// Sends personalised feedback request to every customer whose lastVisit was
// yesterday (Perth date). Mirrors the manual feedback send — no 7-day cap,
// skips opted-out, non-AU, and customers who already completed a Google review.
async function runFeedbackAutomation() {
  const db      = loadDB();
  const apiKey  = db.settings?.cellcastKey;
  const sender  = db.settings?.cellcastSender || null;
  const base    = (db.settings?.crmBaseUrl || db.settings?.feedbackBaseUrl || 'https://crm.woodpeckers.pizza').replace(/\/$/, '');
  const template = db.settings?.feedbackTemplate || 'Hi {name}, how was your Woodpeckers Murdoch order? {link}\nReply STOP to opt out.';

  if (!db.settings?.feedbackAutoEnabled) { console.log('[FeedbackAuto] Disabled, skipping.'); return; }
  if (!apiKey) { console.log('[FeedbackAuto] No Cellcast key configured, skipping.'); return; }
  if (!isWithinSendHours()) { console.log('[FeedbackAuto] Outside send hours, skipping.'); return; }

  const yesterday = perthDateStr(-1);
  const weekStart = perthDateStr(-7); // 7 days ago (inclusive)

  // Only run once per week — skip if already ran within the last 7 days
  const sevenDaysAgo = new Date(Date.now() - 7 * 24 * 60 * 60 * 1000).toISOString();
  if (db.settings?.feedbackAutoLastRun && db.settings.feedbackAutoLastRun > sevenDaysAgo) {
    console.log('[FeedbackAuto] Already ran this week, skipping.');
    return;
  }

  const optOuts = new Set(db.optOuts || []);

  const eligible = (db.customers || []).filter(c =>
    c.phone &&
    isAuPhone(c.phone) &&
    !optOuts.has(c.phone) &&
    !c.googleReviewDone &&
    c.lastVisit >= weekStart &&
    c.lastVisit <= yesterday
  );

  if (!eligible.length) { console.log(`[FeedbackAuto] No customers with lastVisit ${weekStart} to ${yesterday}, skipping.`); return; }

  const sentAt    = new Date().toISOString();
  const newTokens = [];
  const toSend    = [];

  for (const cust of eligible) {
    const token = uid();
    const link  = `${base}/fb?t=${token}`;
    const name  = (cust.firstName || '').trim();
    const msg   = template.replace('{name}', name || 'there').replace('{link}', link);
    newTokens.push({ token, customerId: cust.id, orderId: '', createdAt: sentAt, usedAt: null, rating: null, remarks: '', googleReviewClicked: false });
    toSend.push({ custId: cust.id, number: cust.phone, msg });
  }

  await withDB(freshDb => {
    if (!freshDb.feedbackTokens) freshDb.feedbackTokens = [];
    for (const t of newTokens) freshDb.feedbackTokens.push(t);
  });

  let sent = 0;
  const errors = [];
  for (const r of toSend) {
    try {
      const payload = { message: r.msg, contacts: [r.number], reply_url: `${base}/webhook` };
      if (sender) payload.sender = sender;
      await cellcastPost(apiKey, payload);
      sent++;
    } catch(e) {
      errors.push({ number: r.number, error: e.message });
    }
  }

  await withDB(freshDb => {
    if (!freshDb.campaigns) freshDb.campaigns = [];
    freshDb.campaigns.unshift({
      id: uid(), date: sentAt,
      message: `Feedback request (auto, ${weekStart} to ${yesterday})`,
      sender: sender || '#SharedNum#',
      segment: 'Feedback SMS — Auto',
      recipientCount: sent,
      recipients: toSend.map(r => r.number),
      status: sent > 0 ? 'sent' : 'failed',
    });
    if (!freshDb.smsLog) freshDb.smsLog = [];
    for (const r of toSend) {
      const cust = (freshDb.customers || []).find(c => c.id === r.custId);
      if (!cust) continue;
      if (!Array.isArray(cust.smsSent)) cust.smsSent = [];
      cust.smsSent.unshift({ message: r.msg, sentAt, label: 'Feedback SMS (Auto)' });
      freshDb.smsLog.push({
        id: uid(), phone: cust.phone, triggerType: 'feedback',
        visitReferenceDate: cust.lastVisit || null,
        sentAt, messageBody: r.msg, status: 'sent',
      });
    }
    if (!freshDb.settings) freshDb.settings = {};
    freshDb.settings.feedbackAutoLastRun   = sentAt;
    freshDb.settings.feedbackAutoLastStats = { sent, skipped: eligible.length - sent, errors: errors.length };
  });
  console.log(`[FeedbackAuto] ${weekStart} to ${yesterday}: sent ${sent}, errors ${errors.length}.`);
}

function scheduleFeedbackAutomation() {
  const now  = new Date();
  const next = new Date(now);
  next.setUTCHours(2, 0, 0, 0); // 02:00 UTC = 10am Perth AWST
  // Advance to next Sunday (UTC day 0); if today is Sunday but past 10am, go to next week
  const daysUntilSunday = (7 - now.getUTCDay()) % 7;
  next.setUTCDate(next.getUTCDate() + daysUntilSunday);
  if (next <= now) next.setUTCDate(next.getUTCDate() + 7);
  const ms = next - now;
  console.log(`[FeedbackAuto] First run in ${Math.round(ms / 60000)} min (Sunday 10am Perth).`);
  setTimeout(() => {
    runFeedbackAutomation();
    setInterval(runFeedbackAutomation, 7 * 24 * 60 * 60 * 1000);
  }, ms);
}
scheduleFeedbackAutomation();
