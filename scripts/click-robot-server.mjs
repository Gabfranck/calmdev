// The throwaway seeded server of the click robot (phase 10, session F): own database, plans folder, home and
// transcripts, claude replaced by /usr/bin/false so no session can ever start, seeded by test/seed-flow.mjs. Kept apart
// from the browser part so a test can start it without a browser.
import { spawn } from 'node:child_process';
import { createServer } from 'node:net';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

const ROOT = path.resolve(path.dirname(new URL(import.meta.url).pathname), '..');
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

export const freePort = () => new Promise((resolve, reject) => {
  const s = createServer(); s.once('error', reject);
  s.listen(0, '127.0.0.1', () => { const { port } = s.address(); s.close(() => resolve(port)); });
});

export const serverEnv = ({ port, seedDir, tmp, base = process.env }) => ({
  ...base, PORT: String(port), ESCADRILLE_DB: path.join(tmp, 'robot.sqlite'), ESCADRILLE_PLANS: path.join(tmp, 'plans'),
  ESCADRILLE_HOME: path.join(tmp, 'home'), ESCADRILLE_TRANSCRIPTS_DIR: path.join(tmp, 'transcripts'), ESCADRILLE_CLAUDE_PROJECTS: path.join(tmp, 'projects'),
  ESCADRILLE_TRANSCRIPTS: path.join(tmp, 'usage-projects'), ESCADRILLE_SESSIONS: path.join(tmp, 'usage-sessions'),
  ESCADRILLE_CLAUDE: '/usr/bin/false', ESCADRILLE_SEED_ROOT: seedDir,
});

export const startServer = async ({ port, seedDir, env: baseEnv }) => {
  const tmp = mkdtempSync(path.join(tmpdir(), 'escadrille-robot-'));
  const env = serverEnv({ port, seedDir, tmp, base: baseEnv });
  const child = spawn(process.execPath, ['--no-warnings', path.join(ROOT, 'server.mjs')], { cwd: ROOT, env, stdio: ['ignore', 'ignore', 'pipe'] });
  let err = ''; child.stderr.on('data', (d) => { err += d; });
  const base = `http://127.0.0.1:${port}`;
  const stop = () => new Promise((resolve) => {
    const clean = () => { try { rmSync(tmp, { recursive: true, force: true }); } catch { /* best effort */ } resolve(); };
    if (child.exitCode !== null || child.signalCode) return clean();
    child.once('exit', clean); child.kill('SIGTERM');
  });
  try { await ready(child, base, () => err, env); } catch (e) { await stop(); throw e; }
  return { base, stop };
};

const ready = async (child, base, errOf, env) => {
  for (let i = 0; ; i++) {
    if (child.exitCode !== null) throw new Error(`the test server stopped: ${errOf().slice(-300)}`);
    try { if ((await fetch(base + '/api/plans')).ok) break; } catch { /* not yet */ }
    if (i > 200) throw new Error('the test server did not answer in 20 s');
    await sleep(100);
  }
  await new Promise((resolve, reject) => {
    const seed = spawn(process.execPath, ['--no-warnings', path.join(ROOT, 'test', 'seed-flow.mjs')], { cwd: ROOT, env, stdio: 'ignore' });
    seed.on('exit', (c) => (c === 0 ? resolve() : reject(new Error(`seed-flow exited ${c}`)))); seed.on('error', reject);
  });
};

