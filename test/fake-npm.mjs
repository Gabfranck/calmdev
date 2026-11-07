// A fake npm for the tests (the sandbox of a session cannot run the real one): `npm run <script>` runs that
// script of the package.json in its cwd with sh, and ignores SIGTERM itself, as npm may; and a project
// whose dev script serves on a spare port and prints its URL the way Vite does (colours included).
import { mkdtempSync, writeFileSync, chmodSync, realpathSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

// A fake npm: `npm run dev` runs the dev script of the package.json in its cwd with sh
export const fakeNpm = () => {
  const dir = realpathSync(mkdtempSync(path.join(tmpdir(), 'escadrille-npm-'))); const file = path.join(dir, 'npm');
  writeFileSync(file, `#!/usr/bin/env node
const { spawn } = require('node:child_process'); const fs = require('node:fs');
const script = JSON.parse(fs.readFileSync('package.json', 'utf8')).scripts[process.argv[3]];
const c = spawn('/bin/sh', ['-c', script], { stdio: 'inherit' }); c.on('exit', (code) => process.exit(code ?? 1));
process.on('SIGTERM', () => {});
`); chmodSync(file, 0o755);
  return file;
};
// A project whose dev script serves on a spare port and prints its URL the way Vite does
export const devProject = (dir, { url = true } = {}) => {
  writeFileSync(path.join(dir, 'package.json'), JSON.stringify({ name: 'jetable', scripts: { dev: 'node dev.js' } }));
  writeFileSync(path.join(dir, 'dev.js'), url
    ? `require('node:http').createServer((q, s) => s.end('dev ok')).listen(0, '127.0.0.1', function () { console.log('\\x1b[32m  VITE ready\\x1b[0m'); console.log('  \\u279c  Local:   \\x1b[36mhttp://localhost:' + this.address().port + '/\\x1b[0m'); });`
    : `console.log('starting, no url'); setInterval(() => {}, 1000);`);
  return dir;
};

