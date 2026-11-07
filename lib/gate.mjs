// The gate of the server (docs/gate.md, phase 12, session SEC): one predicate on method and path, before the routes.
// A session reaches the server on 127.0.0.1 from its sandbox (it needs POST /api/memory), so « local » never means
// « the developer clicked ». Every route that acts (launch, answer, stop, merge, settings, thresholds, burst, pilot,
// projects, prompts, review) asks for one of three proofs: the guard cookie of the developer's browser
// (lib/guardrails.mjs), a paired device (docs/phone.md, docs/studio.md), or the pilot's token (below). Nothing else.
//
//   TABLE                                     the routes, their class ('act' | 'read' | 'session' | 'open' | 'device'), what opens them
//   classify(method, pathname)                → the row of TABLE, or the default ({ kind: 'act' } for a write, 'read' for a GET)
//   opened(row, proofs)                       is one of the row's proofs given? ({ cookie, device, pilot } booleans)
//   refusal(row, method, pathname)            → { messageKey, vars?, gate: { route, opens } } for the 403 (the message keys of public/i18n);
//                                             a row's `refuse` names its own message (the push: « from the button in the app, on the Mac »)
//   gateOff(env)                              the gate is open to every local call: ESCADRILLE_GATE=off, or a server under node --test
//                                             (NODE_TEST_CONTEXT inherited) without ESCADRILLE_GATE=on; decided at start, never after
//   pilotToken({ env, dir })                  ESCADRILLE_PILOT_TOKEN, else <dir>/pilot-token read or created (0600); in memory for a test server
//   tokenMatches(given, token)                constant-time comparison
//
// The pilot: a Claude Code conversation on the Mac, in a sandbox that cannot read ~/.config/escadrille. It carries the
// token from the developer's shell (export in ~/.zshrc); the sessions get safeEnv (lib/planner.mjs), which drops every
// *TOKEN* variable. The request bears `x-escadrille-pilot: <token>`.
import { readFileSync, writeFileSync, mkdirSync, chmodSync } from 'node:fs';
import { randomBytes, timingSafeEqual } from 'node:crypto';
import { homedir } from 'node:os';
import path from 'node:path';
import { envVar, configDirIn } from './names.mjs';

export const PILOT_HEADER = 'x-escadrille-pilot';
const ALL = ['cookie', 'device', 'pilot']; // C A P in docs/gate.md
const CP = ['cookie', 'pilot']; // what the Studio keeps to itself (lib/poste.mjs studioOnly): no device
const act = (method, pattern, gesture, opens = ALL) => ({ method, pattern, kind: 'act', gesture, opens });
const read = (pattern) => ({ method: 'GET', pattern, kind: 'read', opens: [] });
const open = (method, pattern) => ({ method, pattern, kind: 'open', opens: [] });
const device = (method, pattern) => ({ method, pattern, kind: 'device', opens: ['device'] });

