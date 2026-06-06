'use strict';

const https = require('https');
const fs    = require('fs');
const path  = require('path');

const DB_FILE    = path.join(__dirname, 'data', 'db.json');
const OUT_FILE   = path.join(__dirname, 'data', 'orders_2026-05-10.csv');
const SQUARE_VER = '2025-07-17';

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
        } catch (e) { reject(e); }
      });
    });
    req.on('error', reject);
    if (payload) req.write(payload);
    req.end();
  });
}

function csvEscape(val) {
  if (val == null) return '';
  const s = String(val);
  if (s.includes(',') || s.includes('"') || s.includes('\n')) return `"${s.replace(/"/g, '""')}"`;
  return s;
}

async function main() {
  const db    = JSON.parse(fs.readFileSync(DB_FILE, 'utf8'));
  const token = db.settings?.squareToken;
  if (!token) throw new Error('No squareToken in db.settings');

  // Build squareId → customer lookup for name/phone enrichment
  const sqIdMap = {};
  for (const c of db.customers || []) {
    for (const sid of (c.squareIds || [])) {
      sqIdMap[sid] = c;
    }
  }

  // Fetch location IDs
  console.log('Fetching locations…');
  const locData = await squareRequest(token, 'GET', '/locations');
  const locationIds = (locData.locations || []).map(l => l.id);
  console.log(`Locations: ${locationIds.join(', ')}`);

  // Date range: 2026-05-10 00:00–23:59 Perth (AWST = UTC+8)
  const startAt = '2026-05-09T16:00:00Z'; // 2026-05-10 00:00 Perth
  const endAt   = '2026-05-10T15:59:59Z'; // 2026-05-10 23:59 Perth
  console.log(`Fetching orders from ${startAt} to ${endAt} (2026-05-10 Perth time)`);

  const allOrders = [];
  let cursor = null, page = 0;

  do {
    const filter = {
      state_filter: { states: ['COMPLETED', 'OPEN'] },
      date_time_filter: { updated_at: { start_at: startAt, end_at: endAt } },
    };
    const body = {
      location_ids: locationIds,
      query: { filter },
      limit: 500,
      ...(cursor ? { cursor } : {}),
    };
    const data = await squareRequest(token, 'POST', '/orders/search', body);
    page++;
    if (page % 5 === 0) process.stdout.write(`\r  page ${page}…`);
    for (const order of data.orders || []) {
      allOrders.push(order);
    }
    cursor = data.cursor || null;
  } while (cursor);

  console.log(`\nFetched ${allOrders.length} orders across ${page} pages.`);

  // Write CSV
  const headers = ['OrderId', 'State', 'Date', 'SquareCustomerId', 'CustomerName', 'CustomerPhone', 'AmountAUD', 'LocationId'];
  const rows = [headers.join(',')];

  for (const order of allOrders) {
    const cid  = order.customer_id || '';
    const crm  = sqIdMap[cid];
    const name = crm ? `${crm.firstName || ''} ${crm.lastName || ''}`.trim() : '';
    const phone = crm?.phone || '';
    const date  = (order.closed_at || order.created_at || '').replace('T', ' ').replace(/\.\d+Z$/, ' UTC');
    const cents = order.total_money?.amount || 0;
    const aud   = (cents / 100).toFixed(2);

    rows.push([
      csvEscape(order.id),
      csvEscape(order.state),
      csvEscape(date),
      csvEscape(cid),
      csvEscape(name),
      csvEscape(phone),
      csvEscape(aud),
      csvEscape(order.location_id || ''),
    ].join(','));
  }

  fs.writeFileSync(OUT_FILE, rows.join('\n'), 'utf8');
  console.log(`CSV written to ${OUT_FILE} (${allOrders.length} rows).`);
}

main().catch(err => { console.error('FATAL:', err.message); process.exit(1); });
