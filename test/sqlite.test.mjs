// lib/sqlite.mjs: a busy timeout on every supported Node. Node 22.13 (the CI's) ignores DatabaseSync's `timeout` option,
// and a write meeting another connection's lock threw « database is locked » at once (test/burst.test.mjs, macOS runner).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdtempSync, readFileSync, realpathSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { openDatabase } from '../lib/sqlite.mjs';

const ROOT = path.join(path.dirname(new URL(import.meta.url).pathname), '..');

test('openDatabase sets the busy timeout by pragma, not only by the option a Node 22.13 ignores', () => {
  const db = openDatabase(':memory:');
  assert.equal(db.prepare('pragma busy_timeout').get().timeout, 5000);
  db.close();
  const short = openDatabase(':memory:', 1234);
  assert.equal(short.prepare('pragma busy_timeout').get().timeout, 1234);
  short.close();
});

test('a write waits for another process that holds the lock, instead of « database is locked »', async () => {
  const file = path.join(realpathSync(mkdtempSync(path.join(tmpdir(), 'calmdev-sqlite-'))), 'db.sqlite');
  const init = openDatabase(file); init.exec('create table t (x integer)'); init.close();
  // Another process takes the write lock, says so, and lets go 400 ms later
  const holder = spawn(process.execPath, ['--no-warnings', '-e', `
    const { DatabaseSync } = require('node:sqlite');
    const d = new DatabaseSync(${JSON.stringify(file)}); d.exec('begin immediate; insert into t values (1)');
    process.stdout.write('held\\n'); setTimeout(() => { d.exec('commit'); d.close(); }, 400);`], { stdio: ['ignore', 'pipe', 'inherit'] });
  await new Promise((r) => holder.stdout.once('data', r));
  const db = openDatabase(file);
  db.prepare('insert into t values (2)').run(); // blocks until the holder commits
  assert.deepEqual(db.prepare('select x from t order by x').all().map((r) => r.x), [1, 2]);
  db.close();
  await new Promise((r) => holder.once('exit', r));
});

test('the server opens its database through openDatabase', () => {
  const src = readFileSync(path.join(ROOT, 'server.mjs'), 'utf8');
  assert.match(src, /openDatabase\(DB_FILE\)/);
  assert.doesNotMatch(src, /new DatabaseSync\(/);
});