// `:x` matches one segment; a trailing `/*` matches the rest. First match wins: the specific lines come before the wide ones.
export const TABLE = Object.freeze([
  open('*', '/pair'), open('POST', '/api/pair'),
  device('GET', '/api/phone'), device('POST', '/api/phone/push-token'), device('POST', '/api/phone/forget'),
  act('POST', '/api/pair/code', 'devices', CP), act('POST', '/api/devices/:id/forget', 'devices', CP),
  act('POST', '/api/launch', 'launch'), act('POST', '/api/plan', 'plan'),
  act('POST', '/api/plan/:id/formula', 'plan'), act('POST', '/api/plan/:id/settings', 'settings'), act('POST', '/api/plan/:id/story', 'plan'),
  act('POST', '/api/plan/:id/retire', 'stop'), act('POST', '/api/plan/:id/reopen', 'stop'),
  act('POST', '/api/plan/:id/session/:sid/message', 'answer'), act('POST', '/api/plan/:id/session/:sid/now', 'answer'),
  act('POST', '/api/plan/:id/session/:sid/answer', 'answer'), act('POST', '/api/plan/:id/session/:sid/dismiss', 'answer'),
  act('POST', '/api/plan/:id/session/:sid/budget', 'settings'), act('POST', '/api/plan/:id/session/:sid/merge', 'merge'),
  act('POST', '/api/plan/:id/session/:sid/terminal', 'stop', CP), act('POST', '/api/plan/:id/session/:sid/resume', 'launch'),
  act('POST', '/api/plan/:id/session/:sid/stop', 'stop'), act('POST', '/api/plan/:id/session/:sid/open', 'stop', CP),
  act('POST', '/api/plan/:id/session/:sid/devserver', 'launch', CP),
  act('POST', '/api/plan/:id/session/:sid/reviewed', 'review', ['cookie']), // the browser alone approves a touched guardrail (docs/autonomy.md)
  act('POST', '/api/plan/:id/session/:sid/run-tests', 'merge'), act('POST', '/api/plan/:id/session/:sid/continue-budget', 'settings'),
  // the only git push of the server (lib/github.mjs pushBranch): the developer's click in the app on the Mac, neither a device nor the pilot
  { ...act('POST', '/api/plan/:id/session/:sid/pr', 'push', ['cookie']), refuse: 'srv.gate.push' },
  act('POST', '/api/costing', 'launch'), act('POST', '/api/costing/launch', 'launch'),
  act('POST', '/api/escadrille', 'plan'), act('POST', '/api/escadrille/:id/message', 'plan'), act('POST', '/api/escadrille/:id/install', 'plan'), act('POST', '/api/escadrille/:id/stop', 'plan'),
  act('POST', '/api/running/stop', 'stop'), act('POST', '/api/running/stop-all', 'stop'),
  act('POST', '/api/limits', 'limits'), act('POST', '/api/limits/resume', 'limits'),
  act('POST', '/api/burst', 'burst'), act('POST', '/api/burst/:id/stop', 'burst'), act('POST', '/api/project/backlog', 'burst'), act('POST', '/api/project/backlog/edit', 'burst'), act('POST', '/api/project/backlog/attach', 'plan'),
  act('POST', '/api/project/settings', 'settings'), act('POST', '/api/project/domain', 'settings'),act('POST', '/api/learning/preferences', 'settings'),
  act('POST', '/api/team', 'settings'), act('POST', '/api/team/sync', 'settings'), act('POST', '/api/license', 'settings'), // the Team key (docs/vente/licence.md)
  act('POST', '/api/resources/file', 'resources'), act('DELETE', '/api/resources/file', 'resources'), act('POST', '/api/resources/note', 'resources'),
  act('POST', '/api/resources/skill', 'resources'), act('POST', '/api/resources/plugin', 'resources'),
  act('POST', '/api/projects', 'projects'), act('POST', '/api/projects/remove', 'projects'), act('POST', '/api/projects/name', 'projects'),
  act('POST', '/api/pilot', 'pilot'), act('POST', '/api/pilot/log', 'pilot'), act('POST', '/api/pilot/retry', 'pilot'),
  act('POST', '/api/main', 'main'), act('POST', '/api/main/accept', 'main'), act('POST', '/api/main/now', 'main'), act('POST', '/api/main/import', 'main'),
  act('POST', '/api/review/:id/comment', 'review'), act('POST', '/api/review/:id/comment/:cid/resolve', 'review'),
  act('POST', '/api/review/:id/viewed', 'review'), act('POST', '/api/review/:id/submit', 'review'), act('POST', '/api/review/:id/decide', 'review'),
  act('POST', '/api/note', 'note'),
  act('POST', '/api/qa/start', 'launch', ['cookie', 'device']), // FIAB 7: « Commencer la QA », the developer's click (Mac or phone), never the pilot (lib/nextstep.mjs)
  act('POST', '/api/docker/action', 'stop', ['cookie']), // phase 16 DOCK: restart/stop/build a container; lib/docker.mjs asks the cookie on every /api/docker route
  act('POST', '/api/plan/from-tickets', 'plan'), // phase 16 TIX: a planning from tickets; before the read `* /api/plan/:id`, which would let it through
  act('POST', '/api/demo', 'launch'), act('POST', '/api/demo/remove', 'stop'), // DEMO: a session that serves its public/ over ours, and its removal (docs/demo.md)
  act('POST', '/api/github/pr/:id/merge', 'merge', ['cookie']), // phase 16 GH: the merge of a PR on GitHub, the developer's click only (lib/ghroutes.mjs asks the cookie too)
  // FILE (docs/replies.md): « Envoyer », the paste and « C'est publié » are Dev's clicks only; the rest of the queue as any answer
  act('POST', '/api/replies/:id/send', 'answer', ['cookie']), act('POST', '/api/replies/:id/pasted', 'answer', ['cookie']), act('POST', '/api/replies/:id/published', 'answer', ['cookie']),
  act('POST', '/api/replies/:id/edit', 'answer'), act('POST', '/api/replies/:id/later', 'answer'), act('POST', '/api/replies/:id/draft', 'launch', CP),
  act('POST', '/api/review/thread', 'answer'), // phase 16 PAIR: a message in the end thread (the handler still asks the cookie for dev and GitHub lines)
  // What a session calls on its own: a line at the end of the project's memory (docs/multiproject.md). No session id in the
  // path; a future session route that carries one must say `scoped` (how the session proves it is itself: docs/gate.md §5)
  { method: 'POST', pattern: '/api/memory', kind: 'session', opens: [] },
  // The reads that answer whatever the verb (server.mjs tests no method on them): listed with '*' so that test/gate.test.mjs,
  // which probes every route of server.mjs as a POST, knows them; a POST there changes nothing
  ...['/api/projects', '/api/models', '/api/project', '/api/escadrilles', '/api/templates', '/api/escadrille/:id', '/api/plans', '/api/plan/:id',
    '/api/plan/:id/session/:sid/messages', '/api/usage', '/api/export/:id', '/api/events', '/api/burst/:id'].map((p) => ({ method: '*', pattern: p, kind: 'read', opens: [] })),
  read('/api/*'), read('/guard'), read('/*'),
]);

