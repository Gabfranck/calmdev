#!/usr/bin/env node
// Escadrille team relay: shares presence (who works on what, which files) and team memory lines per repository.
// Metadata only: never code, diffs, transcripts or prompts. Contract: docs/team.md.
// Node 22.13+, no dependency (node:http, node:sqlite). Listens on 127.0.0.1 behind Caddy (HTTPS); or, at home, on the LAN
// (RELAY_HOST=0.0.0.0 or the machine's LAN address): plain http, tokens still required, see docs/team.md « Chez soi ».
import http from 'node:http';
import { DatabaseSync } from 'node:sqlite';
import { createHash, timingSafeEqual, randomBytes } from 'node:crypto';
import { pathToFileURL } from 'node:url';

export const VERSION = '0.1.0';
export const LIMITS = {
  bodyBytes: 256 * 1024,
  requestsPerMinute: 60,
  sessionsPerRepo: 500,
  presenceTtlMs: 10 * 60 * 1000,
  filesPerSession: 2000,
  areasPerSession: 200,
  pathChars: 512,
  textChars: 200,
  lineChars: 1000,
  linesPerRead: 500,
};
const REPO_ID = /^[0-9a-f]{64}$/;

// Loopback hosts need no notice; any other host is plain http on a network: say so at start (docs/team.md « Chez soi »).
export const isLoopback = (host) => /^(127\.\d+\.\d+\.\d+|::1|localhost|::ffff:127\.\d+\.\d+\.\d+)$/i.test(String(host || '').replace(/^\[|\]$/g, ''));
export const lanNotice = (host) => isLoopback(host) ? '' :
  'no TLS: tokens and metadata travel in clear on this network. Home LAN only (WPA2, no guests), never a public wifi or the Internet; '
  + 'member tokens are still required on every route but /v1/health.';

export function openDb(path) {
  const db = new DatabaseSync(path);
  db.exec(`
    pragma journal_mode = wal;
    pragma foreign_keys = on;
    create table if not exists teams (
      id text primary key, name text unique not null, created text not null
    );
    create table if not exists members (
      id text primary key,                  -- 'm-' + 8 hex, also the public part of the token
      team_id text not null references teams(id),
      name text not null,
      salt text not null,                   -- 16 random bytes, hex
      token_hash text not null,             -- sha256(salt || secret), hex
      created text not null,
      revoked text                          -- ISO when revoked, else null
    );
    create table if not exists presence (
      team_id text not null, repo_id text not null, member text not null,
      sessions text not null,               -- JSON array, validated on write
      count integer not null, at text not null, updated integer not null,
      primary key (team_id, repo_id, member)
    );
    create table if not exists memory (
      id integer primary key autoincrement,
      team_id text not null, repo_id text not null, member text not null,
      line text not null, at text not null
    );
    create index if not exists memory_repo on memory(team_id, repo_id, id);
  `);
  return db;
}

// Tokens look like 'm-1a2b3c4d.<43 base64url chars>': the id finds the row, the secret is compared in constant time.
export function hashSecret(salt, secret) {
  return createHash('sha256').update(salt).update(secret).digest('hex');
}

export function newToken() {
  const id = 'm-' + randomBytes(4).toString('hex');
  const secret = randomBytes(32).toString('base64url');
  const salt = randomBytes(16).toString('hex');
  return { id, secret, salt, token: `${id}.${secret}`, hash: hashSecret(salt, secret) };
}

const DUMMY = { salt: '0'.repeat(32), token_hash: '0'.repeat(64) };

function authenticate(db, header) {
  const m = /^Bearer ([A-Za-z0-9._-]{1,200})$/.exec(header || '');
  const [id, secret] = m ? m[1].split('.', 2) : [];
  const row = id && /^m-[0-9a-f]{8}$/.test(id)
    ? db.prepare('select m.id, m.name, m.team_id, m.salt, m.token_hash, m.revoked from members m where m.id = ?').get(id)
    : undefined;
  // Always hash and compare, so an unknown id costs the same as a wrong secret.
  const ref = row || DUMMY;
  const got = Buffer.from(hashSecret(ref.salt, secret || ''), 'hex');
  const ok = timingSafeEqual(got, Buffer.from(ref.token_hash, 'hex'));
  if (!row || !ok || row.revoked) return null;
  return { id: row.id, member: row.name, team: row.team_id };
}

