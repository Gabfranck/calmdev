// Phase 13 PIL (docs/pilot.md): the permission policy, the filter and the Haiku triage of the wakes, the pilot's handoff, the
// QA loop, the checks of a stop, the triage of the developer's messages and the budget raise. Pure parts first, then the
// server against the fake claude of test/fake-pilot.mjs (which also plays the triage, the router and a delegated session).
import { freePort } from './free-port.mjs';
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { testEnv } from './test-env.mjs';
import { mkdtempSync, realpathSync, writeFileSync, readFileSync, existsSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { decidePolicy, refusalLine } from '../lib/pilotpolicy.mjs';
import { classify, mustEscalate, triagePrompt, parseTriage, tally, cheapShare } from '../lib/wake.mjs';
import { needsHandoff, parseHandoff, costStats, pushCost, handoffRequest } from '../lib/pilothandoff.mjs';
import { splitFailures, fixMessage, defectsMarkdown, qaPending } from '../lib/qaloop.mjs';
import { checksFor, resolveArgv, checkNote, gapsOf, summaryLine } from '../lib/checks.mjs';
import { looksLikeAction, parseRoute, routeOf, busyLine, noteLine, tallyMessage, delegatedShare } from '../lib/msgtriage.mjs';
import { validatePilot, wakePrompt } from '../lib/pilot.mjs';
import { fakePilot } from './fake-pilot.mjs';

const HERE = path.dirname(new URL(import.meta.url).pathname);
const tmp = (p) => realpathSync(mkdtempSync(path.join(tmpdir(), p)));
let dump = async () => '';
const until = async (fn, ms = 30000) => { const t0 = Date.now(); for (;;) { const v = await fn(); if (v) return v; if (Date.now() - t0 > ms) throw new Error('timeout\n' + (await dump())); await new Promise((r) => setTimeout(r, 60)); } };
const lines = (f) => (existsSync(f) ? readFileSync(f, 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l)) : []);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// ---------------------------------------------------------------- 1. the policy
test('the policy answers like the pilot’s script: local yes; network, push, outside the worktree, windows, sandbox off never; off by default', () => {
  const local = { allow: true, reason: 'Lecture seule', rule: 'read-only' };
  assert.equal(decidePolicy({ on: false, suggest: local, ask: {} }).answer, 'wait', 'off: nothing');
  assert.equal(decidePolicy({ on: true, suggest: local, ask: { tool: 'Bash', input: { command: 'ls' } } }).answer, 'allow');
  assert.equal(decidePolicy({ on: true, suggest: { allow: true, reason: 'x', rule: 'write-inside' }, ask: {} }).answer, 'allow');
  assert.equal(decidePolicy({ on: true, suggest: local, ask: { network: true, input: { command: 'curl https://x.y' } } }).answer, 'deny', 'network even if a rule said yes');
  assert.match(decidePolicy({ on: true, suggest: local, ask: { input: { command: 'git push origin main' } } }).reason, /push/);
  assert.equal(decidePolicy({ on: true, suggest: { allow: false, reason: 'Écriture hors du worktree : ~/x', rule: 'write-outside' }, ask: {} }).answer, 'deny');
  assert.equal(decidePolicy({ on: true, suggest: { allow: false, reason: 'Aucune fenêtre', rule: 'open-window' }, ask: {} }).answer, 'deny');
  assert.equal(decidePolicy({ on: true, suggest: local, ask: { input: { dangerouslyDisableSandbox: true } } }).answer, 'deny');
  assert.equal(decidePolicy({ on: true, suggest: { allow: null, reason: '', rule: null }, ask: {} }).answer, 'wait', 'the rule does not know: a person');
  assert.match(refusalLine({ reason: 'push' }), /^Refusé par la politique du projet : push\.$/);
});

