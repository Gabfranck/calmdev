#!/usr/bin/env node
// `npx github:Gabfranck/calmdev` (or `calmdev` once installed): runs the package's install.sh from the current folder,
// which becomes one of calmdev's projects. Options go through as they are: --check, --no-open, --tab, --lan.
// The code of an npx run lives in npm's cache, which npm may empty: the database and the plans go to
// ~/.config/calmdev (next to projects.json) through CALMDEV_DB and CALMDEV_PLANS, unless the developer already set them.
import { spawn } from 'node:child_process';
import { mkdirSync } from 'node:fs';
import { homedir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const dataDir = path.join(homedir(), '.config', 'calmdev');
const env = { ...process.env };
const set = (name, value) => { if (env['CALMDEV_' + name] === undefined && env['ESCADRILLE_' + name] === undefined) env['CALMDEV_' + name] = value; };

try {
  mkdirSync(path.join(dataDir, 'plans'), { recursive: true });
  set('DB', path.join(dataDir, 'sessions.sqlite'));
  set('PLANS', path.join(dataDir, 'plans'));
} catch (e) {
  console.error(`calmdev: ${dataDir} is not writable (${e.message}); the data stays in the package folder and may be lost.`);
}
// install.sh and run.sh call `node`: the one running this file comes first
env.PATH = path.dirname(process.execPath) + path.delimiter + (env.PATH || '');

const child = spawn(path.join(root, 'install.sh'), process.argv.slice(2), { cwd: process.cwd(), env, stdio: 'inherit' });
for (const sig of ['SIGINT', 'SIGTERM', 'SIGHUP']) process.on(sig, () => child.kill(sig));
child.on('error', (e) => { console.error('calmdev: cannot run install.sh: ' + e.message); process.exit(1); });
child.on('exit', (code, signal) => process.exit(code ?? (signal ? 130 : 1)));
