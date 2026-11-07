// The single entry conversation « Escadrille » (docs/entry.md, session ENT): the developer writes without choosing a project;
// the project is recognised (first without a model, then by Haiku with no tool), the request goes to that project's main
// conversation as a developer message (source 'entry'), and the answers are read back from it, never copied.
// Everything the server owns is injected (create(deps)): this file opens no process, no socket and no file outside a project.
import fs from 'node:fs';
import path from 'node:path';

export const MODEL = 'claude-haiku-5-5';
export const BUDGET = 0.02; // dollars, one routing by Haiku
export const SURE = 0.7; // under this confidence, one question to the developer
export const FOLLOW_MS = 10 * 60 * 1000; // a follow-up keeps the last project for ten minutes
export const MAX_TEXT = 20000;
const EXAMPLES = 6; // corrections shown to Haiku
const MEMORY_LINES = 8;

export const schema = (db) => {
  db.exec(`create table if not exists entry_messages (
    seq integer primary key autoincrement,
    text text not null,
    project text,            -- the project's absolute path; null for a general question or while it waits for a choice
    main_seq integer,        -- the message written in main_messages of that project
    how text,                -- name | alias | path | repo | follow | model | asked | corrected | general | fallback
    status text not null,    -- routing | sent | ask | general
    data text,               -- JSON: { choices: [path, path], answer, confidence }
    at text not null
  );
  create table if not exists entry_corrections (
    seq integer primary key autoincrement,
    text text not null, from_project text, to_project text not null, at text not null
  );`);
};

// ---- the projects as the router sees them
export const fold = (s) => String(s || '').normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase();
export const nameOf = (p) => (p && (p.name || String(p.path).split('/').filter(Boolean).pop())) || '';
const words = (s) => fold(s).replace(/[^a-z0-9/._-]+/g, ' ');
const hasWord = (text, w) => { const f = fold(w).trim(); if (f.length < 3) return false; const re = new RegExp(`(^|[^a-z0-9])${f.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}($|[^a-z0-9])`); return re.test(words(text)); };

// The repositories a project names in its .git/config: 'owner/repo' and 'repo'
export const reposOf = (dir) => {
  try {
    let git = path.join(dir, '.git');
    if (fs.statSync(git).isFile()) { const m = /gitdir:\s*(.+)/.exec(fs.readFileSync(git, 'utf8')); if (!m) return []; git = path.resolve(dir, m[1].trim()); }
    const cfg = fs.readFileSync(path.join(git, 'config'), 'utf8');
    const out = new Set();
    for (const m of cfg.matchAll(/url\s*=\s*\S*?[:/]([\w.-]+)\/([\w.-]+?)(?:\.git)?\s*$/gm)) { out.add(`${m[1]}/${m[2]}`); if (m[2].length >= 4) out.add(m[2]); }
    return [...out];
  } catch { return []; }
};