// ---------------------------------------------------------------- 7 and 8. the filter and the triage
test('the filter: an event already seen, an informative alert, a session still at work and a handled permission wake nothing', () => {
  const events = [{ seq: 5, plan: 'p', session: 'A', what: 'arrêt 0 franchi', text: 'x' }, { seq: 6, plan: 'p', session: 'B', what: 'attend', text: 'y' }];
  const waiting = [{ plan: 'p', session: 'B', pendingId: 'reply-1', kind: 'reply', stopKind: 'info', text: 'y', at: '1' }, { plan: 'p', session: 'C', pendingId: 'alert-1', kind: 'alert', at: '2' }, { plan: 'p', session: 'D', pendingId: 'perm-1', kind: 'permission', handled: true, at: '3' }];
  const rows = { 'p/A': { status: 'running', health: 'ok' }, 'p/B': { status: 'waiting', health: 'ok' } };
  const r1 = classify({ events, waiting, rows, seen: [] });
  assert.deepEqual(r1.keep.map((e) => e.session), ['B'], 'A still works: dropped'); assert.deepEqual(r1.waiting.map((w) => w.session), ['B']);
  assert.deepEqual(r1.dropped.map((d) => d.why).sort(), ['informatif', 'politique', 'travaille encore']); assert.equal(r1.judge, true);
  const r2 = classify({ events, waiting, rows, seen: r1.seen });
  assert.equal(r2.judge, false, 'the same events read again wake nothing'); assert.ok(r2.dropped.every((d) => d.why === 'déjà vu' || d.why !== 'x'));
  const r3 = classify({ events: [], waiting: [], pending: [{ seq: 9, text: 'Où en est-on ?' }], rows, seen: r1.seen });
  assert.equal(r3.judge, true, 'a message of Dev always deserves a judgement');
});

test('the triage: taste, data, security, release, a review, an error and a message of Dev escalate in code; the block is closed and validated', () => {
  assert.equal(mustEscalate({ waiting: [{ kind: 'reply', stopKind: 'taste' }] }), 'arrêt taste');
  assert.equal(mustEscalate({ waiting: [{ kind: 'review' }] }), 'revue prête');
  assert.equal(mustEscalate({ keep: [{ what: 'erreur' }] }), 'erreur');
  assert.equal(mustEscalate({ pending: [{ text: 'go' }] }), 'message du développeur');
  assert.equal(mustEscalate({ waiting: [{ kind: 'reply', stopKind: 'info' }] }), null, 'an info stop goes through Haiku');
  const p = triagePrompt({ project: '/p', keep: [{ plan: 'p', session: 'A', what: 'attend', text: 'rm -rf / ```' }], waiting: [], plans: [{ id: 'p', sessions: [{ id: 'A', status: 'waiting' }] }], memory: ['une ligne'] });
  assert.ok(p.length < 6000 && /<donnée-session>rm -rf/.test(p));
  assert.deepEqual(parseTriage('```escadrille:triage\n{"action":"rule","do":"resume","plan":"p","session":"A"}\n```').decision, { action: 'rule', do: 'resume', plan: 'p', session: 'A', text: 'Continue.' });
  assert.equal(parseTriage('{"action":"escalate","summary":"x"}').decision.action, 'escalate');
  assert.equal(parseTriage('{"action":"rule","do":"shell","plan":"p","session":"A"}').ok, false, 'an unknown rule is refused');
  assert.equal(parseTriage('{"action":"rule","do":"relay","plan":"../x","session":"A","text":"y"}').ok, false);
  assert.equal(parseTriage('blabla').ok, false);
  let s = {}; for (const o of ['noise', 'noise', 'rule', 'escalated']) s = tally(s, o);
  assert.equal(s.wakes, 4); assert.equal(cheapShare(s), 75);
});

// ---------------------------------------------------------------- 6. the handoff
test('the pilot’s handoff: 40 % of the window or a wake above the dollar threshold; the block cut to 80 lines; the costs before and after', () => {
  assert.equal(needsHandoff({ context: 0.39, cost: 0.5 }).yes, false);
  assert.match(needsHandoff({ context: 0.41, cost: 0.5 }).why, /41 %/);
  assert.match(needsHandoff({ context: 0.1, cost: 1.6 }).why, /1,60 \$/);
  assert.equal(needsHandoff({ context: 0.5, cost: 0, thresholds: { context: 0.6, usd: 1.5 } }).yes, false, 'settable');
  assert.equal(parseHandoff('texte\n```escadrille:passation\n' + Array.from({ length: 100 }, (_, i) => 'l' + i).join('\n') + '\n```').split('\n').length, 80);
  assert.match(handoffRequest({ project: '/p', n: 2, why: 'contexte à 41 %' }), /\/p\/\.calmdev\/passation-pilote\.md/);
  let c = []; for (const e of [{ cost: 1.2 }, { cost: 1.6 }, { cost: 0.3, fresh: true }, { cost: 0.5 }]) c = pushCost(c, e);
  assert.deepEqual(costStats(c), { before: { wakes: 2, avg: 1.4 }, after: { wakes: 2, avg: 0.4 } });
});