const toRe = (pattern) => new RegExp('^' + pattern.split('/').map((s) => (s === '*' ? '.*' : s.startsWith(':') ? '[^/]+' : s.replace(/[.+?^${}()|[\]\\]/g, '\\$&'))).join('/') + '$');
const COMPILED = TABLE.map((row) => ({ ...row, re: toRe(row.pattern) }));
export const DEFAULT_WRITE = Object.freeze({ method: '*', pattern: '(unlisted)', kind: 'act', gesture: 'write', opens: ALL });
export const classify = (method, pathname) => {
  const m = String(method || 'GET').toUpperCase(); const p = String(pathname || '/').replace(/\/+$/, '') || '/';
  for (const row of COMPILED) if ((row.method === '*' || row.method === m) && row.re.test(p)) return row;
  return m === 'GET' || m === 'HEAD' ? { method: 'GET', pattern: '(unlisted)', kind: 'read', opens: [] } : DEFAULT_WRITE;
};
export const opened = (row, proofs = {}) => row.kind !== 'act' || row.opens.some((k) => !!proofs[k]);
export const refusal = (row, method, pathname, { guardLinkFile = '' } = {}) => {
  const route = `${String(method || '').toUpperCase()} ${pathname}`;
  const gate = { route, opens: [...row.opens] };
  if (row.refuse) return { messageKey: row.refuse, vars: {}, gate }; // a row that says its own way out (the push: the button on the Mac)
  if (row.opens.length === 1 && row.opens[0] === 'cookie') return { messageKey: 'srv.s.guardKey', vars: { file: guardLinkFile }, gate };
  return { messageKey: 'srv.gate.closed', vars: { gesture: `srv.gate.g.${row.gesture || 'write'}` }, gate };
};

// Decided when the server starts, never by a route, a setting or a file a session could reach
export const gateOff = (env = process.env) => envVar('GATE', env) === 'off' || (!!env.NODE_TEST_CONTEXT && envVar('GATE', env) !== 'on');

const HEX = /^[0-9a-f]{64}$/;
const dirOf = (env) => envVar('GUARD_DIR', env) || configDirIn(homedir());
export const pilotToken = ({ env = process.env, dir = dirOf(env) } = {}) => {
  const given = String(envVar('PILOT_TOKEN', env) || '').trim(); if (given.length >= 32) return given;
  if (env.NODE_TEST_CONTEXT && !envVar('GUARD_DIR', env)) return randomBytes(32).toString('hex');
  const file = path.join(dir, 'pilot-token'); let token = null;
  try { token = readFileSync(file, 'utf8').trim(); } catch {}
  try {
    if (!HEX.test(token || '')) { mkdirSync(dir, { recursive: true, mode: 0o700 }); token = randomBytes(32).toString('hex'); writeFileSync(file, token + '\n', { mode: 0o600 }); }
    chmodSync(file, 0o600);
  } catch (e) { console.error(`pilot-token: ${e.message} (the pilot's token lives in memory until the server stops)`); }
  return HEX.test(token || '') ? token : randomBytes(32).toString('hex');
};
export const tokenMatches = (given, token) => { const x = Buffer.from(String(given || '')); const y = Buffer.from(String(token || '')); return x.length === y.length && x.length > 0 && timingSafeEqual(x, y); };