// --- validation ---------------------------------------------------------------------------------------------------
const isStr = (v, max) => typeof v === 'string' && v.length > 0 && v.length <= max;
const isPath = (p) => isStr(p, LIMITS.pathChars) && !p.startsWith('/') && !/^[A-Za-z]:/.test(p) && !p.split(/[\\/]/).includes('..') && !/[\0\n\r]/.test(p);

function cleanSession(s) {
  if (!s || typeof s !== 'object' || Array.isArray(s)) return null;
  const { id, plan, title, branch, status, files = [], areas = [], since } = s;
  if (!isStr(id, LIMITS.textChars)) return null;
  for (const v of [plan, title, branch]) if (v !== undefined && v !== null && !isStr(v, LIMITS.textChars)) return null;
  if (!isStr(status, 40) || !/^[a-z_-]+$/.test(status)) return null;
  if (!Array.isArray(files) || files.length > LIMITS.filesPerSession || !files.every(isPath)) return null;
  if (!Array.isArray(areas) || areas.length > LIMITS.areasPerSession || !areas.every(isPath)) return null;
  if (since !== undefined && since !== null && (typeof since !== 'string' || Number.isNaN(Date.parse(since)))) return null;
  // Only the fields of the contract go through: anything else in the object is dropped, never stored.
  return { id, plan: plan ?? null, title: title ?? null, branch: branch ?? null, status, files, areas, since: since ?? null };
}

