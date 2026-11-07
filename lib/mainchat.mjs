// The main conversation of a project (docs/mainchat.md): one thread per project that lasts, the developer's
// messages, the pilot's answers, and the Claude Code conversations imported without their tools or reminders.
import { createReadStream, existsSync, realpathSync, statSync, readdirSync } from 'node:fs';
import readline from 'node:readline';
import { homedir } from 'node:os';
import path from 'node:path';
import { vars } from './names.mjs';

export const ROLES = ['dev', 'claude', 'system'];
export const MAX_TEXT = 20000;

export const schema = (db) => db.exec(`
  create table if not exists main_messages (seq integer primary key autoincrement, project text not null, role text not null, text text not null, source text, uid text, data text, at text not null);
  create unique index if not exists main_messages_uid on main_messages (project, uid);
  create index if not exists main_messages_at on main_messages (project, at, seq);
`);

// Where Claude Code keeps its transcripts; the tests point it elsewhere
export const projectsRoot = () => path.resolve(vars.CLAUDE_PROJECTS || path.join(homedir(), '.claude', 'projects'));
// Claude Code's folder name for a project: every '/' and '.' becomes '-'
// For a trial only (docs/mainchat.md): ESCADRILLE_TRANSCRIPTS_DIR, a flat folder of .jsonl copies, stands for the project's folder
const trialDir = () => (vars.TRANSCRIPTS_DIR ? path.resolve(vars.TRANSCRIPTS_DIR) : null);
export const transcriptDirOf = (project) => trialDir() || path.join(projectsRoot(), project.replace(/[/.]/g, '-'));

