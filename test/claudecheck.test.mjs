// The home says when Claude Code is missing: lib/claudecheck.mjs, and GET /api/projects carries it.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { testEnv } from './test-env.mjs';
import { mkdtempSync, writeFileSync, chmodSync, realpathSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { claudeStatus, INSTALL_COMMAND } from '../lib/claudecheck.mjs';
import { freePort } from './free-port.mjs';

const ROOT = path.join(path.dirname(new URL(import.meta.url).pathname), '..');
const tmp = () => realpathSync(mkdtempSync(path.join(tmpdir(), 'escadrille-claudecheck-')));

test('claudeStatus: a path, the PATH, and what is missing', () => {
  const d = tmp();
  try {
    const bin = path.join(d, 'claude'); writeFileSync(bin, '#!/bin/sh\n'); chmodSync(bin, 0o755);
    assert.deepEqual(claudeStatus({ ESCADRILLE_CLAUDE: bin }), { found: true, command: INSTALL_COMMAND });
    assert.equal(claudeStatus({ PATH: d }).found, true);
    assert.equal(claudeStatus({ ESCADRILLE_CLAUDE: path.join(d, 'absent') }).found, false);
    assert.equal(claudeStatus({ PATH: path.join(d, 'nothing') }).found, false);
  } finally { rmSync(d, { recursive: true, force: true }); }
});

test('GET /api/projects says whether claude is there; the home has a line for it', async () => {
  const d = tmp(), port = freePort();
  const child = spawn(process.execPath, ['--no-warnings', path.join(ROOT, 'server.mjs')], { cwd: ROOT, stdio: 'ignore',
    env: { ...testEnv(), ESCADRILLE_GATE: 'off', PORT: String(port), HOME: d, ESCADRILLE_DB: path.join(d, 'db.sqlite'), ESCADRILLE_PLANS: path.join(d, 'plans'), ESCADRILLE_PROJECTS: path.join(d, 'p.json'), ESCADRILLE_CLAUDE: path.join(d, 'absent') } });
  try {
    let got; for (let i = 0; i < 60 && !got; i++) { try { got = await (await fetch(`http://127.0.0.1:${port}/api/projects`)).json(); } catch { await new Promise((r) => setTimeout(r, 200)); } }
    assert.deepEqual(got.claude, { found: false, command: INSTALL_COMMAND });
  } finally { child.kill('SIGKILL'); rmSync(d, { recursive: true, force: true }); }
  const js = (await import('node:fs')).readFileSync(path.join(ROOT, 'public/mainchat.js'), 'utf8');
  assert.match(js, /meta\.claude\.found === false/);
  for (const l of ['fr', 'en']) assert.ok(JSON.parse((await import('node:fs')).readFileSync(path.join(ROOT, `public/i18n/${l}.json`), 'utf8'))['main.noClaude']);
});
