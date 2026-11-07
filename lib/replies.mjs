// The replies to the launch posts (docs/replies.md). Dev answers, one at a time, the comments left on his launch posts:
// the oldest first, and the queue never moves on while the current comment has no published reply. « Plus tard » puts it
// back in the queue as if it had just arrived; nothing leaves the queue without a reply. Nothing here reaches the network:
// a source (lib/replies.mjs `source.poll()`, written per platform by ESS) brings the comments in, the paste step (ENV) takes
// the reply out, and Dev publishes it himself.
//
//   const store = createStore(db)            // the table, on the server's node:sqlite database
//   await pollSources(store, [fakeSource()]) // comments in, by a stable id (platform:externalId), never twice
//   store.current()                          // the comment Dev works on now, or null
//   store.send(id) → { paste }               // « Envoyer »: ready, handed to the paste step
//   store.pasted(id), store.published(id)    // the paste step, then Dev (or the source seeing his reply)
//   store.later(id)                          // « Plus tard »: back in the queue, behind what is already waiting
//   store.waiting()                          // « N personnes attendent ta réponse »

import { readFileSync, existsSync } from 'node:fs';
import path from 'node:path';
import { projectDir } from './names.mjs';

export const STATES = ['waiting', 'ready', 'pasted', 'published', 'later'];
// In French on the screen: en attente, prêt, collé, publié, plus tard
export const PLATFORMS = ['linkedin', 'hackernews', 'reddit', 'x', 'producthunt', 'github'];
export const DRAFT_MODEL = 'claude-sonnet-5-5';
export const DRAFT_BUDGET = 0.10; // dollars per draft: one short turn, no tool
export const DRAFT_MAX_CHARS = 14000; // the prompt: comment, post, tone, facts, never more

const now = () => new Date().toISOString();
const MOVING = new Set(['ready', 'pasted']); // handed to the paste step: the queue is held on it

