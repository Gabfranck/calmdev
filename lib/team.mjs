// Escadrille for teams, the PoC (docs/team.md): a few developers, each at home, share through a relay Dev deploys himself
// (Scaleway, his account, his gesture) nothing but metadata: who works on what (member, plan and session titles, branch,
// status, the files touched, the areas a planned session names), and the lines of the team memory. Never code, a diff, a
// transcript or a prompt. Off by default, per project; the token lives in ~/.config/escadrille/secrets.json (lib/secrets.mjs),
// is never returned by a route, never logged, never committed.
//
//   repoIdOf(remoteUrl)                      sha256 of the normalized origin URL (no credentials, no .git, lower case), or null
//   validateTeam(raw, { hasToken })          → { value: { relay, member, on }, token, errors }   (the token apart: it goes to the secrets)
//   publicView(stored, hasToken)             → { relay, member, on, token: bool }   what a GET may say
//   areasOf(where, subdir)                   the paths and folders read in a session's `where`, as motifs
//   collisions({ ours, others })             the pairs that step on each other, once per pair
//   teamLine(line)                           the text of a memory line marked « équipe », or null
//   createRelay({ relay, token, fetch })     the four calls of the contract, never throwing: { ok, status, body, error }
//   createTeamSync({ … })                    the loop: every INTERVAL_MS and at each change of state, PUT our presence, GET the others', GET the memory
import { createHash } from 'node:crypto';
import path from 'node:path';
import { msg } from './i18n.mjs';
import { projectRel } from './names.mjs';

export const INTERVAL_MS = 30e3; // the contract: a presence expires after 10 min without a PUT; we refresh far more often
export const TOUCH_DEBOUNCE_MS = 1500; // a change of state pushes soon, several changes in a row push once
export const MIN_PUSH_GAP_MS = 5e3; // never more than one push every 5 s (60 requests a minute per token at the relay)
export const PRESENCE_STATUSES = ['running', 'waiting', 'paused']; // what we publish: the sessions at work or waiting
export const LOCAL_STATUSES = ['running', 'waiting', 'paused', 'todo', 'later']; // what we protect: ours, planned ones included
export const MEMORY_FILE = projectRel('equipe.md'); // the lines of the others, per project, never committed
const MAX_FILES = 500; const MAX_AREAS = 20; const MAX_SESSIONS = 500;

