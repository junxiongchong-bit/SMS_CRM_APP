/**
 * squareSync.js — ITTO Pizza CRM Full Sync
 * Runs directly against db.json (no server required).
 * Schema: camelCase to match existing db.json structure.
 */

'use strict';

const https  = require('https');
const fs     = require('fs');
const path   = require('path');

const DB_FILE      = path.join(__dirname, 'data', 'db.json');
const SQUARE_VER   = '2025-07-17';

// ── DB helpers ────────────────────────────────────────────────────────────────

function loadDB() {
  return JSON.parse(fs.readFileSync(DB_FILE, 'utf8'));
}
function saveDB(data) {
  const tmp = DB_FILE + '.tmp';
  fs.writeFileSync(tmp, JSON.stringify(data, null, 2));
  fs.renameSync(tmp, DB_FILE);
}
function uid() { return Date.now().toString(36) + Math.random().toString(36).slice(2, 6); }

// ── Phone normalisation ───────────────────────────────────────────────────────
// Strips leading apostrophe (CSV artefact), then formats as +61xxxxxxxxx.
// Returns '' if unrecognisable.

function fmtPhone(raw) {
  if (!raw) return '';
  // Strip leading apostrophe added by Excel/CSV exports
  const stripped = String(raw).replace(/^'+/, '').trim();
  const digits = stripped.replace(/\D/g, '');
  if (!digits) return '';
  if (digits.startsWith('61') && digits.length >= 11) return '+' + digits;
  if (digits.startsWith('0'))  return '+61' + digits.slice(1);
  if (digits.length === 9)     return '+61' + digits;   // bare 4xxxxxxxx
  return '+' + digits;
}

// ── Square API helper ─────────────────────────────────────────────────────────

function squareRequest(token, method, urlPath, body) {
  return new Promise((resolve, reject) => {
    const payload = body ? JSON.stringify(body) : null;
    const options = {
      hostname: 'connect.squareup.com',
      path: `/v2${urlPath}`,
      method,
      headers: {
        Authorization:    `Bearer ${token}`,
        'Square-Version': SQUARE_VER,
        'Content-Type':   'application/json',
        ...(payload ? { 'Content-Length': Buffer.byteLength(payload) } : {}),
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
    if (payload) req.write(payload);
    req.end();
  });
}

// ── Step 1: Fetch + upsert all Square customer profiles ───────────────────────

function applyProfile(sq, db) {
  const phone = fmtPhone(sq.phone_number);
  const sqIds = c => c.squareIds || (c.squareId ? [c.squareId] : []);

  let existing = phone
    ? db.customers.find(c => fmtPhone(c.phone) === phone)
    : null;
  if (!existing)
    existing = db.customers.find(c => sqIds(c).includes(sq.id));

  if (existing) {
    if (!existing.squareIds) existing.squareIds = sqIds(existing);
    delete existing.squareId;
    if (!existing.squareIds.includes(sq.id)) existing.squareIds.push(sq.id);
    if (sq.given_name)  existing.firstName = sq.given_name;
    if (sq.family_name) existing.lastName  = sq.family_name;
    existing.email     = sq.email_address || existing.email || '';
    if (phone) existing.phone = phone;
    if (sq.birthday)  existing.birthday   = sq.birthday;
    existing.createdAt  = sq.created_at || existing.createdAt;
    existing.squareNote = sq.note || '';
    existing.syncedAt   = new Date().toISOString();
    return 'updated';
  } else {
    db.customers.push({
      id: uid(),
      squareIds:  [sq.id],
      firstName:  sq.given_name   || '',
      lastName:   sq.family_name  || '',
      email:      sq.email_address || '',
      phone,
      birthday:   sq.birthday || '',
      createdAt:  sq.created_at,
      squareNote: sq.note || '',
      tags: [], note: '',
      syncedAt: new Date().toISOString(),
    });
    return 'added';
  }
}

async function syncProfiles(token, db) {
  console.log('[profiles] Fetching all Square customer profiles…');
  let cursor = null, added = 0, updated = 0;

  do {
    const params = new URLSearchParams({ limit: 100, sort_field: 'CREATED_AT', sort_order: 'DESC' });
    if (cursor) params.set('cursor', cursor);
    const data = await squareRequest(token, 'GET', `/customers?${params}`);
    for (const sq of data.customers || []) {
      const r = applyProfile(sq, db);
      if (r === 'added') added++; else updated++;
    }
    cursor = data.cursor || null;
  } while (cursor);

  console.log(`[profiles] Done — ${added} added, ${updated} updated.`);
  return { added, updated };
}

// ── Step 2: Fix phone apostrophes on existing customers ───────────────────────

function fixExistingPhones(db) {
  let fixed = 0;
  for (const c of db.customers) {
    if (c.phone && c.phone.startsWith("'")) {
      c.phone = fmtPhone(c.phone);
      fixed++;
    }
  }
  if (fixed) console.log(`[phones] Fixed apostrophe prefix on ${fixed} existing records.`);
}

// ── Step 3: Full order scan → visitMap ────────────────────────────────────────

async function buildVisitMap(token) {
  console.log('[orders] Fetching location IDs…');
  const locData = await squareRequest(token, 'GET', '/locations');
  const locationIds = (locData.locations || []).map(l => l.id);
  console.log(`[orders] Locations: ${locationIds.join(', ')}`);

  console.log('[orders] Scanning all completed orders (full history)…');
  const visitMap = {};   // squareCustomerId → { count, spend, lastDate, firstDate }
  const pendingPayments = []; // { paymentId, order } — orders with no customer_id at order level
  let cursor = null, pages = 0;

  do {
    const body = {
      location_ids: locationIds,
      query: { filter: { state_filter: { states: ['COMPLETED'] } } },
      limit: 500,
      ...(cursor ? { cursor } : {}),
    };
    const data = await squareRequest(token, 'POST', '/orders/search', body);
    pages++;
    if (pages % 5 === 0) process.stdout.write(`\r[orders] Page ${pages}…`);

    for (const order of data.orders || []) {
      const cid = order.customer_id;
      if (cid) {
        if (!visitMap[cid]) visitMap[cid] = { count: 0, spend: 0, lastDate: null, firstDate: null };
        const v = visitMap[cid];
        v.count++;
        v.spend += (order.total_money?.amount) || 0;
        const d = (order.closed_at || order.created_at || '').split('T')[0];
        if (d) {
          if (!v.lastDate  || d > v.lastDate)  v.lastDate  = d;
          if (!v.firstDate || d < v.firstDate) v.firstDate = d;
        }
      } else {
        // Square links some POS orders to customers only at the payment level via card
        // fingerprinting — the order record has no customer_id but the payment does.
        const paymentId = order.tenders?.[0]?.payment_id || order.tenders?.[0]?.id;
        if (paymentId) pendingPayments.push({ paymentId, order });
      }
    }
    cursor = data.cursor || null;
  } while (cursor);

  console.log(`\n[orders] Scan done — ${pages} pages, ${Object.keys(visitMap).length} unique Square IDs at order level.`);

  // Second pass: resolve customer_ids via payment records
  if (pendingPayments.length > 0) {
    console.log(`[orders] Resolving ${pendingPayments.length} orders via payment-level customer lookup…`);
    let resolved = 0;
    for (let i = 0; i < pendingPayments.length; i++) {
      const { paymentId, order } = pendingPayments[i];
      try {
        const paymentData = await squareRequest(token, 'GET', `/payments/${paymentId}`);
        const cid = paymentData.payment?.customer_id;
        if (cid) {
          if (!visitMap[cid]) visitMap[cid] = { count: 0, spend: 0, lastDate: null, firstDate: null };
          const v = visitMap[cid];
          v.count++;
          v.spend += (order.total_money?.amount) || 0;
          const d = (order.closed_at || order.created_at || '').split('T')[0];
          if (d) {
            if (!v.lastDate  || d > v.lastDate)  v.lastDate  = d;
            if (!v.firstDate || d < v.firstDate) v.firstDate = d;
          }
          resolved++;
        }
      } catch (e) {
        // non-fatal — skip this order
      }
      if ((i + 1) % 50 === 0) process.stdout.write(`\r[orders] Payment lookup ${i + 1}/${pendingPayments.length} (${resolved} resolved)…`);
      if (i % 10 === 9) await sleep(100); // 100ms every 10 calls to avoid rate limiting
    }
    console.log(`\n[orders] Payment lookup done — ${resolved}/${pendingPayments.length} resolved.`);
  }

  console.log(`[orders] Total unique Square IDs: ${Object.keys(visitMap).length}`);
  return visitMap;
}

// ── Step 4: Aggregate visits per CRM customer ─────────────────────────────────

function applyVisits(visitMap, db) {
  const sqIdMap = {};
  for (const c of db.customers)
    for (const sid of (c.squareIds || []))
      sqIdMap[sid] = c;

  // Aggregate across all squareIds linked to the same CRM customer
  const byCustomer = new Map();
  for (const [sid, v] of Object.entries(visitMap)) {
    const c = sqIdMap[sid];
    if (!c) continue;
    if (!byCustomer.has(c.id))
      byCustomer.set(c.id, { count: 0, spend: 0, lastDate: null, firstDate: null, customer: c });
    const e = byCustomer.get(c.id);
    e.count += v.count;
    e.spend += v.spend;
    if (v.lastDate  && (!e.lastDate  || v.lastDate  > e.lastDate))  e.lastDate  = v.lastDate;
    if (v.firstDate && (!e.firstDate || v.firstDate < e.firstDate)) e.firstDate = v.firstDate;
  }

  let updated = 0;
  for (const { count, spend, lastDate, firstDate, customer: c } of byCustomer.values()) {
    c.visits       = count;
    c.lifetimeSpend = spend;
    if (lastDate)  c.lastVisit  = lastDate;
    if (firstDate && (!c.createdAt || firstDate < c.createdAt)) c.createdAt = firstDate;
    updated++;
  }
  console.log(`[visits] Applied stats to ${updated} customers.`);
}

// ── Step 5: Loyalty balance sync ──────────────────────────────────────────────
// Uses POST /v2/loyalty/accounts/search with batches of customer IDs (max 30).

const LOYALTY_BATCH = 30;
const LOYALTY_DELAY = 300; // ms between batches

const sleep = ms => new Promise(r => setTimeout(r, ms));

async function syncLoyalty(token, db) {
  // Confirm loyalty program exists first
  console.log('[loyalty] Checking loyalty program…');
  const progData = await squareRequest(token, 'GET', '/loyalty/programs/main');
  const programId = progData.program?.id;
  if (!programId) throw new Error('No active loyalty program found.');
  console.log(`[loyalty] Program ID: ${programId}`);

  // Collect all unique Square IDs across all customers
  const sqIdMap = {};
  for (const c of db.customers)
    for (const sid of (c.squareIds || []))
      sqIdMap[sid] = c;

  const allSquareIds = Object.keys(sqIdMap);
  console.log(`[loyalty] Searching ${allSquareIds.length} Square IDs in batches of ${LOYALTY_BATCH}…`);

  // pointsById accumulates across all squareIds for the same CRM customer
  const pointsById = new Map();
  let batches = 0;

  for (let i = 0; i < allSquareIds.length; i += LOYALTY_BATCH) {
    const batch = allSquareIds.slice(i, i + LOYALTY_BATCH);
    try {
      const data = await squareRequest(token, 'POST', '/loyalty/accounts/search', {
        query: { customer_ids: batch },
      });
      for (const acc of data.loyalty_accounts || []) {
        const c = sqIdMap[acc.customer_id];
        if (!c) continue;
        pointsById.set(c.id, (pointsById.get(c.id) || 0) + (acc.balance || 0));
      }
    } catch (err) {
      console.warn(`[loyalty] Batch ${batches + 1} error:`, err.message.slice(0, 80));
    }
    batches++;
    if (i + LOYALTY_BATCH < allSquareIds.length) await sleep(LOYALTY_DELAY);
    if (batches % 20 === 0) process.stdout.write(`\r[loyalty] ${i + LOYALTY_BATCH} / ${allSquareIds.length}…`);
  }

  let updated = 0;
  for (const [id, points] of pointsById) {
    const c = db.customers.find(x => x.id === id);
    if (c) { c.loyaltyPoints = points; updated++; }
  }
  console.log(`\n[loyalty] Updated ${updated} customers across ${batches} batches.`);
  return updated;
}

// ── Main ──────────────────────────────────────────────────────────────────────

async function main() {
  console.log('=== ITTO Pizza CRM — Full Square Sync ===');
  const db    = loadDB();
  const token = db.settings?.squareToken;
  if (!token) throw new Error('No Square token found in db.settings.squareToken');

  const syncStart = new Date().toISOString();

  // Fix apostrophe prefix on existing phones first
  fixExistingPhones(db);

  // 1. Profiles
  await syncProfiles(token, db);

  // 2. Orders → visit map
  const visitMap = await buildVisitMap(token);

  // 3. Apply stats
  applyVisits(visitMap, db);

  // 4. Save profiles + visits before loyalty (so progress isn't lost on loyalty error)
  db.lastOrderSyncAt = syncStart;
  saveDB(db);
  console.log('[db] Profiles and visits saved.');

  // 5. Loyalty (non-fatal — program may not be configured)
  let loyaltyUpdated = 0;
  try {
    loyaltyUpdated = await syncLoyalty(token, db);
    saveDB(db);
  } catch (err) {
    console.warn('[loyalty] Skipped —', err.message.slice(0, 120));
  }

  console.log('');
  console.log('=== Sync complete ===');
  console.log(`  Customers in DB : ${db.customers.length}`);
  console.log(`  Loyalty updated : ${loyaltyUpdated}`);
  console.log(`  Sync timestamp  : ${syncStart}`);
}

main().catch(err => { console.error('FATAL:', err.message); process.exit(1); });
