// Phase 7, the main conversation of a project (docs/mainchat.md): the import of a Claude Code transcript on a
// fixture, then the routes against the server on a spare port, with a throwaway ~/.claude/projects.
import { freePort } from './free-port.mjs';
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { testEnv } from './test-env.mjs';
import { mkdtempSync, mkdirSync, copyFileSync, appendFileSync, realpathSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { importTranscript, maskSecrets, humanText } from '../lib/mainchat.mjs';
// Fake home folders are assembled at run time: scripts/trace-scan.mjs takes a written one for a real one.
const USERS = '/Users'; const HOMES = '/home';

const HERE = path.dirname(new URL(import.meta.url).pathname);
const FIXTURE = path.join(HERE, 'fixtures', 'transcript.jsonl');
const tmp = (p) => realpathSync(mkdtempSync(path.join(tmpdir(), p)));
const until = async (fn, ms = 30000) => { const t0 = Date.now(); for (;;) { const v = await fn(); if (v) return v; if (Date.now() - t0 > ms) throw new Error('timeout'); await new Promise((r) => setTimeout(r, 60)); } };

test('the import keeps the human and the text of Claude, one answer per turn, nothing else', async () => {
  const info = {};
  const items = await importTranscript(FIXTURE, { info });
  assert.equal(info.session, 'sess-fixture'); assert.equal(info.entrypoint, 'cli');
  assert.deepEqual(items.map((m) => [m.uid, m.role]), [['u1', 'dev'], ['a2', 'claude'], ['q1', 'dev'], ['a4', 'claude'], ['u6', 'dev'], ['u9', 'dev']]);
  assert.equal(items[0].text, "Reprends le pilotage d'Escadrille.", 'the reminder is gone');
  assert.equal(items[1].text, "Je lis l'état.\n\nVoici où on en est : **trois** sessions tournent.", 'the text blocks of a turn, joined across a tool result');
  assert.equal(items[2].text, 'Et ajoute la vue Conversation', 'a mid-turn message without its envelope');
  assert.equal(items[4].text, '/model opus');
  assert.equal(items[5].text, 'Regarde ça :\n\n> ligne un\n> ligne deux\n\net voilà', 'a paste is quoted, without its tag');
  const all = items.map((m) => m.text).join('\n');
  for (const gone of ['secret', 'tool_use', 'server.mjs', 'méta', 'task-notification', 'SYSTEM NOTIFICATION', 'sous-agent', 'Set model', 'b12', 'pasted_content']) assert.ok(!all.includes(gone), gone + ' is not kept');
  assert.equal(items[1].at, '2026-11-01T07:00:11.000Z', 'an answer is dated by its last line');
});

test('humanText drops tool results and envelopes, maskSecrets hides keys but not hashes', () => {
  assert.equal(humanText([{ type: 'tool_result', content: 'x' }]), null);
  assert.equal(humanText('<system-reminder>a</system-reminder>  '), null);
  const m = maskSecrets(`clé sk-ant-api03-AbCdEfGh12345678IjKlMnOp, token = abcdefgh12, commit 1834a9e0c1d2e3f4a5b6c7d8e9f0a1b2c3d4e5f6, chemin ${USERS}/dev/Dev/escadrille/.claude/worktrees/2026-11-01-phase-7-connecteurs-robustesse-linux-N`);
  assert.equal(m.masked, 2);
  assert.ok(!m.text.includes('sk-ant') && !m.text.includes('abcdefgh12'));
  assert.ok(m.text.includes('1834a9e0c1d2e3f4a5b6c7d8e9f0a1b2c3d4e5f6') && m.text.includes('robustesse-linux-N'));
});

// The server, with its own ~/.claude/projects
const ROOT = tmp('escadrille-ccp-'); const PROJ = tmp('escadrille-main-');
const DIR = path.join(ROOT, PROJ.replace(/[/.]/g, '-')); mkdirSync(DIR);
const T = path.join(DIR, 'sess-fixture.jsonl'); copyFileSync(FIXTURE, T);
const OUTSIDE = path.join(tmp('escadrille-out-'), 'x.jsonl'); copyFileSync(FIXTURE, OUTSIDE);
const PORT = freePort(); const BASE = `http://127.0.0.1:${PORT}`;
const server = spawn(process.execPath, ['--no-warnings', path.join(HERE, '..', 'server.mjs')], { env: { ...testEnv(), ESCADRILLE_GATE: 'off', PORT: String(PORT), ESCADRILLE_DB: path.join(tmp('escadrille-db-'), 'db.sqlite'), ESCADRILLE_PLANS: tmp('escadrille-plans-'), ESCADRILLE_CLAUDE: '/bin/false', ESCADRILLE_PUSH_URL: 'http://127.0.0.1:9/', ESCADRILLE_CLAUDE_PROJECTS: ROOT, ESCADRILLE_TEST_REMOTE: '1' }, stdio: ['ignore', 'pipe', 'pipe'] });
let err = ''; server.stderr.on('data', (d) => { err += d; });
after(() => server.kill('SIGINT'));
const call = async (p, body, headers = {}) => { const r = await fetch(BASE + p, { method: body !== undefined ? 'POST' : 'GET', headers: { ...(body !== undefined ? { 'content-type': 'application/json' } : {}), ...headers }, body: body !== undefined ? JSON.stringify(body) : undefined }); return { status: r.status, body: await r.json() }; };
const q = encodeURIComponent(PROJ);
const ready = until(async () => { try { return (await call('/api/plans')).status === 200; } catch { return false; } });

test('POST /api/main keeps the developer’s message, GET pages newest first, pending lists what waits for the pilot', async () => {
  await ready;
  assert.equal((await call('/api/main', { project: PROJ, text: '  ' })).status, 400);
  assert.equal((await call('/api/main', { project: '/nulle/part', text: 'x' })).status, 400);
  for (let i = 1; i <= 5; i++) { const r = await call('/api/main', { project: PROJ, text: 'message ' + i }); assert.equal(r.status, 200, err); assert.equal(r.body.message.role, 'dev'); assert.equal(r.body.message.source, 'page'); }
  const p1 = (await call(`/api/main?project=${q}&limit=2`)).body;
  assert.deepEqual(p1.messages.map((m) => m.text), ['message 5', 'message 4']); assert.equal(p1.more, true); assert.equal(p1.total, 5);
  const p2 = (await call(`/api/main?project=${q}&limit=2&before=${p1.messages[1].seq}`)).body;
  assert.deepEqual(p2.messages.map((m) => m.text), ['message 3', 'message 2']);
  assert.deepEqual((await call(`/api/main?project=${q}&q=SAGE 3`)).body.messages.map((m) => m.text), ['message 3']);
  assert.equal((await call(`/api/main/pending?project=${q}`)).body.messages.length, 5);
  assert.equal((await call(`/api/main?project=${q}`, undefined, { 'x-escadrille-remote': '1' })).status, 401, 'never to the LAN');
});

test('the import is idempotent, a grown transcript adds the rest, a path outside ~/.claude/projects is refused', async () => {
  await ready;
  const list = (await call(`/api/main/transcripts?project=${q}`)).body;
  assert.equal(list.files.length, 1); assert.equal(list.files[0].first, "Reprends le pilotage d'Escadrille."); assert.equal(list.files[0].entrypoint, 'cli'); assert.equal(list.files[0].imported, 0);
  const r1 = (await call('/api/main/import', { project: PROJ, path: T })); assert.equal(r1.status, 200, JSON.stringify(r1.body));
  assert.deepEqual([r1.body.added, r1.body.updated, r1.body.masked, r1.body.session], [6, 0, 1, 'sess-fixture']);
  const r2 = (await call('/api/main/import', { project: PROJ, path: T })).body;
  assert.deepEqual([r2.added, r2.updated, r2.kept], [0, 0, 6], 'a second import doubles nothing');
  const all = (await call(`/api/main?project=${q}&limit=200`)).body.messages;
  assert.equal(all.length, 11); assert.ok(all.every((m) => !m.text.includes('sk-ant')), 'the key is masked');
  assert.ok(all.filter((m) => m.source === 'claude-code:sess-fixture').length === 6);
  // the file grows: the last answer gets longer, a new message arrives
  appendFileSync(T, JSON.stringify({ type: 'assistant', uuid: 'a5', sessionId: 'sess-fixture', timestamp: '2026-11-01T07:00:17.000Z', message: { content: [{ type: 'text', text: 'Modèle changé.' }] } }) + '\n'
    + JSON.stringify({ type: 'user', uuid: 'u8', sessionId: 'sess-fixture', timestamp: '2026-11-01T07:00:20.000Z', message: { content: 'Merci' } }) + '\n');
  const r3 = (await call('/api/main/import', { project: PROJ, path: T })).body;
  assert.deepEqual([r3.added, r3.updated], [2, 0], 'the answer after /model is a new turn, Merci a new message');
  assert.equal((await call(`/api/main/transcripts?project=${q}`)).body.files[0].imported, 8);
  for (const bad of [OUTSIDE, path.join(ROOT, '..', path.basename(ROOT), '..', 'x.jsonl'), path.join(DIR, 'nope.jsonl'), path.join(DIR), 'relatif.jsonl']) assert.equal((await call('/api/main/import', { project: PROJ, path: bad })).status, 400, bad);
  const pending = (await call(`/api/main/pending?project=${q}`)).body;
  assert.equal(pending.since, '2026-11-01T07:00:17.000Z', 'since the last answer of Claude');
  assert.ok(pending.messages.some((m) => m.text === 'Merci') && !pending.messages.some((m) => m.text.startsWith('Reprends')));
});
