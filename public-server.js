// public-server.js — go.woodpeckers.pizza
// Serves ONLY the customer-facing feedback form. No admin routes exposed.
// All API calls are proxied to the main CRM server (localhost:3001) so both
// processes share a single DB write queue with no concurrency issues.

const http = require('http');
const fs   = require('fs');
const path = require('path');

const PUBLIC_PORT = process.env.PUBLIC_PORT || 3002;
const MAIN_PORT   = process.env.MAIN_PORT   || 3001;

const ALLOWED_API_PATHS = new Set([
  '/api/feedback/check',
  '/api/feedback',
  '/api/feedback/redirect',
]);

function proxyToMain(req, res) {
  const options = {
    hostname: '127.0.0.1',
    port:     MAIN_PORT,
    path:     req.url,
    method:   req.method,
    headers:  { ...req.headers, host: 'localhost' },
  };
  const proxy = http.request(options, proxyRes => {
    res.writeHead(proxyRes.statusCode, proxyRes.headers);
    proxyRes.pipe(res);
  });
  proxy.on('error', () => { res.writeHead(502); res.end('Service unavailable'); });
  req.pipe(proxy);
}

const server = http.createServer((req, res) => {
  if (req.method === 'OPTIONS') {
    res.writeHead(204, {
      'Access-Control-Allow-Origin':  '*',
      'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
      'Access-Control-Allow-Headers': 'Content-Type',
    });
    res.end();
    return;
  }

  const urlPath = req.url.split('?')[0];

  // Health check for uptime monitoring
  if (urlPath === '/health' && (req.method === 'GET' || req.method === 'HEAD')) {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ ok: true }));
    return;
  }

  // Feedback form — also handle bare "/" so the domain root works
  if ((urlPath === '/fb' || urlPath === '/') && req.method === 'GET') {
    const fp = path.join(__dirname, 'feedback.html');
    res.writeHead(200, { 'Content-Type': 'text/html' });
    fs.createReadStream(fp).pipe(res);
    return;
  }

  // Proxy allowed feedback API routes to main server
  if (ALLOWED_API_PATHS.has(urlPath)) {
    proxyToMain(req, res);
    return;
  }

  res.writeHead(404);
  res.end('Not found');
});

server.listen(PUBLIC_PORT, '0.0.0.0', () => {
  console.log(`[Public] go.woodpeckers.pizza server running on port ${PUBLIC_PORT}`);
});
