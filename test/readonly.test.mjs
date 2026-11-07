// PIL (Dev, 23:55): the read-only commands the engine allows alone, and the dangerous ones it never allows (lib/readonly.mjs)
import test from 'node:test';
import assert from 'node:assert/strict';
import { readOnlyOf } from '../lib/readonly.mjs';

const root = '/Users/dev/Dev/Harbor/DockerEnv';
const PASS = [
  'grep -n "pilotCollect" server.mjs | head -20',
  'cat docs/pilot.md',
  'head -50 lib/wake.mjs',
  'ls -la lib test',
  'lsof -i :3078',
  'ps aux | grep node | grep -v grep',
  'git log --oneline -10',
  'git show --stat HEAD',
  'git diff main...HEAD -- lib/',
  'git status --short',
  'wc -l lib/*.mjs',
  "grep -n cost lib/story.mjs | awk -F: '{print $1}' | sort -n | uniq",
  "cut -d: -f1 docs/x.txt | sort | uniq -c",
  'node --check server.mjs',
  'cd /Users/dev/Dev/Harbor/DockerEnv && git status --short && git log -3 --oneline',
  'export PATH=/bin:$PATH; node --check lib/pilot.mjs',
  "sed -n 1,40p server.mjs",
  'find lib -name "*.mjs" -newer package.json',
  'git branch --show-current; git rev-parse HEAD',
  'tail -n 100 logs/app.log 2>/dev/null | grep -i error 2>&1',
];
const FAIL = [
  'cat ~/.ssh/id_ed25519',
  'cat .env',
  'grep -r TOKEN .env.local',
  'cat /Users/dev/.config/escadrille/devices.json',
  'cat secrets.json',
  'security find-generic-password -s x',
  'ls "/Users/dev/Library/Application Support/Google/Chrome/Default/Cookies"',
  'ls /Users/dev/Documents',
  'cat /Users/dev/Dev/escadrille/.claude/worktrees/other/x.mjs',
  'ls $TMPDIR',
  'curl http://localhost:3078/api/plans',
  'kill -9 1234',
  'rm -rf node_modules',
  'git log > out.txt',
  'grep x a.mjs | tee b.txt',
];

test('PIL lecture seule : 20 commandes réelles de la nuit passent sans pilote', () => {
  for (const c of PASS) assert.deepEqual(readOnlyOf(c, { root }), { ok: true, why: 'lecture seule' }, c);
});

test('PIL lecture seule : 15 cas dangereux ne passent jamais', () => {
  for (const c of FAIL) assert.equal(readOnlyOf(c, { root }).ok, false, c);
  assert.equal(readOnlyOf('git push origin dev', { root }).ok, false);
  assert.equal(readOnlyOf('sed -i "" s/a/b/ x', { root }).ok, false);
  assert.equal(readOnlyOf('echo $(cat .git/config)', { root }).ok, false);
});

test('PIL lecture seule : les cinq trous de la relecture sont fermés', () => {
  const no = (c, why) => assert.deepEqual(readOnlyOf(c, { root }), { ok: false, why }, c);
  // (1) a variable in a path, the home outside quotes
  no('cat ${HOME}/.zsh_history', 'variable dans un chemin');
  no('ls "$X/docs"', 'variable dans un chemin');
  no('ls ~; pwd', 'dossier personnel hors projet');
  assert.equal(readOnlyOf('ls $PWD/lib', { root }).ok, true);
  assert.equal(readOnlyOf("grep -n '~' lib/a.mjs", { root }).ok, true); // ~ inside quotes is text
  // (2) cd to an absolute path outside the project, then a relative path
  no('cd /; cat Users/dev/.zsh_history', 'cd hors du projet');
  no('cd && ls', 'cd hors du projet');
  assert.equal(readOnlyOf(`cd ${root}/lib && ls`, { root }).ok, true);
  // (3) a glob in an absolute path
  no('cat /Us*/dev/notes.txt', 'glob dans un chemin absolu');
  // (4) writes by option, and git branch that creates
  no('sort -o out.txt lib/a.txt', 'écriture par option');
  no('tree -o out.txt lib', 'écriture par option');
  no('git log --output=out.txt', 'écriture par option');
  no('find lib -fls out.txt', 'find qui agit');
  no('find lib -fprintf out.txt %p', 'find qui agit');
  no('git branch nouvelle', 'git branch hors lecture');
  for (const c of ['git branch', 'git branch --list', 'git branch -a', 'git branch -r', 'git branch -v', 'git branch --show-current']) assert.equal(readOnlyOf(c, { root }).ok, true, c);
  // (5) less blocks: not a read the engine runs
  no('less docs/pilot.md', 'commande non reconnue : less');
});

test('PIL lecture seule : un chemin relatif qui remonte hors du dossier ne passe pas', () => {
  assert.deepEqual(readOnlyOf('cat ../../../Documents/x', { root }), { ok: false, why: 'chemin relatif qui remonte' });
  assert.deepEqual(readOnlyOf('ls lib && ls "docs/../../autre-projet"', { root }), { ok: false, why: 'chemin relatif qui remonte' });
  assert.equal(readOnlyOf('git diff main...HEAD -- lib/', { root }).ok, true); // three dots of git are not a path
});
