// The Linear sync (docs/connectors.md, « La synchro », Dev's decision of 2026-11-02): when a project has a Linear key
// and its setting linearSync is not off, Escadrille updates by itself the tickets a session names (identifiers such as
// ORC-88 in its name, its prompt, its summary or its tickets list). GitHub does not change: a push, a PR, a merge on
// GitHub still leave on the developer's click only.
//
//   a session launched         → the ticket moves to the team's « started » state, from backlog or unstarted only
//   a session merged or in kit → one comment « État au <date> (Escadrille) : … », once per session and per ticket
//   its PR merged in production → one comment « Fusionné en production par la PR <url> », once per PR
//   never Done: Done means delivered and checked in production, the developer's word. Never a title, a description,
//   a priority, an assignee nor a label. A Linear error stops nothing: one line in the pilot's log, one discreet
//   alert in « À toi » a day at most. The key never leaves lib/linear.mjs: never returned, never logged.
//
//   init({ db, keyOf, settingsOf, log, now })      the server's context; creates the table linear_sync
//   onLaunched({ project, plan, session, row })      onDelivered({ …, how: 'merged' | 'kit' })      onPrMerged({ … })
//   ticketsOf(session, row)                        the identifiers named, in order, without a double
//   alertOf(db, project)                           { at, text } of the day's alert, else null (the Flot carries it)
//   applySetting(st, value)                        the setting linearSync in the stored settings (true, false, null)
//   publicView(st, hasKey)                         { sync } for GET /api/project/settings
import * as linear from './linear.mjs';

export const SETTING = 'linearSync';
export const KINDS = ['started', 'delivered', 'production', 'missing', 'alert'];
// The branches a merged PR counts as production (its kept base, docs/connectors.md)
export const PRODUCTION_BRANCHES = ['main', 'master', 'production', 'prod'];
// In free text, a ticket is two to five capital letters, a dash, a number without a leading zero (ORC-88), not glued to a
// word, a path or a longer code (R02-R07, claude-sonnet-5-5); word-like prefixes that never are tickets are skipped
// (UTF-8, SHA-256, ISO-8601, RFC-2119, HTTP-2…). A declared tickets list goes through linear.IDENTIFIER as before.
const NOT_TICKETS = new Set(['UTF', 'SHA', 'ISO', 'RFC', 'MD', 'HTTP', 'HTTPS', 'TLS', 'SSL', 'IPV', 'COVID', 'ECMA', 'IEEE', 'ES', 'WCAG', 'CVE', 'GPT', 'AES', 'RSA', 'HMAC', 'UTC', 'GMT', 'USB', 'PCI', 'CSS', 'HTML', 'LTS', 'UUID', 'OAUTH', 'PR', 'ID', 'IP', 'AM', 'PM']);
const TICKET = /(?<![\w/.-])([A-Z]{2,5})-([1-9]\d{0,5})(?![\w-])/g;
export const ALERT_EVERY_MS = 24 * 3600e3;

export const schema = (db) => db.exec(`
  create table if not exists linear_sync (project text not null, plan text not null, session text not null, identifier text not null, kind text not null, ref text not null default '', result text, at text not null,
    primary key (plan, session, identifier, kind, ref));
  create index if not exists linear_sync_project on linear_sync (project, kind, at);
`);

let ctx = null;
export const init = (c) => {
  ctx = { now: () => new Date(), log: () => {}, settingsOf: () => ({}), ...c };
  schema(ctx.db);
  return ctx;
};

// The identifiers a session names: its tickets list first, then its name, its prompt, its summary
export const ticketsOf = (session, row) => {
  session = session || {}; row = row || {}; const out = [];
  const add = (id) => { if (id && linear.IDENTIFIER.test(id) && !out.includes(id)) out.push(id); };
  for (const t of Array.isArray(session.tickets) ? session.tickets : []) add(String(t || '').trim());
  for (const text of [session.name, session.prompt, row.summary, row.name]) for (const m of String(text || '').matchAll(TICKET)) if (!NOT_TICKETS.has(m[1])) add(`${m[1]}-${m[2]}`);
  return out;
};

export const isOn = ({ project }) => !!(project && ctx && ctx.keyOf(project) && ctx.settingsOf(project)?.[SETTING] !== false);

export const applySetting = (st, value) => {
  if (value === null || value === true) delete st[SETTING];
  else if (value === false) st[SETTING] = false;
  else throw new Error(`${SETTING} : true ou false`);
  return st;
};
export const publicView = (st, hasKey) => ({ sync: !!hasKey && st?.[SETTING] !== false });

export const isProductionBase = (base) => PRODUCTION_BRANCHES.includes(String(base || '').trim().toLowerCase());

// ---------------------------------------------------------------- the memory of what was done (idempotence)
const doneRow = (plan, session, identifier, kind, ref = '') => ctx.db.prepare('select result, at from linear_sync where plan = ? and session = ? and identifier = ? and kind = ? and ref = ?').get(plan, session, identifier, kind, ref) || null;
const keep = ({ project, plan, session, identifier, kind, ref = '', result = null }) => ctx.db.prepare('insert or replace into linear_sync (project, plan, session, identifier, kind, ref, result, at) values (?, ?, ?, ?, ?, ?, ?, ?)').run(project, plan, session, identifier, kind, ref, result, ctx.now().toISOString());

