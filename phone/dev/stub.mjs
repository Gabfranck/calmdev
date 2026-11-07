// A stand-in for the phone routes of the server while session A's work is not merged: it answers
// /api/pair (code 123456), /api/phone, /api/phone/push-token and /api/phone/forget, checks the bearer
// token everywhere, adds CORS for the web build, and relays every other route to a real server.
//   node phone/dev/stub.mjs [port=3192] [target=http://127.0.0.1:3191]
import http from 'node:http';

const PORT = Number(process.argv[2] || 3192);
const TARGET = process.argv[3] || 'http://127.0.0.1:3191';
const CODE = '123456';
const tokens = new Set();
const device = { id: 'dev-1', name: 'iPhone', created: new Date().toISOString() };

const send = (res, status, body) => { res.writeHead(status, { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' }); res.end(JSON.stringify(body)); };
const readBody = (req) => new Promise((r) => { let s = ''; req.on('data', (c) => (s += c)); req.on('end', () => r(s)); });

http.createServer(async (req, res) => {
  if (req.method === 'OPTIONS') {
    res.writeHead(204, { 'Access-Control-Allow-Origin': '*', 'Access-Control-Allow-Headers': 'Authorization, Content-Type', 'Access-Control-Allow-Methods': 'GET, POST' });
    return res.end();
  }
  const url = new URL(req.url, 'http://x');
  const raw = await readBody(req);
  if (url.pathname === '/api/pair' && req.method === 'POST') {
    const { code, name } = JSON.parse(raw || '{}');
    if (code !== CODE) return send(res, 401, { error: 'Code inconnu ou expiré.' });
    const token = 'tok-' + Math.random().toString(36).slice(2);
    tokens.add(token); device.name = name || 'iPhone';
    return send(res, 200, { token, device });
  }
  const token = (req.headers.authorization || '').replace(/^Bearer /, '') || url.searchParams.get('token');
  if (!tokens.has(token) && token !== 'dev') return send(res, 401, { error: 'jeton inconnu' });
  if (url.pathname === '/api/phone') {
    const plans = await fetch(TARGET + '/api/plans' + url.search).then((r) => r.json()); // ?project= is the server's filter
    return send(res, 200, { device, plans: (plans.plans || plans).map(({ id, title, created, project }) => ({ id, title, created, project: project || null })), now: new Date().toISOString() });
  }
  if (url.pathname === '/api/phone/push-token') { console.log('push token', raw); return send(res, 200, { ok: true }); }
  if (url.pathname === '/api/phone/forget') { tokens.delete(token); return send(res, 200, { ok: true }); }
  const r = await fetch(TARGET + url.pathname + url.search, { method: req.method, headers: { 'Content-Type': 'application/json' }, body: req.method === 'POST' ? raw : undefined });
  send(res, r.status, await r.json().catch(() => ({})));
}).listen(PORT, '127.0.0.1', () => console.log(`stub on http://127.0.0.1:${PORT} → ${TARGET}`));