// --- server -------------------------------------------------------------------------------------------------------
export function createRelay({ db, now = () => Date.now(), log = (line) => process.stdout.write(line + '\n'), trustProxy = false } = {}) {
  const hits = new Map(); // key -> [timestamps ms] in the last minute
  function limited(key) {
    const t = now();
    const list = (hits.get(key) || []).filter((x) => t - x < 60_000);
    list.push(t);
    hits.set(key, list);
    if (hits.size > 10_000) for (const [k, v] of hits) if (!v.length || t - v[v.length - 1] >= 60_000) hits.delete(k);
    return list.length > LIMITS.requestsPerMinute;
  }

  const q = {
    presence: db.prepare('select member, sessions, at from presence where team_id = ? and repo_id = ? and updated > ? order by member'),
    others: db.prepare('select coalesce(sum(count), 0) n from presence where team_id = ? and repo_id = ? and member <> ? and updated > ?'),
    put: db.prepare(`insert into presence (team_id, repo_id, member, sessions, count, at, updated) values (?, ?, ?, ?, ?, ?, ?)
      on conflict (team_id, repo_id, member) do update set sessions = excluded.sessions, count = excluded.count, at = excluded.at, updated = excluded.updated`),
    purge: db.prepare('delete from presence where updated <= ?'),
    addLine: db.prepare('insert into memory (team_id, repo_id, member, line, at) values (?, ?, ?, ?, ?)'),
    lines: db.prepare('select id, member, line, at from memory where team_id = ? and repo_id = ? and id > ? order by id limit ?'),
  };

  async function handle(req, res) {
    const send = (code, body) => {
      res.writeHead(code, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store', 'x-content-type-options': 'nosniff' });
      res.end(JSON.stringify(body));
      return code;
    };
    const url = new URL(req.url, 'http://relay');
    const parts = url.pathname.split('/').filter(Boolean);

    // /v1/health may be read from a browser page (the « Tester » button of the settings, docs/team.md): the one route with CORS
    if (url.pathname === '/v1/health') res.setHeader('access-control-allow-origin', '*');
    if (req.method === 'GET' && url.pathname === '/v1/health') return ['/v1/health', send(200, { ok: true, version: VERSION })];

    const route = parts.length === 4 && parts[0] === 'v1' && parts[1] === 'repos' && ['presence', 'memory'].includes(parts[3])
      ? `/v1/repos/:repoId/${parts[3]}` : null;
    if (!route) return ['?', send(404, { error: 'not found' })];

    const ip = trustProxy ? String(req.headers['x-forwarded-for'] || '').split(',')[0].trim() || req.socket.remoteAddress : req.socket.remoteAddress;
    const who = authenticate(db, req.headers.authorization);
    if (!who) {
      if (limited('ip:' + ip)) return [route, send(429, { error: 'too many requests' })];
      return [route, send(401, { error: 'unauthorized' })];
    }
    if (limited('tok:' + who.id)) return [route, send(429, { error: 'too many requests' })];

    const repoId = parts[2];
    if (!REPO_ID.test(repoId)) return [route, send(400, { error: 'bad repoId' })];
    const allowed = route.endsWith('presence') ? ['GET', 'PUT'] : ['GET', 'POST'];
    if (!allowed.includes(req.method)) return [route, send(405, { error: 'method not allowed' })];

    let body = null;
    if (req.method !== 'GET') {
      const declared = Number(req.headers['content-length'] || 0);
      if (declared > LIMITS.bodyBytes) { res.setHeader('connection', 'close'); return [route, send(413, { error: 'too large' })]; }
      const chunks = []; let size = 0;
      for await (const c of req) {
        size += c.length;
        if (size > LIMITS.bodyBytes) { res.setHeader('connection', 'close'); return [route, send(413, { error: 'too large' })]; }
        chunks.push(c);
      }
      try { body = JSON.parse(Buffer.concat(chunks).toString('utf8')); } catch { return [route, send(400, { error: 'bad json' })]; }
      if (!body || typeof body !== 'object' || Array.isArray(body)) return [route, send(400, { error: 'bad json' })];
    }

    const t = now();
    const fresh = t - LIMITS.presenceTtlMs;

    if (route.endsWith('presence') && req.method === 'GET') {
      const members = q.presence.all(who.team, repoId, fresh).map((r) => ({ member: r.member, sessions: JSON.parse(r.sessions), at: r.at }));
      return [route, send(200, { members })];
    }

    if (route.endsWith('presence')) {
      if (body.member !== undefined && body.member !== who.member) return [route, send(403, { error: 'forbidden' })];
      if (!Array.isArray(body.sessions)) return [route, send(400, { error: 'bad sessions' })];
      const sessions = body.sessions.map(cleanSession);
      if (sessions.some((s) => !s)) return [route, send(400, { error: 'bad session' })];
      if (body.at !== undefined && (typeof body.at !== 'string' || Number.isNaN(Date.parse(body.at)))) return [route, send(400, { error: 'bad at' })];
      const others = Number(q.others.get(who.team, repoId, who.member, fresh).n);
      if (others + sessions.length > LIMITS.sessionsPerRepo) return [route, send(409, { error: 'too many sessions' })];
      q.purge.run(fresh);
      // `at` is the server's clock: the expiry never depends on a client's clock.
      q.put.run(who.team, repoId, who.member, JSON.stringify(sessions), sessions.length, new Date(t).toISOString(), t);
      return [route, send(200, { ok: true })];
    }

    if (req.method === 'POST') {
      const line = typeof body.line === 'string' ? body.line.trim() : '';
      if (!line || line.length > LIMITS.lineChars || /[\0]/.test(line)) return [route, send(400, { error: 'bad line' })];
      const r = q.addLine.run(who.team, repoId, who.member, line, new Date(t).toISOString());
      return [route, send(200, { ok: true, id: Number(r.lastInsertRowid) })];
    }

    const sinceRaw = url.searchParams.get('since');
    const since = sinceRaw === null || sinceRaw === '' ? 0 : Number(sinceRaw);
    if (!Number.isSafeInteger(since) || since < 0) return [route, send(400, { error: 'bad since' })];
    const lines = q.lines.all(who.team, repoId, since, LIMITS.linesPerRead).map((r) => ({ id: Number(r.id), member: r.member, line: r.line, at: r.at }));
    return [route, send(200, { lines })];
  }

  return http.createServer(async (req, res) => {
    const start = process.hrtime.bigint();
    let route = '?', code = 500;
    try {
      [route, code] = await handle(req, res);
    } catch {
      if (!res.headersSent) { res.writeHead(500, { 'content-type': 'application/json' }); res.end('{"error":"internal"}'); }
    }
    // The log never holds a token, a repoId, a member name, a body or an address.
    const ms = Number(process.hrtime.bigint() - start) / 1e6;
    log(`${new Date(now()).toISOString()} ${req.method} ${route} ${code} ${ms.toFixed(1)}ms`);
  });
}

if (import.meta.url === pathToFileURL(process.argv[1] || '').href) {
  const db = openDb(process.env.RELAY_DB || './relay.db');
  const port = Number(process.env.RELAY_PORT || 8787);
  const host = process.env.RELAY_HOST || '127.0.0.1';
  const server = createRelay({ db, trustProxy: process.env.RELAY_TRUST_PROXY === '1' });
  server.headersTimeout = 10_000;
  server.requestTimeout = 15_000;
  server.listen(port, host, () => {
    console.log(`escadrille-relay ${VERSION} on http://${host.includes(':') ? `[${host}]` : host}:${server.address().port}`);
    const notice = lanNotice(host); if (notice) console.log('warning: ' + notice);
  });
  const stop = () => server.close(() => { db.close(); process.exit(0); });
  process.on('SIGTERM', stop);
  process.on('SIGINT', stop);
}
