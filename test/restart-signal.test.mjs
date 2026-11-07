// A restart from a shell (7 November): a HUP to the node process exits with 75 under ./run.sh (ESCADRILLE_SUPERVISED=1),
// so run.sh starts the server again and stays; not supervised, a HUP stops it with 0, like a TERM.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { freePort } from './free-port.mjs';
import { testEnv } from './test-env.mjs';

const ROOT = path.join(path.dirname(new URL(import.meta.url).pathname), '..');

const exitOnHup = async (supervised) => {
  const dir = mkdtempSync(path.join(tmpdir(), 'hup-')); mkdirSync(path.join(dir, 'home'));
  const port = freePort();
  const env = { ...testEnv(), ESCADRILLE_GATE: 'off', PORT: String(port), ESCADRILLE_DB: path.join(dir, 'db.sqlite'), ESCADRILLE_PLANS: path.join(dir, 'plans'), ESCADRILLE_HOME: path.join(dir, 'home'), ESCADRILLE_LEARNING: '0', ESCADRILLE_TRANSCRIPTS: path.join(dir, 'transcripts'), ...(supervised ? { ESCADRILLE_SUPERVISED: '1' } : {}) };
  const p = spawn(process.execPath, [path.join(ROOT, 'server.mjs')], { env, stdio: 'ignore' });
  const exited = new Promise((r) => p.once('exit', (code) => r(code)));
  let up = false;
  for (let i = 0; i < 100 && !up; i++) { try { await fetch(`http://127.0.0.1:${port}/api/projects`); up = true; } catch { await new Promise((r) => setTimeout(r, 100)); } }
  if (!up) { p.kill('SIGKILL'); throw new Error('server did not start'); }
  p.kill('SIGHUP');
  return exited;
};

test('a HUP under run.sh exits with 75, the supervisor restarts the server', { timeout: 30e3 }, async () => {
  assert.equal(await exitOnHup(true), 75);
});

test('a HUP without supervisor stops the server with 0', { timeout: 30e3 }, async () => {
  assert.equal(await exitOnHup(false), 0);
});