// A Linear error: one line in the pilot's log, one alert a day per project at most; never thrown
const failed = ({ project, plan, session, identifier, what }, e) => {
  const text = `Linear : ${identifier} non mis à jour (${what})\n${e.message}`;
  try { ctx.log({ project, planId: plan, sessionId: session, kind: 'note', text }); } catch {}
  if (/introuvable|not found/i.test(e.message)) keep({ project, plan, session, identifier, kind: 'missing', result: e.message }); // never asked again
  const last = alertOf(ctx.db, project);
  if (!last) keep({ project, plan: '', session: '', identifier: '', kind: 'alert', ref: ctx.now().toISOString().slice(0, 10), result: `${identifier} : ${e.message}` });
};
// The alert of the last 24 h, for the Flot and « À toi »; null without one (or before init: no table)
export const alertOf = (db, project, now = ctx?.now?.() || new Date()) => {
  try {
    const r = db.prepare("select result, at from linear_sync where project = ? and kind = 'alert' order by at desc limit 1").get(project);
    return r && now - new Date(r.at) < ALERT_EVERY_MS ? { at: r.at, text: r.result } : null;
  } catch { return null; }
};

const money = (x) => `${(Number(x) || 0).toFixed(2).replace('.', ',')} $`;
const dateFr = (d) => new Intl.DateTimeFormat('fr-FR', { day: 'numeric', month: 'long', year: 'numeric' }).format(d);
// « Fait : … / Reste : … » of the session's state block, each on one line
const summaryParts = (summary) => {
  const lines = String(summary || '').split('\n').map((l) => l.trim()).filter(Boolean);
  const pick = (re) => lines.filter((l) => re.test(l)).map((l) => l.replace(re, '').trim()).join(' ');
  const done = pick(/^fait\s*:/i); const left = pick(/^reste\s*:/i);
  return { done: done || lines.join(' ') || 'pas de résumé', left: left || 'rien de noté' };
};
export const deliveredBody = ({ plan, session, row, how, at }) => {
  const { done, left } = summaryParts(row?.summary);
  const where = how === 'kit' ? 'livrée en kit' : 'fusionnée dans la base du plan';
  return `État au ${dateFr(at)} (calmdev) : ${done} Reste : ${left} Coût ≈ ${money(row?.usage?.cost)}.\n\nSession ${session.id} du plan ${plan.id}, ${where}.`;
};
export const productionBody = ({ pr }) => `Fusionné en production par la PR ${pr.url} (calmdev).`;

// One pass over the session's tickets: skip what was already tried, do the rest, never throw. Each (session, ticket,
// event) reaches Linear once at most: a failure is kept too (« échec : … »), so the log gets one line, not one a turn
const each = async ({ project, plan, session, row, kind, ref = '', what }, fn) => {
  if (!ctx || !isOn({ project })) return { on: false, tickets: [] };
  const key = ctx.keyOf(project); const out = [];
  for (const identifier of ticketsOf(session, row)) {
    const args = { project, plan: plan.id, session: session.id, identifier };
    if (doneRow(plan.id, session.id, identifier, kind, ref) || doneRow(plan.id, session.id, identifier, 'missing')) continue;
    try { const result = await fn({ key, identifier }); keep({ ...args, kind, ref, result }); out.push({ identifier, result }); } catch (e) { keep({ ...args, kind, ref, result: 'échec : ' + e.message }); failed({ ...args, what }, e); out.push({ identifier, error: e.message }); }
  }
  return { on: true, tickets: out };
};

// A session launched: the ticket moves to « started » when it was in backlog or unstarted; otherwise its state is kept
export const onLaunched = (a) => each({ ...a, kind: 'started', what: 'lancement' }, async ({ key, identifier }) => {
  const r = await linear.moveToStarted({ key, identifier });
  return r.moved ? r.state : `gardé : ${r.state}`;
});
// A session merged into the plan's base, or delivered in a kit: one comment of state and cost, once per session and ticket
export const onDelivered = (a) => each({ ...a, kind: 'delivered', what: a.how === 'kit' ? 'kit' : 'fusion' }, async ({ key, identifier }) => {
  const c = await linear.comment({ key, identifier, body: deliveredBody({ ...a, at: ctx.now() }) });
  return c.id;
});
// The session's kept PR seen merged on a production branch: one comment per PR
export const onPrMerged = (a) => {
  const pr = a.row?.pr; if (!pr?.url || !pr.merged || !isProductionBase(pr.base)) return Promise.resolve({ on: false, tickets: [] });
  return each({ ...a, kind: 'production', ref: pr.url, what: 'production' }, async ({ key, identifier }) => (await linear.comment({ key, identifier, body: productionBody({ pr }) })).id);
};