// ---- the language: the script first, then the commonest short words of six languages. Never a network call.
const WORDS = {
  fr: ['le', 'la', 'les', 'des', 'est', 'et', 'je', 'tu', 'vous', 'pas', 'une', 'pour', 'que', 'qui', 'dans', 'avec', 'sur', 'ce', 'c\'est', 'merci', 'très', 'mais', 'du', 'au', 'ça', 'j\'ai', 'bravo', 'super', 'comment', 'aussi'],
  en: ['the', 'and', 'is', 'it', 'you', 'to', 'of', 'this', 'that', 'for', 'with', 'what', 'how', 'does', 'are', 'i', 'my', 'on', 'in', 'not', 'can', 'have', 'great', 'thanks', 'why', 'would', 'just', 'your', 'be', 'was'],
  es: ['el', 'los', 'las', 'que', 'es', 'y', 'de', 'para', 'con', 'una', 'por', 'pero', 'muy', 'esto', 'como', 'gracias', 'qué', 'cómo', 'tu', 'del'],
  de: ['der', 'die', 'das', 'und', 'ist', 'nicht', 'ich', 'du', 'mit', 'für', 'ein', 'eine', 'wie', 'auch', 'aber', 'danke', 'sehr', 'was', 'zu', 'auf'],
  it: ['il', 'che', 'è', 'di', 'per', 'con', 'una', 'non', 'sono', 'come', 'grazie', 'molto', 'anche', 'questo', 'gli', 'della', 'ma', 'ciao'],
  pt: ['o', 'os', 'que', 'é', 'de', 'para', 'com', 'uma', 'não', 'muito', 'obrigado', 'como', 'isso', 'mas', 'você', 'do', 'da', 'em'],
};
export const detectLang = (text, fallback = 'en') => {
  const s = String(text || '');
  if (/[぀-ヿ]/.test(s)) return 'ja';
  if (/[一-鿿]/.test(s)) return 'zh';
  if (/[가-힯]/.test(s)) return 'ko';
  if (/[Ѐ-ӿ]/.test(s)) return 'ru';
  const tokens = s.toLowerCase().replace(/[’]/g, '\'').match(/[\p{L}']+/gu) || [];
  if (!tokens.length) return fallback;
  const score = {};
  for (const [lg, list] of Object.entries(WORDS)) { const set = new Set(list); score[lg] = tokens.reduce((n, t) => n + (set.has(t) ? 1 : 0), 0); }
  // French accents and apostrophes tip a tie toward French; ñ and ¿ toward Spanish; ß and umlauts toward German
  if (/[éèêàùçœ]/.test(s)) score.fr += 1.5;
  if (/[ñ¿¡]/.test(s)) score.es += 2;
  if (/[ßäöü]/.test(s)) score.de += 2;
  if (/[ãõ]/.test(s)) score.pt += 2;
  const best = Object.entries(score).sort((a, b) => b[1] - a[1]);
  return best[0][1] > 0 && best[0][1] > best[1][1] ? best[0][0] : fallback;
};

// ---- the queue rule, pure: what Dev sees now and what follows. One comment at a time.
// A comment handed to the paste step holds the queue until it is published. Otherwise, the smallest rank first: a
// comment's rank is the time it was written; « Plus tard » gives it the time of the click, so it queues as if it had just
// arrived, behind every comment already waiting and before the ones written after.
export const order = (items) => items.filter((r) => r.state !== 'published').sort((a, b) => (String(a.rank) < String(b.rank) ? -1 : String(a.rank) > String(b.rank) ? 1 : String(a.id) < String(b.id) ? -1 : 1));
export const currentOf = (items) => {
  const held = order(items).find((r) => MOVING.has(r.state));
  return held || order(items)[0] || null;
};
// « N personnes attendent ta réponse »: people, not comments (two comments of one person are one person waiting)
export const waitingOf = (items) => {
  const open = items.filter((r) => r.state !== 'published');
  return { people: new Set(open.map((r) => `${r.platform}:${String(r.author || '').toLowerCase()}`)).size, comments: open.length, later: open.filter((r) => r.state === 'later').length };
};

// ---- the store, on the server's database
const ROW = (r) => r && ({
  id: r.id, platform: r.platform, externalId: r.external_id, thread: r.thread, url: r.url, post: r.post, author: r.author,
  lang: r.lang, text: r.text, at: r.at, rank: r.rank, draft: r.draft || '', points: r.points ? JSON.parse(r.points) : null,
  draftBy: r.draft_by || null, state: r.state, sentAt: r.sent_at, pastedAt: r.pasted_at, publishedAt: r.published_at, laterCount: r.later_count || 0,
});
export const createStore = (db) => {
  db.exec(`create table if not exists replies (id text primary key, platform text not null, external_id text not null, thread text,
    url text, post text, author text, lang text, text text not null, at text not null, rank text not null, draft text, points text,
    draft_by text, state text not null default 'waiting', sent_at text, pasted_at text, published_at text, later_count integer default 0,
    created text not null)`);
  const all = () => db.prepare('select * from replies').all().map(ROW);
  const get = (id) => ROW(db.prepare('select * from replies where id = ?').get(String(id)));
  const set = (id, fields) => {
    const keys = Object.keys(fields); if (!keys.length) return get(id);
    db.prepare(`update replies set ${keys.map((k) => `${k} = ?`).join(', ')} where id = ?`).run(...keys.map((k) => fields[k]), String(id));
    return get(id);
  };
  const must = (id) => { const r = get(id); if (!r) throw Object.assign(new Error('commentaire inconnu'), { status: 404 }); return r; };
  const mustBeCurrent = (r) => { const c = currentOf(all()); if (!c || c.id !== r.id) throw Object.assign(new Error('un commentaire à la fois : réponds d\'abord au commentaire en cours'), { status: 409 }); };

  // A comment from a source: the stable id makes a second poll a no-op; the state and the draft are never overwritten
  const ingest = (platform, c) => {
    if (!PLATFORMS.includes(platform)) throw new Error(`plateforme inconnue : ${platform}`);
    if (!c || !c.externalId || !String(c.text || '').trim()) return null;
    const id = `${platform}:${c.externalId}`;
    if (get(id)) return null;
    const at = c.at ? new Date(c.at).toISOString() : now();
    db.prepare(`insert into replies (id, platform, external_id, thread, url, post, author, lang, text, at, rank, state, created)
      values (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'waiting', ?)`).run(id, platform, String(c.externalId), c.thread || null, c.url || null,
      c.post || null, String(c.author || '').slice(0, 120) || '—', c.lang || detectLang(c.text), String(c.text), at, at, now());
    return get(id);
  };

  return {
    all, get, ingest,
    list: () => order(all()),
    current: () => currentOf(all()),
    waiting: () => waitingOf(all()),
    // « Modifier »: the text Dev will paste; a waiting or later comment stays where it is in the queue
    edit: (id, draft) => { const r = must(id); if (r.state === 'published') throw Object.assign(new Error('déjà publié'), { status: 409 }); return set(id, { draft: String(draft ?? '').slice(0, 10000), draft_by: 'gab' }); },
    setDraft: (id, { draft = '', points = null, by = DRAFT_MODEL } = {}) => { const r = must(id); if (r.draftBy === 'gab') return r; return set(id, { draft: String(draft).slice(0, 10000), points: points ? JSON.stringify(points) : null, draft_by: by }); },
    // « Envoyer »: only the current comment, only with a reply; handed to the paste step (ENV)
    send: (id) => {
      const r = must(id); mustBeCurrent(r);
      if (r.state === 'published') throw Object.assign(new Error('déjà publié'), { status: 409 });
      if (!String(r.draft || '').trim()) throw Object.assign(new Error('rien à envoyer : écris la réponse'), { status: 400 });
      const row = set(id, { state: 'ready', sent_at: now() });
      return { item: row, paste: pasteOf(row) };
    },
    pasted: (id) => { const r = must(id); if (!MOVING.has(r.state)) throw Object.assign(new Error('pas encore envoyé'), { status: 409 }); return set(id, { state: 'pasted', pasted_at: now() }); },
    // Published: by Dev after he posted, or by a source that sees his reply in the thread (any comment, the queue then moves on)
    published: (id, { by = 'gab' } = {}) => {
      const r = must(id); if (r.state === 'published') return r;
      if (by === 'gab' && !MOVING.has(r.state)) throw Object.assign(new Error('envoie d\'abord la réponse'), { status: 409 });
      return set(id, { state: 'published', published_at: now() });
    },
    // « Plus tard »: back in the queue at the time of the click; the draft is kept
    later: (id) => { const r = must(id); if (r.state === 'published') throw Object.assign(new Error('déjà publié'), { status: 409 }); // behind every comment already waiting, even one stamped ahead of this clock
      const last = order(all()).reduce((m, x) => (String(x.rank) > m ? String(x.rank) : m), '');
      const rank = last && last >= now() ? new Date(Date.parse(last) + 1).toISOString() : now();
      return set(id, { state: 'later', rank, later_count: (r.laterCount || 0) + 1 }); },
  };
};

// What the paste step receives: the text to paste and where (the comment's own link, else its thread)
export const pasteOf = (r) => ({ id: r.id, platform: r.platform, url: r.url || r.thread || null, text: r.draft, author: r.author });

// ---- sources: `{ platform, poll() → { comments: [{ externalId, thread, url, post, author, text, at, lang? }], replied?: [externalId] } }`
// `replied` lists the comments the source sees an answer of Dev under: they are published, whatever their state.
export const pollSources = async (store, sources) => {
  const out = { added: [], published: [], errors: [] };
  for (const s of sources) {
    let got;
    try { got = await s.poll(); } catch (e) { out.errors.push({ platform: s.platform, error: e.message }); continue; }
    for (const c of (got && got.comments) || []) { const r = store.ingest(s.platform, c); if (r) out.added.push(r.id); }
    for (const ext of (got && got.replied) || []) { const id = `${s.platform}:${ext}`; const r = store.get(id); if (r && r.state !== 'published') { store.published(id, { by: 'source' }); out.published.push(id); } }
  }
  return out;
};

// The fake source: a fixed list given out in steps (one batch per poll), for the tests and the demo
export const fakeSource = (platform, batches = []) => {
  let i = 0;
  return { platform, fake: true, poll: async () => (i < batches.length ? batches[i++] : { comments: [] }) };
};

// ---- the draft: a light Sonnet turn, no tool, no file read; the server runs it (runSmall) with this system prompt
export const draftSystemPrompt = () => `Tu écris le brouillon d'une réponse du développeur à un commentaire sur un post de lancement de calmdev.
Tu n'utilises aucun outil et tu ne lis aucun fichier : tout ce que tu sais est dans le message.
Règles :
- Réponds dans la langue du commentaire (champ « langue »), au tutoiement ou au vouvoiement du commentaire.
- Le ton de Dev (section « Le ton ») : direct, concret, chiffres réels, ce qui a cassé avant ce qui a marché, pas de superlatif, pas de promesse.
- Court : deux à quatre phrases, sans formule de politesse creuse, sans émoji, sans hashtag.
- Ne promets rien qui n'existe pas : n'affirme que ce qui est dans « Les faits ». Une demande de fonction absente : dis qu'elle n'existe pas encore, sans date.
- Une question à laquelle les faits ne répondent pas : dis-le simplement et propose d'en parler, n'invente pas.
- Aucun nom de client, aucun chemin privé, aucun lien autre que le dépôt https://github.com/Gabfranck/calmdev-private.
Réponds par un seul bloc, rien d'autre :
\`\`\`escadrille:reply
{"lang":"<code>","text":"<la réponse>"}
\`\`\`
Pour Hacker News seulement, pas de texte : trois points à couvrir, Dev écrit lui-même :
\`\`\`escadrille:reply
{"lang":"en","points":["…","…","…"]}
\`\`\``;

const cut = (s, n) => { s = String(s || ''); return s.length > n ? s.slice(0, n) + '\n[…]' : s; };
export const draftPrompt = ({ item, post = '', tone = '', facts = '' }) => cut([
  `## Le commentaire (${item.platform}${item.platform === 'hackernews' ? ', trois points seulement' : ''})`,
  `auteur : ${item.author}`, `langue : ${item.lang}`, '', String(item.text),
  '', '## Le post d\'origine', cut(post, 3000) || '(inconnu)',
  '', '## Le ton', cut(tone, 3000) || '(direct, concret, court)',
  '', '## Les faits', cut(facts, 6000) || '(aucun : ne promets rien)',
].join('\n'), DRAFT_MAX_CHARS);

export const parseDraft = (text, platform) => {
  const m = String(text || '').match(/```escadrille:reply\s*\n([\s\S]*?)```/);
  if (!m) return { ok: false, error: 'pas de bloc escadrille:reply' };
  let v; try { v = JSON.parse(m[1]); } catch { return { ok: false, error: 'bloc illisible' }; }
  if (platform === 'hackernews') {
    const pts = Array.isArray(v.points) ? v.points.map((p) => String(p).trim()).filter(Boolean).slice(0, 3) : [];
    if (pts.length !== 3) return { ok: false, error: 'trois points attendus' };
    return { ok: true, draft: '', points: pts, lang: v.lang || null };
  }
  const t = String(v.text || '').trim();
  if (!t) return { ok: false, error: 'réponse vide' };
  return { ok: true, draft: t.slice(0, 3000), points: null, lang: v.lang || null };
};

// The launch post a comment answers, read in comm/ (the « Post » or « Text » field), keyed like `linkedin.fr`, `hackernews`
export const postOf = (root, key) => {
  if (!key || !/^[a-z]+(\.[a-z]{2})?$/.test(key)) return '';
  const f = path.join(root, 'comm', `${key}.md`); if (!existsSync(f)) return '';
  const md = readFileSync(f, 'utf8');
  const m = md.match(/^## (?:Post|Text|Texte)\s*\n([\s\S]*?)(?=^## |$(?![\s\S]))/m);
  return (m ? m[1] : md).trim();
};
// The checked facts: README and the figures of comm/chiffres.md, the only sources a reply may quote
export const factsOf = (root) => ['README.md', 'comm/chiffres.md'].map((f) => { const p = path.join(root, f); return existsSync(p) ? `### ${f}\n${readFileSync(p, 'utf8')}` : ''; }).filter(Boolean).join('\n\n');
// Dev's tone: .escadrille/ton-gab.md of the project, never committed
export const toneOf = (root) => { const p = projectDir(root, 'ton-gab.md'); return existsSync(p) ? readFileSync(p, 'utf8') : ''; };

// One draft: runSmall is the server's one-turn runner (`{ cwd, model, systemPrompt, budget, prompt } → { text, cost }`)
export const makeDraft = async (store, id, { root, runSmall }) => {
  const item = store.get(id); if (!item) throw Object.assign(new Error('commentaire inconnu'), { status: 404 });
  const prompt = draftPrompt({ item, post: postOf(root, item.post), tone: toneOf(root), facts: factsOf(root) });
  const { text, cost } = await runSmall({ cwd: root, model: DRAFT_MODEL, systemPrompt: draftSystemPrompt(), budget: DRAFT_BUDGET, prompt, timeoutMs: 90000 });
  const r = parseDraft(text, item.platform);
  if (!r.ok) return { ok: false, error: r.error, cost };
  return { ok: true, item: store.setDraft(id, { draft: r.draft, points: r.points }), cost };
};

// One tick of the server: poll the sources, then draft each new comment, one at a time (a few cents each, never in parallel)
export const tick = async (store, sources, { root, runSmall } = {}) => {
  const out = await pollSources(store, sources); out.drafted = []; out.draftErrors = [];
  if (runSmall) for (const id of out.added) {
    try { const r = await makeDraft(store, id, { root, runSmall }); (r.ok ? out.drafted : out.draftErrors).push(r.ok ? id : { id, error: r.error }); } catch (e) { out.draftErrors.push({ id, error: e.message }); }
  }
  return out;
};

// ---- the routes, for server.mjs (protected: the wiring is written in docs/replies.md for Dev). Returns true when handled.
// The Mac only: like every route that is not the phone's, the guard answers 403 from the LAN before this is reached.
const json = (res, code, body) => { res.writeHead(code, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' }); res.end(JSON.stringify(body)); };
const readBody = (req) => new Promise((ok) => { let s = ''; req.on('data', (d) => { s += d; if (s.length > 64000) req.destroy(); }); req.on('end', () => { try { ok(s ? JSON.parse(s) : {}); } catch { ok({}); } }); });
export const view = (store, root) => {
  const list = store.list(); const cur = currentOf(list);
  return { current: cur && root ? { ...cur, postText: postOf(root, cur.post) } : cur, next: list.filter((r) => !cur || r.id !== cur.id).slice(0, 20).map((r) => ({ id: r.id, platform: r.platform, author: r.author, lang: r.lang, at: r.at, state: r.state })), waiting: waitingOf(store.all()) };
};
export const handle = async (req, res, url, { store, root, runSmall, onSend } = {}) => {
  const p = url.pathname;
  if (!p.startsWith('/api/replies')) return false;
  try {
    if (req.method === 'GET' && p === '/api/replies') { json(res, 200, view(store, root)); return true; }
    // The counter for the bar: « N personnes attendent ta réponse »
    if (req.method === 'GET' && p === '/api/replies/count') { json(res, 200, store.waiting()); return true; }
    const m = p.match(/^\/api\/replies\/([^/]+)\/(edit|send|pasted|published|later|draft)$/);
    if (!m || req.method !== 'POST') { json(res, 404, { error: 'route inconnue' }); return true; }
    const id = decodeURIComponent(m[1]); const body = await readBody(req);
    if (m[2] === 'edit') { store.edit(id, body.draft); json(res, 200, view(store, root)); return true; }
    if (m[2] === 'send') { const out = store.send(id); if (onSend) onSend(out.paste); json(res, 200, { ...view(store, root), paste: out.paste }); return true; }
    if (m[2] === 'pasted') { store.pasted(id); json(res, 200, view(store, root)); return true; }
    if (m[2] === 'published') { store.published(id); json(res, 200, view(store, root)); return true; }
    if (m[2] === 'later') { store.later(id); json(res, 200, view(store, root)); return true; }
    if (m[2] === 'draft') {
      if (!runSmall) { json(res, 503, { error: 'brouillon indisponible' }); return true; }
      const r = await makeDraft(store, id, { root, runSmall }); json(res, r.ok ? 200 : 502, r.ok ? view(store, root) : { error: r.error }); return true;
    }
  } catch (e) { json(res, e.status || 500, { error: e.message }); return true; }
  return false;
};
