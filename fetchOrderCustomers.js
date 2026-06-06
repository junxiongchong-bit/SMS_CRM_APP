'use strict';

const https = require('https');
const fs    = require('fs');
const path  = require('path');

const DB_FILE    = path.join(__dirname, 'data', 'db.json');
const CSV_IN     = path.join(__dirname, 'data', 'orders_export.csv');
const CSV_OUT    = path.join(__dirname, 'data', 'order_customers.csv');
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

  // Extract unique Square customer IDs from the orders CSV (skip header, skip blank)
  const lines = fs.readFileSync(CSV_IN, 'utf8').split('\n').slice(1);
  const customerIds = [...new Set(
    lines.map(l => l.split(',')[3]).filter(id => id && id.trim())
  )];

  console.log(`Found ${customerIds.length} unique Square customer IDs in orders CSV:`);
  customerIds.forEach(id => console.log(' ', id));

  // Fetch each customer record from Square
  const headers = ['SquareCustomerId', 'GivenName', 'FamilyName', 'Email', 'Phone', 'Birthday', 'CreatedAt', 'Note'];
  const rows = [headers.join(',')];

  for (const id of customerIds) {
    try {
      const data = await squareRequest(token, 'GET', `/customers/${id}`);
      const c = data.customer;
      console.log(`  [OK] ${id} → ${c.given_name || ''} ${c.family_name || ''} ${c.phone_number || ''}`);
      rows.push([
        csvEscape(c.id),
        csvEscape(c.given_name),
        csvEscape(c.family_name),
        csvEscape(c.email_address),
        csvEscape(c.phone_number),
        csvEscape(c.birthday),
        csvEscape(c.created_at),
        csvEscape(c.note),
      ].join(','));
    } catch (err) {
      console.warn(`  [ERR] ${id}: ${err.message.slice(0, 80)}`);
    }
  }

  fs.writeFileSync(CSV_OUT, rows.join('\n'), 'utf8');
  console.log(`\nCustomer records written to ${CSV_OUT}`);
}

main().catch(err => { console.error('FATAL:', err.message); process.exit(1); });
