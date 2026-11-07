import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { DatabaseSync } from 'node:sqlite';

const SCRIPT = path.join(path.dirname(new URL(import.meta.url).pathname), '..', 'scripts', 'measure-rafale.mjs');
const at = (h) => `2026-11-02T${h}.000Z`;
const user = (h, text, extra = {}) => ({ type: 'user', uuid: 'u' + h, timestamp: at(h), entrypoint: 'cli', sessionId: 's1', message: { role: 'user', content: text }, ...extra });
const asst = (h, id, stop, usage = { input_tokens: 10, cache_creation_input_tokens: 0, cache_read_input_tokens: 90000 }) => ({ type: 'assistant', uuid: 'a' + h, timestamp: at(h), message: { id, model: 'claude-fable-5-1', stop_reason: stop, usage, content: [{ type: 'text', text: 'ok' }] } });
const queued = (h, text) => ({ type: 'attachment', uuid: 'q' + h, timestamp: at(h), attachment: { type: 'queued_command', prompt: text } });

test('the measure replays a conversation and the wakes of a day, read only', () => {
  const dir = mkdtempSync(path.join(tmpdir(), 'raf-'));
  const conv = path.join(dir, 'projects', '-Users-gab-Dev-escadrille'); mkdirSync(conv, { recursive: true });
  // one turn 10:00–10:05 during which Dev writes three times (two queued commands, one prompt), then an idle prompt
  const lines = [user('10:00:00', 'Lance la phase'), asst('10:00:10', 'm1', 'tool_use'), queued('10:01:00', 'Et ajoute ceci'), queued('10:02:00', 'Et cela'),
    user('10:03:00', 'Encore une chose'), asst('10:05:00', 'm2', 'end_turn'), user('10:10:00', 'Merci'), asst('10:10:30', 'm3', 'end_turn')];
  writeFileSync(path.join(conv, 'c1.jsonl'), lines.map((l) => JSON.stringify(l)).join('\n') + '\n');
  const db = new DatabaseSync(path.join(dir, 'db.sqlite'));
  db.exec(`create table plans (id text primary key, title text, created text, json text, project text);
    create table sessions (plan text, id text, session_id text);
    create table session_messages (seq integer primary key autoincrement, plan text, session text, role text, text text, data text, at text);
    create table log (seq integer primary key autoincrement, plan text, session text, at text, status text, stops text, health text, why text, claude text, name text);
    create table main_messages (seq integer primary key autoincrement, project text, role text, text text, at text);`);
  db.prepare('insert into plans (id, project) values (?, ?)').run('p', '/x');
  const log = db.prepare('insert into log (plan, session, at, status, stops, health) values (?, ?, ?, ?, ?, ?)');
  log.run('p', 'A', at('09:00:00'), 'running', '[]', 'ok');
  log.run('p', 'A', at('11:00:00'), 'waiting', '[0]', 'ok'); // a stop, waiting
  log.run('p', 'B', at('09:00:00'), 'running', '[]', 'ok');
  log.run('p', 'B', at('11:01:00'), 'done', '[0]', 'ok'); // a minute later, an end: one wake with the window
  log.run('p', 'A', at('12:00:00'), 'running', '[0,1]', 'ok'); // a stop crossed while working: phase 13's filter drops it
  db.close();
  const out = JSON.parse(execFileSync(process.execPath, [SCRIPT, '--db', path.join(dir, 'db.sqlite'), '--projects', path.join(dir, 'projects'), '--days', '2026-11-02'], { encoding: 'utf8' }));
  const c = out.conversations.list[0];
  assert.equal(c.messages, 5); assert.equal(c.queued, 3); assert.deepEqual(c.groups, [3]); assert.equal(c.saved, 2);
  assert.equal(c.medianContext, 90010); assert.ok(c.usdSaved > 0);
  assert.equal(out.wakes.droppedByFilter, 1); assert.equal(out.wakes.before, 2); assert.equal(out.wakes.after, 1); assert.equal(out.wakes.avoided, 1);
});
