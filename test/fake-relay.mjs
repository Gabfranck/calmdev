// A fake team relay for the tests: the contract of docs/team.md, in memory, on 127.0.0.1. Tokens → members are given;
// it keeps only their hash, like the real one. Every request is recorded (method, path, headers, body) so a test can
// check what left Escadrille: the bearer header, metadata only, never a prompt, a diff or the token in a body or a URL.
import { createServer } from 'node:http';
import { createHash } from 'node:crypto';

export const fakeRelay = ({ tokens = {}, ttlMs = 10 * 60e3 } = {}) => new Promise((resolve) => {
  const sha = (s) => createHash('sha256').update(String(s)).digest('hex');
  const members = new Map(Object.entries(tokens).map(([t, m]) => [sha(t), m])); // hash → member
  const repos = new Map(); // repoId → { presence: Map member → { sessions, at, seen }, memory: [{ id, member, line, at }] }
  const requests = []; let nextId = 1; let down = false;
  const repo = (id) => { let r = repos.get(id); if (!r) { r = { presence: new Map(), memory: [] }; repos.set(id, r); } return r; };
  const json = (res, code, body) => { res.writeHead(code, { 'content-type': 'application/json' }); res.end(JSON.stringify(body)); };
  const server = createServer((req, res) => {
    let s = ''; req.on('data', (c) => { s += c; if (s.length > 256 * 1024) { json(res, 413, { error: 'too large' }); req.destroy(); } });
    req.on('end', () => {
      let body = null; try { body = s ? JSON.parse(s) : null; } catch { return json(res, 400, { error: 'bad json' }); }
      requests.push({ method: req.method, path: req.url, headers: req.headers, body, at: Date.now() });
      if (down) { res.destroy(); return; }
      const url = new URL(req.url, 'http://x');
      if (url.pathname === '/v1/health') return json(res, 200, { ok: true, version: 'fake' });
      const auth = /^Bearer (.+)$/.exec(req.headers.authorization || ''); const member = auth && members.get(sha(auth[1]));
      if (!member) return json(res, 401, { error: 'unauthorized' });
      const m = /^\/v1\/repos\/([a-f0-9]{64})\/(presence|memory)$/.exec(url.pathname); if (!m) return json(res, 404, { error: 'not found' });
      const r = repo(m[1]); const t = Date.now();
      if (m[2] === 'presence' && req.method === 'PUT') { if (!body || !Array.isArray(body.sessions)) return json(res, 400, { error: 'sessions' }); if (body.sessions.length > 500) return json(res, 400, { error: 'too many sessions' }); r.presence.set(member, { sessions: body.sessions, at: body.at || new Date(t).toISOString(), seen: t }); return json(res, 200, { ok: true }); }
      if (m[2] === 'presence' && req.method === 'GET') { for (const [k, v] of r.presence) if (t - v.seen > ttlMs) r.presence.delete(k); return json(res, 200, { members: [...r.presence].map(([k, v]) => ({ member: k, sessions: v.sessions, at: v.at })) }); }
      if (m[2] === 'memory' && req.method === 'POST') { if (!body || typeof body.line !== 'string' || !body.line.trim()) return json(res, 400, { error: 'line' }); const e = { id: nextId++, member, line: body.line, at: new Date(t).toISOString() }; r.memory.push(e); return json(res, 200, { ok: true, id: e.id }); }
      if (m[2] === 'memory' && req.method === 'GET') { const since = Number(url.searchParams.get('since') || 0); return json(res, 200, { lines: r.memory.filter((e) => e.id > since) }); }
      return json(res, 405, { error: 'method' });
    });
  });
  server.listen(0, '127.0.0.1', () => resolve({
    url: `http://127.0.0.1:${server.address().port}`,
    requests,
    // another member's presence, as if their Escadrille had PUT it
    seedPresence(repoId, member, sessions) { repo(repoId).presence.set(member, { sessions, at: new Date().toISOString(), seen: Date.now() }); },
    seedMemory(repoId, member, line) { const e = { id: nextId++, member, line, at: new Date().toISOString() }; repo(repoId).memory.push(e); return e; },
    memoryOf(repoId) { return repo(repoId).memory.slice(); },
    presenceOf(repoId) { return [...repo(repoId).presence].map(([k, v]) => ({ member: k, sessions: v.sessions })); },
    setDown(v) { down = !!v; },
    close() { server.close(); server.closeAllConnections?.(); },
  }));
});