// One line about a project: the first paragraph line of README.md, else of CLAUDE.md, else its title
export const summaryOf = (dir) => {
  for (const f of ['README.md', 'CLAUDE.md']) {
    let src; try { src = fs.readFileSync(path.join(dir, f), 'utf8'); } catch { continue; }
    const lines = src.split('\n').map((l) => l.trim()).filter(Boolean);
    const para = lines.find((l) => !/^(#|!\[|\[!|<|>|```|[-*|] )/.test(l));
    const head = lines.find((l) => l.startsWith('#'));
    const s = (para || head || '').replace(/^#+\s*/, '').replace(/[*_`]/g, '');
    if (s) return s.length > 160 ? s.slice(0, 157) + '…' : s;
  }
  return '';
};

export const factsOf = (p, { settingsOf = () => ({}), repos = reposOf } = {}) => {
  const st = settingsOf(p.path) || {};
  return { path: p.path, name: nameOf(p), aliases: Array.isArray(st.aliases) ? st.aliases.filter((a) => typeof a === 'string') : [], repos: repos(p.path) };
};

const FOLLOW = /^(et|aussi|ok|okay|oui|non|vas[- ]y|go|plutot|ensuite|puis|pareil|fais[- ]le|continue|parfait|merci|d'accord|daccord)\b/;

// Without a model: a path, a name, an alias, a repository; else the obvious follow-up. → { project, how } | { candidates } | null
export const routeLocal = ({ text, projects = [], last = null, now = Date.now() }) => {
  const t = String(text || '');
  const byPath = projects.filter((p) => t.includes(p.path + '/') || new RegExp(`${p.path.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}($|[^\\w/.-])`).test(t)).sort((a, b) => b.path.length - a.path.length);
  if (byPath.length) return { project: byPath[0].path, how: 'path' };
  const hits = new Map();
  for (const p of projects) {
    // the most specific first: a repository cited (« owner/repo-x » also holds the name), then the name, then an alias
    const how = p.repos.some((r) => hasWord(t, r)) ? 'repo' : hasWord(t, p.name) ? 'name' : p.aliases.some((a) => hasWord(t, a)) ? 'alias' : null;
    if (how) hits.set(p.path, how);
  }
  if (hits.size === 1) { const [[project, how]] = hits; return { project, how }; }
  if (hits.size > 1) return { candidates: [...hits.keys()] };
  if (last && last.project && now - Date.parse(last.at) < FOLLOW_MS && t.length < 200 && FOLLOW.test(fold(t).trim())) return { project: last.project, how: 'follow' };
  return null;
};

// ---- Haiku, with no tool: the list of the projects, one line each, the end of their memory, the developer's corrections
export const systemPrompt = () => `Tu es l'aiguilleur de l'entrée d'Escadrille. Tu n'utilises aucun outil et tu ne lis aucun fichier.
Le développeur écrit une demande sans dire à quel projet elle s'adresse. Tu choisis le projet dans la liste, ou "none" quand la
demande ne vise aucun projet (une question générale : alors tu y réponds toi-même, en français, en cinq lignes au plus).
Réponds par une seule ligne de JSON, rien d'autre :
{"project":"<nom exact de la liste>|none","second":"<le deuxième projet probable, ou null>","confidence":<0 à 1>,"answer":"<seulement si none>"}
Une confiance sous 0.7 veut dire que tu hésites : le développeur choisira entre project et second.`;

export const modelPrompt = ({ text, projects = [], corrections = [], candidates = [] }) => [
  '## Les projets',
  ...projects.map((p) => [`### ${p.name}`, p.summary ? p.summary : '(pas de résumé)', ...(p.memory.length ? ['Mémoire, la fin :', ...p.memory.map((l) => '  ' + l)] : [])].join('\n')),
  ...(corrections.length ? ['', '## Corrections du développeur (des exemples à suivre)', ...corrections.map((c) => `- « ${c.text.slice(0, 200)} » : pas ${c.from || 'une question générale'}, mais ${c.to}`)] : []),
  ...(candidates.length ? ['', `La demande cite plusieurs projets : ${candidates.join(', ')}.`] : []),
  '', '## La demande', String(text).slice(0, 4000),
].join('\n');

export const parseModel = (out, names) => {
  const m = /\{[\s\S]*\}/.exec(String(out || '')); if (!m) return null;
  let j; try { j = JSON.parse(m[0]); } catch { return null; }
  const pick = (n) => (typeof n === 'string' ? names.find((x) => fold(x) === fold(n.trim())) || null : null);
  const confidence = Math.max(0, Math.min(1, Number(j.confidence) || 0));
  const none = typeof j.project === 'string' && fold(j.project).trim() === 'none';
  return { project: none ? null : pick(j.project), second: pick(j.second), confidence, none, answer: none && typeof j.answer === 'string' ? j.answer.trim() : '' };
};

// The decision from Haiku's answer: send, ask (the two likely projects, the first recommended), or keep as a general question
export const decide = (parsed, { byName, fallback = [] }) => {
  const two = (a, b) => { const out = [a, b, ...fallback].filter(Boolean).filter((x, i, l) => l.indexOf(x) === i); return out.slice(0, 2); };
  if (!parsed) return { status: 'ask', how: 'fallback', choices: two(null, null) };
  const p = parsed.project && byName(parsed.project); const s = parsed.second && byName(parsed.second);
  if (parsed.none && parsed.confidence >= SURE) return { status: 'general', how: 'general', answer: parsed.answer };
  if (p && parsed.confidence >= SURE) return { status: 'sent', how: 'model', project: p };
  return { status: 'ask', how: 'model', choices: two(p, s), confidence: parsed.confidence };
};

// ---- the entry itself
export const create = ({ db, projects, settingsOf = () => ({}), memoryOf = () => ({ lines: [] }), ask, forward, say = () => {}, notify = () => {}, pilotOn = () => true, now = () => new Date(), repos = reposOf }) => {
  schema(db);
  const list = () => (projects() || []).filter((p) => p && p.path).map((p) => factsOf(p, { settingsOf, repos }));
  const nameFor = (dir) => { const p = (projects() || []).find((x) => x.path === dir); return p ? nameOf(p) : nameOf({ path: dir }); };
  const iso = () => now().toISOString();
  const row = (seq) => db.prepare('select * from entry_messages where seq = ?').get(Number(seq));
  const dataOf = (r) => { try { return JSON.parse(r.data || '{}') || {}; } catch { return {}; } };
  const update = (seq, f) => {
    const cur = row(seq); const data = { ...dataOf(cur), ...(f.data || {}) };
    db.prepare('update entry_messages set project = ?, main_seq = ?, how = ?, status = ?, data = ? where seq = ?')
      .run(f.project !== undefined ? f.project : cur.project, f.main_seq !== undefined ? f.main_seq : cur.main_seq, f.how || cur.how, f.status || cur.status, JSON.stringify(data), Number(seq));
  };
  const send = (seq, project, how) => {
    const r = row(seq); const m = forward(project, r.text);
    update(seq, { project, main_seq: m ? m.seq : null, how, status: 'sent', data: { choices: undefined } });
  };
  const lastSent = () => db.prepare("select project, at from entry_messages where status = 'sent' and project is not null order by seq desc limit 1").get() || null;
  const corrections = () => db.prepare('select text, from_project, to_project from entry_corrections order by seq desc limit ?').all(EXAMPLES)
    .map((c) => ({ text: c.text, from: c.from_project ? nameFor(c.from_project) : null, to: nameFor(c.to_project) }));

  const post = async (text) => {
    const t = String(text ?? '').trim();
    if (!t) throw Object.assign(new Error('texte vide'), { status: 400 });
    if (t.length > MAX_TEXT) throw Object.assign(new Error(`texte de plus de ${MAX_TEXT} caractères`), { status: 400 });
    const all = list(); const last = lastSent();
    const seq = Number(db.prepare("insert into entry_messages (text, status, data, at) values (?, 'routing', '{}', ?)").run(t, iso()).lastInsertRowid);
    notify();
    const local = routeLocal({ text: t, projects: all, last, now: now().getTime() });
    if (local && local.project) { send(seq, local.project, local.how); notify(); return view(row(seq)); }
    if (!all.length) { update(seq, { status: 'general', how: 'general' }); notify(); return view(row(seq)); }
    const byName = (n) => all.find((p) => p.name === n)?.path || null;
    const recent = [last?.project, ...all.map((p) => p.path)].filter(Boolean);
    let decision;
    try {
      const facts = all.map((p) => ({ name: p.name, summary: summaryOf(p.path), memory: (memoryOf(p.path)?.lines || []).map((l) => (typeof l === 'string' ? l : l.text)).filter((l) => l && l.trim()).slice(-MEMORY_LINES) }));
      const { text: out } = await ask({ model: MODEL, systemPrompt: systemPrompt(), budget: BUDGET, prompt: modelPrompt({ text: t, projects: facts, corrections: corrections(), candidates: (local?.candidates || []).map(nameFor) }), timeoutMs: 60000 });
      decision = decide(parseModel(out, all.map((p) => p.name)), { byName, fallback: [...(local?.candidates || []), ...recent] });
    } catch { decision = decide(null, { byName, fallback: [...(local?.candidates || []), ...recent] }); }
    if (decision.status === 'sent') send(seq, decision.project, decision.how);
    else if (decision.status === 'general') update(seq, { status: 'general', how: 'general', data: { answer: decision.answer || '' } });
    else update(seq, { status: 'ask', how: decision.how, data: { choices: decision.choices, confidence: decision.confidence ?? null } });
    notify();
    return view(row(seq));
  };

  // The click of the question, or « pas ce projet »: the request leaves for the chosen project; a correction becomes an example
  const choose = (seq, project) => {
    const r = row(seq); if (!r) throw Object.assign(new Error('demande inconnue'), { status: 404 });
    if (!list().some((p) => p.path === project)) throw Object.assign(new Error('projet inconnu'), { status: 400 });
    if (r.status === 'ask') { send(seq, project, 'asked'); notify(); return view(row(seq)); }
    if (r.project === project) return view(r);
    if (r.status === 'sent' || r.status === 'general') {
      db.prepare('insert into entry_corrections (text, from_project, to_project, at) values (?, ?, ?, ?)').run(r.text, r.project, project, iso());
      if (r.project) say(r.project, `Demande déplacée vers ${nameFor(project)} depuis l'entrée : « ${r.text.slice(0, 120)} »`);
      send(seq, project, 'corrected'); notify(); return view(row(seq));
    }
    throw Object.assign(new Error('demande encore en cours de routage'), { status: 409 });
  };

  // The answers are read in the project's main conversation: what follows the forwarded message until the next developer message
  const repliesOf = (r) => {
    if (!r.project || !r.main_seq) return [];
    const next = db.prepare("select min(seq) as s from main_messages where project = ? and seq > ? and role = 'dev'").get(r.project, r.main_seq)?.s;
    return db.prepare(`select seq, role, text, source, at from main_messages where project = ? and seq > ? ${next ? 'and seq < ?' : ''} and role in ('claude', 'system') order by seq limit 6`)
      .all(...[r.project, r.main_seq, ...(next ? [next] : [])]);
  };
  const view = (r) => {
    const d = dataOf(r); const replies = repliesOf(r);
    return { seq: r.seq, text: r.text, project: r.project, name: r.project ? nameFor(r.project) : null, how: r.how, status: r.status, at: r.at,
      choices: r.status === 'ask' ? (d.choices || []).map((p) => ({ project: p, name: nameFor(p) })) : [],
      answer: d.answer || '', replies, waiting: r.status === 'sent' && !replies.some((m) => m.role === 'claude'),
      pilotOff: r.status === 'sent' && r.project ? !pilotOn(r.project) : false };
  };
  const messages = ({ before, limit } = {}) => {
    const n = Math.max(1, Math.min(100, Number(limit) || 30));
    const rows = db.prepare(`select * from entry_messages ${before ? 'where seq < ?' : ''} order by seq desc limit ?`).all(...(before ? [Number(before), n + 1] : [n + 1]));
    return { messages: rows.slice(0, n).map(view), more: rows.length > n, projects: list().map((p) => ({ project: p.path, name: p.name })) };
  };

  const route = async (req, res, url) => {
    const out = (code, body) => { res.writeHead(code, { 'content-type': 'application/json; charset=utf-8' }); res.end(JSON.stringify(body)); };
    try {
      const sub = url.pathname.replace(/^\/api\/entry\/?/, '');
      if (!sub && req.method === 'GET') return out(200, messages({ before: url.searchParams.get('before'), limit: url.searchParams.get('limit') }));
      if (!sub && req.method === 'POST') { const b = await readJson(req); return out(200, { ok: true, message: await post(b.text) }); }
      if (sub === 'choose' && req.method === 'POST') { const b = await readJson(req); return out(200, { ok: true, message: choose(b.seq, b.project) }); }
      return out(404, { error: 'not found' });
    } catch (e) { return out(e.status || 500, { error: e.message }); }
  };
  return { post, choose, messages, route, view: (seq) => view(row(seq)) };
};

const readJson = (req) => new Promise((resolve, reject) => {
  let s = ''; req.setEncoding('utf8');
  req.on('data', (c) => { s += c; if (s.length > 1e6) { reject(Object.assign(new Error('trop gros'), { status: 413 })); req.destroy(); } });
  req.on('end', () => { try { resolve(s ? JSON.parse(s) : {}); } catch { reject(Object.assign(new Error('JSON illisible'), { status: 400 })); } });
  req.on('error', reject);
});