// ---------------------------------------------------------------- secrets
const SECRET_PATTERNS = [
  /\bsk-[A-Za-z0-9_-]{16,}/g,
  /\b(?:ghp|gho|ghu|ghs|ghr)_[A-Za-z0-9]{20,}/g,
  /\bgithub_pat_[A-Za-z0-9_]{20,}/g,
  /\bxox[abprs]-[A-Za-z0-9-]{10,}/g,
  /\bAKIA[0-9A-Z]{16}\b/g,
  /\blin_(?:api|oauth)_[A-Za-z0-9]{20,}/g,
  /ExponentPushToken\[[^\]]+\]/g,
  /\bBearer\s+[A-Za-z0-9._~+/=-]{16,}/g,
  /\b((?:password|passwd|secret|token|api[_-]?key|access[_-]?key)\s*[:=]\s*["']?)([^\s"'`]{8,})/gi,
];
// A long run that mixes upper case, lower case and digits looks like a key; pure hex (a git hash, a uuid) stays
// (no '/', '-' or '.' inside: a path or a branch name is never one run)
const LONG = /[A-Za-z0-9_+=]{32,}/g;
const count = (s, re) => (s.match(re) || []).length;
const looksRandom = (s) => count(s, /[a-z]/g) >= 2 && count(s, /[A-Z]/g) >= 2 && count(s, /[0-9]/g) >= 2 && !/^[0-9a-fA-F]+$/.test(s);
export const maskSecrets = (text) => {
  let n = 0; let t = String(text);
  for (const re of SECRET_PATTERNS) t = t.replace(re, (m, pre, val) => { n++; return val !== undefined && typeof pre === 'string' ? pre + '[masqué]' : '[masqué]'; });
  t = t.replace(LONG, (m) => { if (!looksRandom(m)) return m; n++; return '[masqué]'; });
  return { text: t, masked: n };
};

// ---------------------------------------------------------------- reading a transcript
const ENVELOPES = /<(system-reminder|task-notification)>[\s\S]*?<\/\1>/g;
const DROP_START = /^(\[SYSTEM NOTIFICATION|<local-command-stdout>|<local-command-stderr>|<local-command-caveat>|Caveat: The messages below)/;
// What a human typed, from a user line's content: null for a tool result or nothing left once the envelopes are gone
export const humanText = (content) => {
  let t;
  if (typeof content === 'string') t = content;
  else if (Array.isArray(content)) { if (content.some((b) => b && b.type === 'tool_result')) return null; t = content.filter((b) => b && b.type === 'text').map((b) => b.text).join('\n\n'); }
  else return null;
  t = t.replace(ENVELOPES, '').trim();
  const cmd = /<command-name>([^<]*)<\/command-name>/.exec(t);
  if (cmd) { const args = /<command-args>([\s\S]*?)<\/command-args>/.exec(t); return `${cmd[1].trim()}${args && args[1].trim() ? ' ' + args[1].trim() : ''}`; }
  if (!t || DROP_START.test(t)) return null;
  // A paste keeps its text, quoted, without the harness's tag
  t = t.replace(/[ \t]*<pasted_content[^>]*>([\s\S]*?)<\/pasted_content[^>]*>[ \t]*/g, (m, body) => '\n\n' + body.trim().split('\n').map((l) => '> ' + l).join('\n') + '\n\n').replace(/\n{3,}/g, '\n\n').trim();
  return t;
};
const promptText = (p) => (typeof p === 'string' ? p : Array.isArray(p) ? p.filter((b) => b && b.type === 'text').map((b) => b.text).join('\n\n') : '');

// Streams the JSONL line by line (they are big): the human's messages and Claude's text, one answer per turn
export const importTranscript = async (jsonlPath, { info } = {}) => {
  const out = []; let session = null; let entrypoint = null; let turn = null; const lastDev = new Map();
  const closeTurn = () => { if (turn && turn.parts.length) out.push({ uid: turn.uid, role: 'claude', text: turn.parts.join('\n\n'), at: turn.at }); turn = null; };
  const dev = (uid, text, at) => {
    const prev = lastDev.get(text); if (prev !== undefined && Math.abs(Date.parse(at) - prev) < 120000) return; // queued then delivered: one trace
    lastDev.set(text, Date.parse(at)); closeTurn(); out.push({ uid, role: 'dev', text, at });
  };
  const rl = readline.createInterface({ input: createReadStream(jsonlPath), crlfDelay: Infinity });
  for await (const line of rl) {
    if (!line.trim()) continue; let o; try { o = JSON.parse(line); } catch { continue; }
    if (o.sessionId && !session) session = o.sessionId; if (o.entrypoint && !entrypoint) entrypoint = o.entrypoint;
    if (o.isSidechain || !o.uuid) continue;
    if (o.type === 'user') {
      if (o.isMeta || o.isCompactSummary) continue;
      const t = humanText(o.message?.content); if (t) dev(o.uuid, t, o.timestamp);
    } else if (o.type === 'attachment' && o.attachment?.type === 'queued_command' && (!o.attachment.origin || o.attachment.origin.kind === 'human')) {
      const t = humanText(promptText(o.attachment.prompt)); if (t) dev(o.uuid, t, o.timestamp);
    } else if (o.type === 'assistant') {
      const texts = (o.message?.content || []).filter((b) => b && b.type === 'text' && String(b.text || '').trim()).map((b) => b.text.trim());
      if (!texts.length) continue;
      if (!turn) turn = { uid: o.uuid, parts: [], at: o.timestamp };
      turn.parts.push(...texts); turn.at = o.timestamp;
    }
  }
  closeTurn();
  if (info) Object.assign(info, { session, entrypoint });
  return out;
};

// The first human message and the entrypoint of a transcript, without reading more than needed
export const peekTranscript = async (file) => {
  const rl = readline.createInterface({ input: createReadStream(file), crlfDelay: Infinity });
  let entrypoint = null; let session = null; let n = 0;
  try {
    for await (const line of rl) {
      if (++n > 4000) break; let o; try { o = JSON.parse(line); } catch { continue; }
      entrypoint ||= o.entrypoint || null; session ||= o.sessionId || null;
      if (o.type === 'user' && !o.isMeta && !o.isSidechain) { const t = humanText(o.message?.content); if (t) return { first: t.replace(/\s+/g, ' ').slice(0, 140), firstAt: o.timestamp, entrypoint, session }; }
    }
  } finally { rl.close(); }
  return { first: null, firstAt: null, entrypoint, session };
};

// A path given to the import: a .jsonl that exists under the transcripts root once every link is resolved
export const checkTranscriptPath = (p) => {
  const s = String(p || '').trim();
  if (!s || !path.isAbsolute(s)) throw new Error('path : un chemin absolu');
  if (!s.endsWith('.jsonl')) throw new Error('path : un fichier .jsonl');
  if (!existsSync(s) || !statSync(s).isFile()) throw new Error('path : fichier introuvable');
  const real = realpathSync(s); const roots = [projectsRoot(), trialDir()].filter(Boolean).map((r) => (existsSync(r) ? realpathSync(r) : r));
  if (!roots.some((root) => real.startsWith(root + path.sep))) throw new Error('path : seulement sous ~/.claude/projects/');
  return real;
};

// ---------------------------------------------------------------- the table
const row = (r) => r && ({ seq: r.seq, role: r.role, text: r.text, source: r.source, at: r.at, data: r.data ? JSON.parse(r.data) : null });
export const addMessage = (db, { project, role, text, source = null, uid = null, data = null, at = new Date().toISOString() }) => {
  if (!ROLES.includes(role)) throw new Error('role : dev, claude ou system');
  const t = String(text ?? '').trim(); if (!t) throw new Error('text : un message vide'); if (t.length > MAX_TEXT) throw new Error(`text : ${MAX_TEXT} caractères au plus`);
  const r = db.prepare('insert into main_messages (project, role, text, source, uid, data, at) values (?, ?, ?, ?, ?, ?, ?)').run(project, role, t, source, uid, data ? JSON.stringify(data) : null, at);
  return row(db.prepare('select * from main_messages where seq = ?').get(r.lastInsertRowid));
};

// Newest first; before: the oldest seq already shown; q: a filter on the text
export const listMessages = (db, project, { before = null, limit = 50, q = '' } = {}) => {
  limit = Math.max(1, Math.min(200, Number(limit) || 50));
  const like = q ? '%' + String(q).replace(/[%_\\]/g, (c) => '\\' + c) + '%' : null;
  const cond = `project = ?${like ? " and text like ? escape '\\'" : ''}`; const args = like ? [project, like] : [project];
  const total = db.prepare(`select count(*) as n from main_messages where ${cond}`).get(...args).n;
  let where = cond; let wargs = args;
  if (before != null) { const b = db.prepare('select at, seq from main_messages where seq = ? and project = ?').get(Number(before), project); if (b) { where += ' and (at < ? or (at = ? and seq < ?))'; wargs = [...args, b.at, b.at, b.seq]; } }
  const rows = db.prepare(`select * from main_messages where ${where} order by at desc, seq desc limit ?`).all(...wargs, limit + 1);
  return { project, messages: rows.slice(0, limit).map(row), more: rows.length > limit, total };
};

// The developer's messages after the pilot's last answer: what the pilot has to answer (the entry point)
export const pendingOf = (db, project) => {
  const last = db.prepare("select at, seq from main_messages where project = ? and role = 'claude' order by at desc, seq desc limit 1").get(project);
  const rows = last
    ? db.prepare("select * from main_messages where project = ? and role = 'dev' and (at > ? or (at = ? and seq > ?)) order by at, seq").all(project, last.at, last.at, last.seq)
    : db.prepare("select * from main_messages where project = ? and role = 'dev' order by at, seq").all(project);
  return { project, since: last ? last.at : null, messages: rows.map(row) };
};

// Imports a transcript into a project's thread: nothing doubles (key: the line's uuid), an answer that grew is updated
export const importInto = async (db, project, file) => {
  const real = checkTranscriptPath(file); const info = {};
  const items = await importTranscript(real, { info });
  const source = 'claude-code:' + (info.session || path.basename(real, '.jsonl'));
  let added = 0, updated = 0, kept = 0, masked = 0;
  const get = db.prepare('select seq, text, data from main_messages where project = ? and uid = ?'); const data = JSON.stringify({ entrypoint: info.entrypoint || null }); // 'cli' a conversation, 'sdk-cli' a claude -p session
  const ins = db.prepare('insert into main_messages (project, role, text, source, uid, data, at) values (?, ?, ?, ?, ?, ?, ?)');
  const upd = db.prepare('update main_messages set text = ?, at = ?, data = ? where seq = ?');
  db.exec('begin');
  try {
    for (const it of items) {
      const m = maskSecrets(it.text); masked += m.masked; const text = m.text.length > MAX_TEXT * 5 ? m.text.slice(0, MAX_TEXT * 5) + '\n\n[…]' : m.text;
      const cur = get.get(project, it.uid);
      if (!cur) { ins.run(project, it.role, text, source, it.uid, data, it.at || new Date().toISOString()); added++; }
      else if (cur.text !== text || cur.data !== data) { upd.run(text, it.at, data, cur.seq); updated++; }
      else kept++;
    }
    db.exec('commit');
  } catch (e) { db.exec('rollback'); throw e; }
  return { ok: true, session: info.session, entrypoint: info.entrypoint, added, updated, kept, masked };
};

// The .jsonl of a project's Claude Code folder, newest first (by their first message), with their first message and what is already imported
export const listTranscripts = async (db, project) => {
  const dir = transcriptDirOf(project);
  if (!existsSync(dir)) return { dir, files: [] };
  const files = [];
  for (const name of readdirSync(dir).filter((f) => f.endsWith('.jsonl'))) {
    const p = path.join(dir, name); const st = statSync(p); if (!st.isFile()) continue;
    const peek = await peekTranscript(p);
    const imported = db.prepare('select count(*) as n from main_messages where project = ? and source = ?').get(project, 'claude-code:' + (peek.session || name.replace(/\.jsonl$/, ''))).n;
    files.push({ path: p, name, size: st.size, at: st.mtime.toISOString(), first: peek.first, firstAt: peek.firstAt, entrypoint: peek.entrypoint, imported });
  }
  const key = (f) => f.firstAt || f.at; files.sort((a, b) => (key(a) < key(b) ? 1 : -1)); // by the date of the conversation, not of the copy
  return { dir, files };
};