// ---------------------------------------------------------------- the repository
// https://user:pw@GitHub.com/Dev/Escadrille.git → github.com/dev/escadrille ; git@github.com:Dev/Escadrille.git → the same
export const normalizeRemote = (remote) => {
  let s = String(remote || '').trim(); if (!s) return null;
  const ssh = /^([\w.-]+)@([\w.-]+):(.+)$/.exec(s); if (ssh && !/^[a-z]+:\/\//i.test(s)) s = `ssh://${ssh[2]}/${ssh[3]}`;
  if (!/^[a-z][a-z0-9+.-]*:\/\//i.test(s)) s = 'file://' + s;
  let u; try { u = new URL(s); } catch { return null; }
  const host = u.hostname.toLowerCase(); const p = u.pathname.replace(/\/+$/, '').replace(/\.git$/i, '').replace(/^\/+/, '').toLowerCase();
  if (!p) return null;
  return host ? `${host}/${p}` : p;
};
export const repoIdOf = (remote) => { const n = normalizeRemote(remote); return n ? createHash('sha256').update(n).digest('hex') : null; };

// ---------------------------------------------------------------- the setting
const MEMBER = /^[\p{L}\p{N}][\p{L}\p{N} ._'-]{0,39}$/u;
export const validateTeam = (raw, { hasToken = false } = {}) => {
  const errors = []; const value = { on: false };
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return { value: null, token: undefined, errors: ['team : un objet { relay, token, member, on }'] };
  if (raw.relay !== undefined && raw.relay !== null) {
    const s = String(raw.relay).trim(); let u = null; try { u = new URL(s); } catch {}
    if (!u || !/^https?:$/.test(u.protocol) || !u.hostname) errors.push('relay : une URL http(s)'); else value.relay = u.origin + u.pathname.replace(/\/+$/, '');
  }
  if (raw.member !== undefined && raw.member !== null) { const m = String(raw.member).trim(); if (!MEMBER.test(m)) errors.push('member : un nom de 1 à 40 caractères (lettres, chiffres, espace, . _ -)'); else value.member = m; }
  let token; // undefined: untouched; null: cleared; a string: set
  if (raw.token !== undefined) { if (raw.token === null || raw.token === '') token = null; else { const t = String(raw.token).trim(); if (t.length < 8 || /\s/.test(t)) errors.push('token : un jeton de membre, 8 caractères au moins, sans espace'); else token = t; } }
  if (raw.on !== undefined && raw.on !== null) { if (typeof raw.on !== 'boolean') errors.push('on : true ou false'); else value.on = raw.on; }
  const tokenThen = token === undefined ? hasToken : !!token;
  if (value.on && !errors.length && (!value.relay || !value.member || !tokenThen)) errors.push('on : il faut un relais, un nom de membre et un jeton avant d’allumer le partage');
  return errors.length ? { value: null, token: undefined, errors } : { value, token, errors: null };
};
// What a GET says: never the token, only whether one is stored
export const publicView = (stored, hasToken = false) => { const t = stored && typeof stored === 'object' ? stored : {}; return { relay: t.relay || null, member: t.member || null, on: t.on === true && !!t.relay && !!t.member && !!hasToken, token: !!hasToken }; };

// ---------------------------------------------------------------- files, areas, collisions
const FILEISH = /^[\w@.-]+(?:\/[\w@.*-]+)*\/?$|^[\w@-]+\.[a-z][a-z0-9]{0,7}$/i; // an extension has a letter: v2.1 is a version, not a file
const clean = (t) => t.replace(/^[`'"«(\[{<]+|[`'"»)\]}>,;:.!?]+$/g, '');
// The paths and folders a session's `where` names (« lib/team.mjs, docs/team.md ; le dossier migrations/ »), the folder it works
// in when it is not the root; as motifs: a file, a folder (ending in /), or a glob (* and **)
export const areasOf = (where, subdir = '') => {
  const out = new Set();
  const sub = String(subdir || '').replace(/^\.\/|^\/+|\/+$/g, ''); if (sub && sub !== '.') out.add(sub + '/');
  for (const raw of String(where || '').split(/[\s,;]+/)) {
    const t = clean(raw).replace(/^\.\//, ''); if (!t || t.length > 200 || !FILEISH.test(t) || /^https?:/i.test(t)) continue;
    if (!t.includes('/') && !/\.[a-z][a-z0-9]{0,7}$/i.test(t)) continue; // a bare word is not a path
    if (/^\d+(\.\d+)*$/.test(t)) continue; // a number, a version
    out.add(t); if (out.size >= MAX_AREAS) break;
  }
  return [...out];
};
const globRe = (m) => new RegExp('^' + m.split(/(\*\*|\*)/).map((p) => (p === '**' ? '.*' : p === '*' ? '[^/]*' : p.replace(/[.+?^${}()|[\]\\]/g, '\\$&'))).join('') + '$');
// A motif covers a file: the same path, a folder above it, or a glob that matches it
export const matchArea = (motif, file) => {
  const m = String(motif || '').replace(/^\.\//, ''); const f = String(file || '').replace(/^\.\//, ''); if (!m || !f) return false;
  if (m.endsWith('/')) return f.startsWith(m) || f === m.slice(0, -1);
  if (m.includes('*')) return globRe(m).test(f);
  return f === m || f.startsWith(m + '/');
};
// The folders where two different files still collide: a migration or a schema folder (one order, one version each)
export const MIGRATION_DIR = /^(migrations?|migrate|schemas?|prisma|alembic|drizzle|flyway|liquibase|db\/migrate)$/i;
export const migrationDirOf = (file) => {
  const parts = String(file || '').replace(/^\.\//, '').split('/'); if (parts.length < 2) return null;
  for (let i = 0; i < parts.length - 1; i++) {
    if (MIGRATION_DIR.test(parts[i])) return parts.slice(0, i + 1).join('/') + '/';
    if (i + 1 < parts.length - 1 && MIGRATION_DIR.test(parts[i] + '/' + parts[i + 1])) return parts.slice(0, i + 2).join('/') + '/';
  }
  return null;
};
// ours: [{ plan, id, title, status, files, areas }]; others: [{ member, sessions: [{ id, plan, title, branch, status, files, areas }] }]
// → one entry per pair (our session × their session), the first reason as `file`, every reason in `files`
export const collisions = ({ ours = [], others = [], self = null } = {}) => {
  const out = [];
  for (const o of others) {
    if (!o || !o.member || (self && o.member === self)) continue;
    for (const t of Array.isArray(o.sessions) ? o.sessions : []) {
      const tf = Array.isArray(t.files) ? t.files : []; const ta = Array.isArray(t.areas) ? t.areas : [];
      const tMig = new Set(tf.map(migrationDirOf).filter(Boolean));
      for (const s of ours) {
        const sf = Array.isArray(s.files) ? s.files : []; const sa = Array.isArray(s.areas) ? s.areas : [];
        const hits = []; let kind = null;
        const push = (k, what) => { if (!hits.includes(what)) hits.push(what); kind = kind || k; };
        for (const f of sf) if (tf.includes(f)) push('file', f);
        for (const f of sf) { const d = migrationDirOf(f); if (d && tMig.has(d)) push('migrations', d); }
        for (const a of sa) for (const f of tf) if (matchArea(a, f)) push('area', f);
        for (const a of ta) for (const f of sf) if (matchArea(a, f)) push('area', f);
        for (const a of sa) for (const b of ta) if (a === b || (a.endsWith('/') && matchArea(a, b.replace(/\/$/, ''))) || (b.endsWith('/') && matchArea(b, a.replace(/\/$/, '')))) push('area', a);
        if (!hits.length) continue;
        out.push({ key: `${s.plan}/${s.id}|${o.member}/${t.plan || ''}/${t.id}`, member: o.member, theirs: { id: t.id, plan: t.plan || null, title: t.title || t.id, branch: t.branch || null, status: t.status || null }, ours: { plan: s.plan, id: s.id, title: s.title || s.id, status: s.status || null }, kind, file: hits[0], files: hits });
      }
    }
  }
  return out;
};

// ---------------------------------------------------------------- the memory
// A line marked for the team: « équipe : … », « equipe: … », « [équipe] … », « team: … »
export const teamLine = (line) => { const m = /^\s*(?:\[\s*(?:équipe|equipe|team)\s*\]|(?:équipe|equipe|team)\s*:)\s*(.+)$/i.exec(String(line || '')); return m && m[1].trim() ? m[1].trim() : null; };
export const sanitizeLine = (s) => String(s || '').replace(/[\r\n]+/g, ' ').trim().slice(0, 1000); // the relay's limit (docs/team.md)
// The team's lines, as the planner and the pilot read them (after « La mémoire du projet »)
export const memorySection = ({ lines = [], others = [], collisions: cols = [], member = null } = {}) => {
  const parts = [];
  if (lines.length) parts.push(lines.slice(-20).map((l) => `- ${l.member} : ${l.line}`).join('\n'));
  const work = others.filter((o) => o.member !== member).flatMap((o) => (o.sessions || []).map((s) => `- ${o.member} · ${s.title || s.id}${s.branch ? ` (${s.branch})` : ''} · ${s.status || ''}${(s.files || []).length ? ` · fichiers : ${s.files.slice(0, 12).join(', ')}${s.files.length > 12 ? '…' : ''}` : ''}${(s.areas || []).length ? ` · zones : ${s.areas.join(', ')}` : ''}`));
  if (work.length) parts.push(`Les escadrilles des autres en ce moment (ne planifie pas une session sur les mêmes fichiers sans le dire dans le plan) :\n${work.join('\n')}`);
  if (cols.length) parts.push(`Collisions vues :\n${cols.map((c) => `- ${c.member} touche aussi ${c.file} (session ${c.theirs.title}) : notre session ${c.ours.title}`).join('\n')}`);
  return parts.length ? `\n\n## Équipe\n\n${parts.join('\n\n')}` : '';
};

// ---------------------------------------------------------------- the relay client (the contract of docs/team.md)
export const createRelay = ({ relay, token, fetch: f = globalThis.fetch, timeoutMs = 5000 } = {}) => {
  const base = String(relay || '').replace(/\/+$/, '');
  const call = async (method, p, body) => {
    try {
      const r = await f(base + p, { method, headers: { authorization: `Bearer ${token}`, ...(body !== undefined ? { 'content-type': 'application/json' } : {}) }, body: body !== undefined ? JSON.stringify(body) : undefined, signal: AbortSignal.timeout(timeoutMs) });
      let json = null; try { json = await r.json(); } catch {}
      return { ok: r.ok, status: r.status, body: json, error: r.ok ? null : (json && json.error) || `HTTP ${r.status}` };
    } catch (e) { return { ok: false, status: 0, body: null, error: e?.name === 'TimeoutError' ? 'délai dépassé' : (e?.cause?.code || e?.code || e?.message || 'injoignable') }; }
  };
  return {
    health: () => call('GET', '/v1/health'),
    putPresence: (repoId, body) => call('PUT', `/v1/repos/${repoId}/presence`, body),
    getPresence: (repoId) => call('GET', `/v1/repos/${repoId}/presence`),
    postMemory: (repoId, line) => call('POST', `/v1/repos/${repoId}/memory`, { line }),
    getMemory: (repoId, since) => call('GET', `/v1/repos/${repoId}/memory${since ? `?since=${encodeURIComponent(since)}` : ''}`),
  };
};

// ---------------------------------------------------------------- the loop
// settingsOf(project) → { relay, member, on, token } (the token for the calls only; never kept here beyond the call)
// repoIdOf(project) → async repoId | null;  sessionsOf(project) → async [{ plan, id, title, branch, status, files, areas }]
// onCollision(project, collision) → called once per pair;  onMemory(project, [{ id, member, line, at }]) → the others' new lines
// cursorOf(project) / saveCursor(project, id): the id of the last memory line read, kept across restarts
// projects() → the projects whose sharing is on (the tick walks them)
export const createTeamSync = ({ settingsOf, repoIdOf: repoOf, sessionsOf, onCollision = () => {}, onMemory = () => {}, cursorOf = () => null, saveCursor = () => {}, projects = () => [], fetch: f = globalThis.fetch, now = Date.now, log = () => {} } = {}) => {
  const states = new Map(); // project → { state, line, at, others, collisions, alerted: Set, lastPush, timer, busy }
  const stateOf = (project) => { let s = states.get(project); if (!s) { s = { state: 'starting', line: 'Premier contact avec le relais…', at: null, others: [], collisions: [], alerted: new Set(), lastPush: 0, timer: null, inflight: null, repoId: null, pushes: 0 }; states.set(project, s); } return s; };
  const relayOf = (project) => { const st = settingsOf(project); return st && st.on && st.relay && st.token && st.member ? { relay: createRelay({ relay: st.relay, token: st.token, fetch: f }), member: st.member, write: st.write !== false } : null; }; // write: false = the licence ended (lib/license.mjs): read only, no PUT, no POST
  // 401: the token; 403: the relay publishes only under the token's own member name (docs/team.md)
  const offline = (s, r) => { s.state = r.status === 401 || r.status === 403 ? 'refused' : r.status ? 'error' : 'offline'; s.line = r.status === 401 ? 'Relais : jeton refusé' : r.status === 403 ? 'Relais : jeton refusé ou nom de membre différent de celui du jeton' : r.status === 429 ? 'Relais occupé : nouvel essai dans quelques secondes' : s.state === 'error' ? `Relais : ${r.error}` : `Relais injoignable (${r.error || 'hors ligne'})`; s.at = new Date(now()).toISOString(); };

  // one sync at a time per project: a second call while one is in flight waits for it (and gets its state)
  const sync = (project) => { const s = stateOf(project); if (s.inflight) return s.inflight; s.inflight = syncNow(project, s).finally(() => { s.inflight = null; }); return s.inflight; };
  const syncNow = async (project, s) => {
    try {
      const rl = relayOf(project); if (!rl) { s.state = 'off'; s.line = ''; return s; }
      const repoId = s.repoId || (s.repoId = await repoOf(project)); if (!repoId) { s.state = 'error'; s.line = 'Pas de remote origin : rien à partager'; return s; }
      const sessions = (await sessionsOf(project)) || [];
      const mine = sessions.filter((x) => PRESENCE_STATUSES.includes(x.status)).slice(0, MAX_SESSIONS).map((x) => ({ id: x.id, plan: x.plan, title: x.title || x.id, branch: x.branch || null, status: x.status, files: (x.files || []).slice(0, MAX_FILES), areas: (x.areas || []).slice(0, MAX_AREAS), since: x.since || null }));
      if (rl.write) {
        s.lastPush = now(); s.pushes++;
        const put = await rl.relay.putPresence(repoId, { member: rl.member, sessions: mine, at: new Date(now()).toISOString() });
        if (!put.ok) { offline(s, put); return s; }
      }
      const got = await rl.relay.getPresence(repoId);
      if (!got.ok) { offline(s, got); return s; }
      s.others = (Array.isArray(got.body?.members) ? got.body.members : []).filter((m) => m && m.member && m.member !== rl.member).map((m) => ({ member: String(m.member), at: m.at || null, sessions: Array.isArray(m.sessions) ? m.sessions : [] }));
      s.state = 'ok'; s.at = new Date(now()).toISOString(); s.line = msg(rl.write ? 'team.status.joined' : 'team.status.readOnly', { n: s.others.length }); // decoded for the page's language
      // the collisions: ours at work, waiting or planned, against theirs; each pair once
      const ours = sessions.filter((x) => LOCAL_STATUSES.includes(x.status));
      const found = collisions({ ours, others: s.others, self: rl.member });
      s.collisions = found;
      for (const c of found) if (!s.alerted.has(c.key)) { s.alerted.add(c.key); try { onCollision(project, c); } catch (e) { log('team collision', e); } }
      // the memory of the team: the lines after our cursor
      const mem = await rl.relay.getMemory(repoId, cursorOf(project));
      if (mem.ok && Array.isArray(mem.body?.lines) && mem.body.lines.length) {
        const lines = mem.body.lines.filter((l) => l && l.id !== undefined && typeof l.line === 'string');
        const theirs = lines.filter((l) => String(l.member || '') !== rl.member); // our own lines are already in our memory file
        if (theirs.length) { try { onMemory(project, theirs.map((l) => ({ id: l.id, member: String(l.member || '?'), line: sanitizeLine(l.line), at: l.at || null }))); } catch (e) { log('team memory', e); } }
        if (lines.length) saveCursor(project, lines[lines.length - 1].id);
      }
      return s;
    } catch (e) { s.state = 'error'; s.line = `Relais : ${e.message}`; return s; }
  };

  return {
    // every INTERVAL_MS: each project whose sharing is on
    // (never within MIN_PUSH_GAP_MS of the last push: a short interval would pass the relay's 60 requests a minute, 3 per sync)
    async tick() { for (const p of projects()) { const s = states.get(p); if (s && s.lastPush && now() - s.lastPush < MIN_PUSH_GAP_MS) continue; try { await sync(p); } catch (e) { log('team', e); } } },
    // a change of state of a session: one push soon, never two within MIN_PUSH_GAP_MS
    touch(project) {
      if (!project) return; const st = settingsOf(project); if (!st || !st.on) return;
      const s = stateOf(project); if (s.timer) return;
      const wait = Math.max(TOUCH_DEBOUNCE_MS, s.lastPush + MIN_PUSH_GAP_MS - now());
      s.timer = setTimeout(() => { s.timer = null; sync(project).catch((e) => log('team', e)); }, wait); if (s.timer.unref) s.timer.unref();
    },
    sync,
    // a memory line marked « équipe »: sent to the relay when the sharing is on; { sent, error }
    async sendMemory(project, line) {
      const rl = relayOf(project); if (!rl) return { sent: false, error: 'partage éteint' };
      if (!rl.write) return { sent: false, error: 'lecture seule' };
      const s = stateOf(project); const repoId = s.repoId || (s.repoId = await repoOf(project)); if (!repoId) return { sent: false, error: 'pas de remote origin' };
      const r = await rl.relay.postMemory(repoId, sanitizeLine(line)); if (!r.ok) offline(s, r);
      return { sent: r.ok, error: r.ok ? null : r.error };
    },
    statusOf(project) { const st = settingsOf(project); const s = states.get(project); if (!st || !st.on) return { state: 'off', line: '', at: null }; return s ? { state: s.state, line: s.line, at: s.at } : { state: 'starting', line: 'Premier contact avec le relais…', at: null }; },
    othersOf(project) { return (states.get(project) || {}).others || []; },
    collisionsOf(project) { return (states.get(project) || {}).collisions || []; },
    pushesOf(project) { return (states.get(project) || {}).pushes || 0; },
    forget(project) { const s = states.get(project); if (s && s.timer) clearTimeout(s.timer); states.delete(project); },
    stop() { for (const s of states.values()) if (s.timer) clearTimeout(s.timer); },
  };
};