// ---------------------------------------------------------------- 2. the QA loop
test('the QA loop: a failing journey goes back once, then it is a true defect; defauts.md and the « À toi » entry', () => {
  const results = [{ id: 'a', ok: true }, { id: 'b', ok: false, echec: 'cible « X » invisible', titre: 'B' }, { id: 'c', ok: false, echec: '500' }];
  const r1 = splitFailures(results, []); assert.deepEqual(r1.toFix.map((x) => x.id), ['b', 'c']); assert.deepEqual(r1.defects, []);
  assert.match(fixMessage('qa/p.json', r1.toFix), /2 parcours en échec, renvoyés une fois/); assert.match(fixMessage('qa/p.json', r1.toFix), /- b « B » : cible « X » invisible/);
  const r2 = splitFailures([{ id: 'a', ok: true }, { id: 'b', ok: false, echec: 'encore' }], r1.sent); assert.deepEqual(r2.toFix, []); assert.deepEqual(r2.defects.map((x) => x.id), ['b']);
  const md = defectsMarkdown({ file: 'qa/p.json', defects: r2.defects, dir: '/w/.escadrille/qa/1-p' }); assert.match(md, /^# Défauts réels · p\.json/); assert.match(md, /## b\n/);
  const e = qaPending({ id: 'qa-1', file: 'qa/p.json', defects: r2.defects, dir: '/w/.escadrille/qa/1-p' });
  assert.equal(e.kind, 'qa'); assert.equal(e.board, '/w/.escadrille/qa/1-p/planche.html'); assert.equal(e.defects, '/w/.escadrille/qa/1-p/defauts.md'); assert.match(e.text, /1 vrai défaut/);
});

// ---------------------------------------------------------------- 11. the checks
test('the checks: declared by the project, run only when the branch touches their paths, {base} from the session’s server, the final line', () => {
  const env = { checks: [{ name: 'contrat UX', paths: ['public/'], command: ['node', 'scripts/ux-contract.mjs', '{base}', '{project}'] }, { paths: ['lib/**'], command: ['node', '--test'] }] };
  assert.deepEqual(checksFor(env, ['lib/x.mjs']).map((c) => c.name), ['node --test']);
  assert.deepEqual(checksFor(env, ['public/plan.html', 'docs/a.md']).map((c) => c.name), ['contrat UX']);
  assert.deepEqual(checksFor(env, ['docs/a.md']), []);
  assert.deepEqual(resolveArgv(['node', 'x', '{base}', '{project}'], { base: 'http://localhost:3099', project: '/p' }), { argv: ['node', 'x', 'http://localhost:3099', '/p'], missing: [] });
  assert.deepEqual(resolveArgv(['x', '{base}'], { base: null }).missing, ['base']);
  assert.equal(gapsOf(['…', '3 écarts']), 3); assert.equal(gapsOf(['ok']), null);
  assert.match(checkNote({ name: 'contrat UX' }, { code: 1, lines: ['a', '3 écarts'], gaps: 3 }), /^VÉRIFICATION contrat UX : code 1, 3 écarts\n  │ a/);
  assert.match(checkNote({ name: 'c' }, { skipped: 'base inconnu' }), /non lancée \(base inconnu\)/);
  assert.equal(summaryLine([{ name: 'a', code: 0 }, { name: 'b', code: 0 }]), 'Vérifications : vert (2)');
  assert.equal(summaryLine([{ name: 'a', code: 1, gaps: 3 }, { name: 'b', code: 0 }]), 'Vérifications : 3 écarts (a)');
});

// ---------------------------------------------------------------- 10 and 12. the messages
// The real messages of Dev of 1 and 2 November (docs/recap-session-2026-11-01.md, docs/decisions.md): the code's guard sends every
// request for an action to the pilot; the standalone questions may be delegated by Haiku (routeOf keeps Haiku's word for those)
const PILOT_MSGS = [
  'ok commit tout ici pour bien garder un point de sauvegarde.', 'Fais-moi un plan de reviews à suivre, accessible sur Escadrille, et ouvre-moi l’app dessus.',
  'Note bien tout ça pour démarrer la comm au plus vite. Pas de temps mort : planifie cette comm et fais-moi un kit pour LinkedIn, Reddit, Product Hunt et Hacker News.',
  'Tu peux lancer le design pass de la v2 s’il me reste des tokens avant 14 h.', 'Tu peux y aller et autoriser Expo si besoin.', 'go',
  'cramme tout en faisant plus d’avatars ou en peaufinant les applications, pas de changement UX juste UI.', 'Fais un récap de toutes les conversations que j’ai moi-même entrées et le résultat de la session.',
  'Je te laisse répondre pour moi à toutes les questions de goût… ne sois pas bloqué.', 'Tu peux aussi prendre de l’avance sur les sprints Linear, qu’une grosse QA par sprint.',
  'Il faudra bien que tu me gardes tout ça en mémoire facilement accessible sur Escadrille.', 'Pense à toutes les prochaines améliorations possibles… pas qu’en features mais en business.',
];
const DELEGABLE = ['un prof avec plein de stats dans la seed ?', 'pourquoi ce type de question n’est pas dans l’app élève ?', 'Quels sont les risques à utiliser l’outil ?', 'Quelle est l’estimation du coût en tokens d’Escadrille ?'];
const PILOT_QUESTIONS = ['As-tu prévu une landing page dans tes tâches pour Escadrille ?', 'Rappelle-moi les phases ?', 'un ETA de chaque phase ?', 'ok je peux aller me coucher tranquille ?'];
test('the triage of Dev’s messages: an action goes to the pilot whatever Haiku said; a standalone question may be delegated; in doubt the pilot', () => {
  for (const t of PILOT_MSGS) assert.equal(routeOf({ text: t, decision: { route: 'delegate', model: 'claude-haiku-5-5', question: t } }).route, 'pilot', t);
  for (const t of DELEGABLE) { assert.equal(looksLikeAction(t), false, t); assert.equal(routeOf({ text: t, decision: parseRoute(`{"route":"delegate","model":"sonnet","question":${JSON.stringify(t)}}`, { project: '/p' }) }).route, 'delegate', t); }
  for (const t of PILOT_QUESTIONS) assert.equal(routeOf({ text: t, decision: parseRoute('{"route":"pilot"}') }).route, 'pilot', t);
  assert.equal(parseRoute('{"route":"delegate","model":"sonnet","question":"x","project":"/other"}', { project: '/p' }).route, 'pilot', 'another project: the pilot');
  assert.equal(parseRoute('{"route":"delegate","model":"gpt","question":"x"}', { project: '/p' }).model, 'claude-haiku-5-5', 'an unknown model falls to haiku');
  assert.equal(parseRoute('pas de bloc').route, 'pilot');
  assert.match(busyLine({ doing: 'une revue', since: '10:02' }), /occupé \(une revue, depuis 10:02\)/);
  assert.match(noteLine({ question: 'q ?', answer: 'Oui. Et plus.', model: 'claude-sonnet-5-5' }), /^Question déléguée \(Sonnet 5\.5\) : q \? → Oui\.$/);
  let s = {}; s = tallyMessage(s, { delegated: true, cost: 0.03 }); s = tallyMessage(s, {}); assert.equal(delegatedShare(s), 50); assert.equal(s.delegatedCost, 0.03);
  const { actions, errors } = validatePilot({ actions: [{ do: 'budget', plan: 'p', session: 'A', usd: 12 }, { do: 'budget', plan: 'p', session: 'A', usd: -1 }] });
  assert.equal(actions.length, 1); assert.equal(errors.length, 1);
  assert.match(wakePrompt({ project: '/p', notes: ['Question déléguée (Haiku 5.5) : q → r'], triage: 'à juger' }), /### Le tri \(Haiku\)[\s\S]*### Pendant ton absence[\s\S]*- Question déléguée/);
});

// ---------------------------------------------------------------- the server, against the fake claude
const startServer = (env) => {
  const port = freePort();
  // Isolated from the Mac's real transcripts, sessions, home and model override (see test/pilot.test.mjs): outside the sandbox the
  // server would scan ~/.claude/projects at every estimate and block for seconds
  const none = () => tmp('escadrille-none-');
  const isolated = { ESCADRILLE_TRANSCRIPTS: none(), ESCADRILLE_SESSIONS: none(), ESCADRILLE_HOME: none(), ESCADRILLE_MODELS: path.join(none(), 'models.json') };
  const child = spawn(process.execPath, ['--no-warnings', path.join(HERE, '..', 'server.mjs')], { env: { ...testEnv(), ESCADRILLE_GATE: 'off', ...isolated, PORT: String(port), ESCADRILLE_PUSH_URL: 'http://127.0.0.1:9/', ESCADRILLE_PILOT_DEBOUNCE_MS: '120', ESCADRILLE_PILOT_EVENT_WINDOW_MS: '0', ESCADRILLE_CLAUDE_PROJECTS: tmp('escadrille-ccp-'), ...env }, stdio: ['ignore', 'pipe', 'pipe'] });
  const s = { child, err: '', base: `http://127.0.0.1:${port}` }; child.stderr.on('data', (d) => { s.err += d; });
  // « fetch failed » on the Mac (2026-11-02): a pooled keep-alive socket closed by the server as the next request left; one retry while the server lives
  const once = async (p, body) => { const r = await fetch(s.base + p, { method: body !== undefined ? 'POST' : 'GET', headers: { connection: 'close', ...(body !== undefined ? { 'content-type': 'application/json' } : {}) }, body: body !== undefined ? JSON.stringify(body) : undefined }); return { status: r.status, body: await r.json() }; };
  s.call = async (p, body) => { try { return await once(p, body); } catch (e) { if (child.exitCode !== null || !/fetch failed/.test(e.message)) throw e; await new Promise((r) => setTimeout(r, 150)); return once(p, body); } };
  s.ready = until(async () => { try { return (await s.call('/api/plans')).status === 200; } catch { return false; } });
  return s;
};
const planBlock = (title, stop) => '```escadrille:pilot\n' + JSON.stringify({ do: 'propose', plan: { title, goal: 'essai', sessions: [{ id: 'A', name: 'Essai', model: 'claude-sonnet-5-5', budget: 1, stops: [stop], prompt: 'Fais un essai.' }] } }) + '\n```';
const F = fakePilot(); const PROJ = tmp('escadrille-p13-proj-'); const DB = path.join(tmp('escadrille-db-'), 'db.sqlite'); const PLANS = tmp('escadrille-plans-');
mkdirSync(path.join(PROJ, '.calmdev'), { recursive: true });
writeFileSync(path.join(F.dir, 'turns.json'), JSON.stringify([
  'Rien ne tourne. Pose ta demande.',
  'Je propose un plan.\n\n' + planBlock('Essai étape', { title: 'Une étape', kind: 'info' }),
  'Je relève le budget de A.\n\n```escadrille:pilot\n{"do":"budget","plan":"{{plan}}","session":"{{session}}","usd":3}\n```',
])); // the turns after: « Rien de neuf. » (the tests below count the turns, they do not read them)
// the session asks a local permission and a network one in its first turn: the fake pilot's session mode answers the state block alone, so the
// permissions are asked by a dedicated fake session (below, via the control probe of the stream is not needed: we use the ask events of the fake)
writeFileSync(path.join(F.dir, 'session.txt'), 'Un tour.');
let S = startServer({ ESCADRILLE_DB: DB, ESCADRILLE_PLANS: PLANS, ESCADRILLE_CLAUDE: F.file });
after(() => S.child.kill('SIGINT'));
const q = encodeURIComponent(PROJ);
const thread = async () => (await S.call(`/api/main?project=${q}&limit=100`)).body.messages.reverse();
const pilotTurns = () => lines(path.join(F.dir, 'pilot.jsonl'));
const lastOf = async (role, re) => until(async () => (await thread()).filter((m) => m.role === role && (!re || re.test(m.text))).pop());
const log = async () => (await S.call(`/api/pilot/log?project=${q}`)).body.actions;
let planId;
dump = async () => { try { return 'THREAD\n' + (await thread()).map((m) => `${m.role}: ${m.text.slice(0, 160).replace(/\n/g, ' ')}`).join('\n') + '\nPILOT TURNS ' + pilotTurns().length + '\nSTDERR\n' + S.err.slice(-1500); } catch (e) { return 'dump: ' + e.message; } };

test('a message of Dev goes through the router (Haiku, no --resume); routed pilot, it wakes the pilot; the triage never runs for a message', async () => {
  await S.ready;
  assert.equal((await S.call('/api/project/settings', { project: PROJ, autonomy: { mode: 'guide' } })).status, 200, S.err);
  const v = (await S.call('/api/pilot', { project: PROJ, on: true })).body.pilot; assert.equal(v.policy, false, 'the policy is off by default'); assert.equal(v.triage, true);
  await S.call('/api/main', { project: PROJ, text: 'Où en est-on sur le plan ?' });
  const m = await lastOf('claude'); assert.equal(m.text, 'Rien ne tourne. Pose ta demande.');
  const routes = lines(path.join(F.dir, 'route.jsonl')); assert.equal(routes.length, 1); assert.equal(routes[0].model, 'claude-haiku-5-5'); assert.match(routes[0].text, /<message>Où en est-on sur le plan \?<\/message>/);
  assert.equal(lines(path.join(F.dir, 'triage.jsonl')).length, 0, 'a message of Dev escalates in code');
  assert.equal(pilotTurns().length, 1);
});

test('a delegated question is answered in the thread by its model, signed; the pilot only gets one line at its next wake', async () => {
  writeFileSync(path.join(F.dir, 'route.json'), '{"route":"delegate","model":"sonnet","question":"Un prof avec des stats dans la seed ?"}');
  await S.call('/api/main', { project: PROJ, text: 'un prof avec plein de stats dans la seed ?' });
  const a = await lastOf('claude', /Réponse déléguée/);
  assert.match(a.text, /— Sonnet 5\.5, en lecture seule$/); assert.equal(a.source, 'delegate:claude-sonnet-5-5'); assert.equal(a.data.delegated.model, 'claude-sonnet-5-5');
  const d = lines(path.join(F.dir, 'delegate.jsonl')); assert.equal(d.length, 1); assert.equal(d[0].model, 'claude-sonnet-5-5'); assert.ok(d[0].args.includes('--max-budget-usd') && d[0].args[d[0].args.indexOf('--max-budget-usd') + 1] === '0.5', 'a bounded budget');
  assert.ok(!d[0].args.includes('--resume') && !d[0].args.includes('Edit'), 'fresh and read-only');
  assert.equal(pilotTurns().length, 1, 'the pilot did not wake for it');
  const st = (await S.call(`/api/pilot?project=${q}`)).body.stats.messages; assert.equal(st.messages, 2); assert.equal(st.delegated, 1); assert.equal(st.delegatedShare, 50); assert.ok(st.delegatedCost > 0);
  assert.ok((await log()).some((l) => l.kind === 'note' && /Question déléguée à Sonnet 5\.5/.test(l.text)));
  writeFileSync(path.join(F.dir, 'route.json'), '{"route":"pilot"}');
});

test('an action request goes to the pilot whatever Haiku says; the next wake carries the delegated line under « Pendant ton absence »', async () => {
  writeFileSync(path.join(F.dir, 'route.json'), '{"route":"delegate","model":"haiku","question":"x"}');
  await S.call('/api/main', { project: PROJ, text: 'Ajoute un essai d’étape' });
  const card = await lastOf('claude', /Je propose/); planId = card.data.proposal.planId;
  assert.equal(lines(path.join(F.dir, 'route.jsonl')).length, 2, 'no routing call for an action: the code decides');
  assert.match(pilotTurns()[1].text, /### Pendant ton absence[\s\S]*Question déléguée \(Sonnet 5\.5\) : Un prof avec des stats dans la seed \? → Réponse déléguée/);
  writeFileSync(path.join(F.dir, 'route.json'), '{"route":"pilot"}');
});

test('the budget: the pilot raises a launched session’s cap under the weekly threshold (route { usd }); a live idle process restarts with the new cap', async () => {
  const r = await S.call('/api/main/accept', { project: PROJ, seq: (await lastOf('claude', /Je propose/)).seq }); assert.equal(r.status, 200, JSON.stringify(r.body));
  // the session crosses stop 0 (kind info) and waits: an info stop goes through the triage, which escalates by default → the pilot raises the budget
  await until(async () => (await S.call(`/api/plan/${planId}`)).body.state.find((s) => s.id === 'A')?.status === 'waiting');
  const sys = await lastOf('system', /Budget de A relevé/); assert.match(sys.text, /de 1,00 \$ à 3,00 \$/);
  const tri = lines(path.join(F.dir, 'triage.jsonl')); assert.ok(tri.length >= 1, 'the triage ran on Haiku'); assert.equal(tri[0].model, 'claude-haiku-5-5'); assert.ok(!tri[0].text.includes('Tu es le pilote'));
  assert.ok(tri[0].text.length < 6000);
  assert.match(pilotTurns()[2].text, /### Le tri \(Haiku\) a demandé ton jugement/);
  const plan = (await S.call(`/api/plan/${planId}`)).body.plan; assert.equal(plan.sessions.find((s) => s.id === 'A').budget, 3);
  const msgs = (await S.call(`/api/plan/${planId}/session/A/messages`)).body.messages; assert.ok(msgs.some((m) => /processus relancé avec le nouveau plafond/.test(m.text)), msgs.map((m) => m.text).join('|'));
  const args = lines(path.join(F.dir, 'pilot-args.jsonl')); // the sessions' args are not logged; the session's restart shows in its messages above
  assert.ok(args.length >= 3);
  // the route itself, { usd }, from the Mac
  const b = await S.call(`/api/plan/${planId}/session/A/budget`, { usd: 4 }); assert.equal(b.status, 200, JSON.stringify(b.body)); assert.equal(b.body.budget, 4);
  assert.equal((await S.call(`/api/plan/${planId}/session/A/budget`, { usd: 'x' })).status, 400);
  const st = (await S.call(`/api/pilot?project=${q}`)).body.stats.wakes; assert.ok(st.escalated >= 1, JSON.stringify(st));
});

test('the triage applies a rule alone: « resume » sends the text to the waiting session and the pilot does not wake; the share is counted', async () => {
  writeFileSync(path.join(F.dir, 'triage.json'), JSON.stringify({ action: 'rule', do: 'resume', plan: planId, session: 'A', text: 'Continue sans attendre.' }));
  const turnsBefore = pilotTurns().length; const triBefore = lines(path.join(F.dir, 'triage.jsonl')).length;
  await S.call(`/api/plan/${planId}/session/A/message`, { text: 'Encore un tour.' }); // the session answers and waits again: an info stop
  await until(() => lines(path.join(F.dir, 'triage.jsonl')).length > triBefore);
  await until(async () => (await S.call(`/api/plan/${planId}/session/A/messages`)).body.messages.some((m) => m.text === 'Continue sans attendre.'));
  assert.equal(pilotTurns().length, turnsBefore, 'handled without the big model');
  writeFileSync(path.join(F.dir, 'triage.json'), '{"action":"escalate","summary":"à juger"}');
  const l = await log(); assert.ok(l.some((x) => x.kind === 'note' && /Tri \(Haiku\) : resume A/.test(x.text)));
  const st = (await S.call(`/api/pilot?project=${q}`)).body.stats.wakes; assert.ok(st.rule >= 1); assert.equal(typeof st.cheapShare, 'number');
  // the session waits again after the resume: the triage escalates now, and the pilot wakes once for it (a streak of rules is capped at 2 anyway)
  await until(() => pilotTurns().length > turnsBefore);
  await sleep(300);
});

test('the policy, on: a local permission is answered without a model and written in the journal; a network one is refused with a line; nothing wakes the pilot', async () => {
  assert.equal((await S.call('/api/pilot', { project: PROJ, pilotPolicy: true })).body.pilot.policy, true);
  // the fake session has no ask: the permission events are driven through the probe of the fake claude: a sidecar file read by the fake session on its next message
  const turnsBefore = pilotTurns().length;
  const r = await S.call(`/api/plan/${planId}/session/A/message`, { text: 'ASK: ls -la' });
  assert.equal(r.status, 200, JSON.stringify(r.body));
  const msgs = await until(async () => { const ms = (await S.call(`/api/plan/${planId}/session/A/messages`)).body.messages; return ms.some((m) => m.data?.answer && m.data.auto) ? ms : null; });
  const ans = msgs.filter((m) => m.data?.answer && m.data.auto);
  assert.equal(ans[0].data.allow, true, JSON.stringify(ans[0]));
  await S.call(`/api/plan/${planId}/session/A/message`, { text: 'ASK: curl https://example.com' });
  const refused = await until(async () => (await S.call(`/api/plan/${planId}/session/A/messages`)).body.messages.find((m) => m.data?.answer && m.data.auto && m.data.allow === false));
  assert.ok(refused);
  const l = await log(); assert.ok(l.some((x) => x.kind === 'answer' && /Autorisé par la politique/.test(x.text)), JSON.stringify(l.slice(0, 3)));
  assert.ok(l.some((x) => x.kind === 'refuse' && /Refusé par la politique/.test(x.text) && /réseau/.test(x.detail)));
  await sleep(500);
  // the session waits after each turn (that may wake someone, as always); the permissions themselves never reach a wake nor the triage
  for (const t of pilotTurns().slice(turnsBefore)) assert.ok(!/\(permission/.test(t.text), 'a permission the policy handled is not carried to the pilot');
  for (const t of lines(path.join(F.dir, 'triage.jsonl'))) assert.ok(!/\(permission/.test(t.text));
  assert.equal((await S.call('/api/pilot', { project: PROJ, pilotPolicy: 'oui' })).status, 400);
});

test('the conversation never waits: a message during a long pilot turn gets a line at once, before the turn ends', async () => {
  writeFileSync(path.join(F.dir, 'delay.txt'), '4000');
  const turnsBefore = pilotTurns().length;
  await S.call('/api/main', { project: PROJ, text: 'Lance la suite.' }); // an action: the pilot, now busy for 4 s
  await until(() => pilotTurns().length > turnsBefore);
  const t0 = Date.now();
  await S.call('/api/main', { project: PROJ, text: 'Et pendant ce temps, où en est-on sur le plan ?' });
  const busy = await lastOf('system', /Le pilote est occupé/); const dt = Date.now() - t0;
  assert.ok(dt < 3500, `answered in ${dt} ms, before the end of the 4 s turn`); assert.match(busy.text, /en un seul réveil/);
  writeFileSync(path.join(F.dir, 'delay.txt'), '0');
  await until(() => pilotTurns().length > turnsBefore + 1, 15000); // the second message rides the next wake, after the long turn
  assert.match(pilotTurns().at(-1).text, /Et pendant ce temps/);
  await sleep(300);
});

test('the handoff: past 40 % of the window the pilot writes passation-pilote.md in one more turn; the next wake is a fresh process; costs before and after', async () => {
  writeFileSync(path.join(F.dir, 'context.txt'), '90000'); // 45 % of 200000
  const starts = () => (existsSync(path.join(F.dir, 'pilot-starts.txt')) ? readFileSync(path.join(F.dir, 'pilot-starts.txt'), 'utf8').split('\n').filter(Boolean).length : 0);
  const before = starts(); assert.equal(before, 1, 'one Claude session so far, resumed at each wake');
  await S.call('/api/main', { project: PROJ, text: 'Fais un point.' });
  const sys = await lastOf('system', /Passation du pilote n°1/); assert.match(sys.text, /contexte à 45 %/);
  const file = path.join(PROJ, '.calmdev', 'passation-pilote.md'); assert.ok(existsSync(file)); assert.match(readFileSync(file, 'utf8'), /Ce qui tourne : rien\./);
  assert.ok((await log()).some((x) => x.kind === 'note' && /Passation du pilote n°1/.test(x.text)));
  const v = (await S.call(`/api/pilot?project=${q}`)).body; assert.equal(v.sessionId, null, 'the Claude session is forgotten'); assert.equal(v.handoff.count, 1); assert.equal(v.handoff.context, 0.4);
  writeFileSync(path.join(F.dir, 'context.txt'), '100');
  await S.call('/api/main', { project: PROJ, text: 'Fais encore un point.' });
  await until(() => starts() === 2);
  const last = pilotTurns().at(-1).text; assert.match(last, /^# Passation n°1, laissée par le pilote précédent\n\nCe qui tourne : rien\./); assert.match(last, /Mémoire|### L'état/);
  const args = lines(path.join(F.dir, 'pilot-args.jsonl')).at(-1); assert.ok(!args.includes('--resume'), 'fresh: no --resume');
  await until(async () => (await S.call(`/api/pilot?project=${q}`)).body.stats.costs.after.wakes >= 1);
  const c = (await S.call(`/api/pilot?project=${q}`)).body.stats.costs; assert.ok(c.before.wakes >= 3 && c.before.avg > 0, JSON.stringify(c));
});
