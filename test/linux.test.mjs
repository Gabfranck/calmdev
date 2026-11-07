// Linux without a Linux machine (docs/linux.md): the platform is passed in, the binaries are fakes in a
// throwaway folder put on the PATH. The sandbox settings, the sandbox check, the terminal choice, install.sh.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { mkdtempSync, writeFileSync, chmodSync, realpathSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { SANDBOX_SETTINGS, sandboxSettingsFor, sandboxSettings, sandboxStatus, startSession } from '../lib/planner.mjs';
import { defaultModel } from '../lib/models.mjs';
import { pickTerminal, which } from '../lib/terminal.mjs';

const ROOT = path.join(path.dirname(new URL(import.meta.url).pathname), '..');
const tmp = (p) => realpathSync(mkdtempSync(path.join(tmpdir(), p)));
// A folder of fake executables: { name: 'shell script body' }
const fakeBin = (files) => {
  const dir = tmp('escadrille-bin-');
  for (const [name, body] of Object.entries(files)) { const f = path.join(dir, name); writeFileSync(f, `#!/bin/sh\n${body}\n`); chmodSync(f, 0o755); }
  return dir;
};
const fakeWhich = (...names) => (n) => (names.includes(n) ? '/usr/bin/' + n : null);

test('sandboxSettingsFor: the same object on macOS, the same keys plus ~/.bashrc and ~/.profile on Linux', () => {
  assert.equal(sandboxSettingsFor('darwin'), sandboxSettingsFor('darwin'));
  assert.deepEqual(SANDBOX_SETTINGS, sandboxSettingsFor());
  const mac = sandboxSettingsFor('darwin'); const linux = sandboxSettingsFor('linux');
  assert.deepEqual(Object.keys(linux.sandbox), Object.keys(mac.sandbox));
  assert.deepEqual(linux.permissions, mac.permissions);
  assert.equal(linux.sandbox.failIfUnavailable, true);
  assert.deepEqual(linux.sandbox.filesystem.denyRead, [...mac.sandbox.filesystem.denyRead, '~/.bashrc', '~/.profile']);
  assert.ok(!mac.sandbox.filesystem.denyRead.includes('~/.bashrc'), 'macOS untouched');
  // A plan's domains still open on top of the platform's settings
  assert.deepEqual(sandboxSettings(['api.github.com']).sandbox.network.allowedDomains, ['api.github.com']);
});

test('sandboxStatus: Seatbelt on macOS, bwrap and socat on Linux, nothing elsewhere', () => {
  assert.equal(sandboxStatus({ platform: 'darwin', which: fakeWhich() }).ok, true);
  assert.equal(sandboxStatus({ platform: 'linux', which: fakeWhich('bwrap', 'socat') }).ok, true);
  const none = sandboxStatus({ platform: 'linux', which: fakeWhich('socat') });
  assert.equal(none.ok, false); assert.deepEqual(none.missing, ['bwrap']); assert.match(none.note, /bwrap absent du PATH.*bubblewrap/);
  assert.deepEqual(sandboxStatus({ platform: 'linux', which: fakeWhich() }).missing, ['bwrap', 'socat']);
  assert.equal(sandboxStatus({ platform: 'win32', which: fakeWhich('bwrap', 'socat') }).ok, false);
});

test('startSession refuses to start without the sandbox on Linux (bwrap missing from the PATH)', () => {
  const saved = process.env.PATH; process.env.PATH = fakeBin({ socat: 'exit 0' });
  try {
    assert.throws(() => startSession({ cwd: ROOT, model: defaultModel(), platform: 'linux', claude: '/nonexistent' }), /bac à sable indisponible : bwrap absent/);
  } finally { process.env.PATH = saved; }
});

test('which: an executable on the PATH, null otherwise', () => {
  const dir = fakeBin({ kitty: 'exit 0' });
  assert.equal(which('kitty', { PATH: `/nonexistent:${dir}` }), path.join(dir, 'kitty'));
  assert.equal(which('konsole', { PATH: dir }), null);
  assert.equal(which('kitty', { PATH: '' }), null);
});

test('pickTerminal on Linux: SM_TERMINAL, then tmux inside tmux, kitty, gnome-terminal, konsole, xterm', () => {
  const all = fakeWhich('tmux', 'kitty', 'gnome-terminal', 'konsole', 'xterm', 'alacritty');
  const pick = (env, w = all) => pickTerminal({ platform: 'linux', env, which: w });
  assert.equal(pick({ SM_TERMINAL: 'alacritty', TMUX: '/tmp/tmux' }).name, 'alacritty');
  assert.equal(pick({ TMUX: '/tmp/tmux-1000/default,1,0' }).name, 'tmux');
  assert.equal(pick({}).name, 'kitty', 'tmux is not chosen outside a tmux session');
  assert.equal(pick({}, fakeWhich('tmux', 'gnome-terminal', 'konsole')).name, 'gnome-terminal');
  assert.equal(pick({}, fakeWhich('konsole', 'xterm')).name, 'konsole');
  assert.equal(pick({}, fakeWhich('xterm')).name, 'xterm');
  assert.equal(pick({ TMUX: 'x' }, fakeWhich('xterm')).name, 'xterm', 'TMUX set but no tmux binary');
  const none = pick({}, fakeWhich());
  assert.equal(none.name, null); assert.match(none.error, /^Aucun terminal connu \(tmux, kitty, gnome-terminal, konsole, xterm\) : SM_TERMINAL=/);
  assert.match(pick({ SM_TERMINAL: 'wezterm' }, fakeWhich()).error, /SM_TERMINAL=wezterm/);
  assert.match(pick({ SM_TERMINAL: 'x; rm -rf /' }).error, /introuvable/);
});

test('pickTerminal: the command lines, the folder never in a shell word but quoted', () => {
  const env = { SHELL: '/bin/bash', TMUX: 'x' };
  const cwd = "/opt/dev/it's here"; const cmd = 'claude --resume abc';
  const at = (names) => pickTerminal({ platform: 'linux', env, which: fakeWhich(...names) }).argv(cwd, cmd);
  const inner = `cd '/opt/dev/it'\\''s here' && claude --resume abc; exec /bin/bash -l`;
  assert.deepEqual(at(['tmux']), { file: 'tmux', args: ['new-window', '-c', cwd, '/bin/bash', '-lic', inner], detach: false });
  const noTmux = (names) => pickTerminal({ platform: 'linux', env: { SHELL: '/bin/bash' }, which: fakeWhich(...names) }).argv(cwd, cmd);
  assert.deepEqual(noTmux(['kitty']), { file: 'kitty', args: ['--detach', '--directory', cwd, '/bin/bash', '-lic', inner], detach: true });
  assert.deepEqual(noTmux(['gnome-terminal']).args, [`--working-directory=${cwd}`, '--', '/bin/bash', '-lic', inner]);
  assert.deepEqual(noTmux(['konsole']).args, ['--workdir', cwd, '-e', '/bin/bash', '-lic', inner]);
  assert.deepEqual(noTmux(['xterm']).args, ['-e', '/bin/bash', '-lic', inner]);
  // An odd SHELL is not trusted
  assert.equal(pickTerminal({ platform: 'linux', env: { SHELL: '/bin/x;y' }, which: fakeWhich('xterm') }).argv(cwd, cmd).args[1], 'sh');
});

test('pickTerminal on macOS: SM_TERMINAL, else Ghostty if installed, else Terminal.app', () => {
  const mac = (env, ghostty) => pickTerminal({ platform: 'darwin', env, which: fakeWhich(), exists: () => ghostty });
  assert.equal(mac({}, true).name, 'ghostty');
  assert.equal(mac({}, false).name, 'terminal');
  assert.equal(mac({ SM_TERMINAL: 'terminal' }, true).name, 'terminal');
  assert.equal(mac({}, true).argv('/p', 'claude').file, 'open');
  assert.equal(mac({}, false).argv('/p', 'claude').file, 'osascript');
});

// install.sh with a PATH of fakes: /bin and /usr/bin for sed, cut, uname…, a fake folder first
const install = (args, bin) => new Promise((resolve) => execFile('/bin/sh', [path.join(ROOT, 'install.sh'), ...args], { env: { PATH: `${bin}:/usr/bin:/bin`, HOME: tmpdir() } },
  (err, stdout, stderr) => resolve({ code: err ? err.code : 0, out: stdout + stderr })));

test('install.sh --check: an old node and no claude fail, each with what to do', async () => {
  const { code, out } = await install(['--check'], fakeBin({ node: 'echo v20.11.1' }));
  assert.equal(code, 1, out);
  assert.match(out, /node 20\.11\.1 is too old: calmdev needs Node 22\.13 or later/);
  assert.match(out, /https:\/\/nodejs\.org/); assert.match(out, /nvm install 22/);
  assert.match(out, /Claude Code is not installed \(no 'claude' on your PATH\)/); assert.match(out, /curl -fsSL https:\/\/claude\.ai\/install\.sh \| bash/);
  assert.doesNotMatch(out, /All set/);
});

test('install.sh --check: node 22.12 is too old, 22.13 and claude pass; on Linux a missing bwrap warns', async () => {
  assert.match((await install(['--check'], fakeBin({ node: 'echo v22.12.0', claude: 'echo 2.1.316' }))).out, /node 22\.12\.0 is too old/);
  const linux = await install(['--check'], fakeBin({ node: 'echo v22.13.0', claude: 'echo "2.1.316 (Claude Code)"', uname: 'echo Linux', socat: 'exit 0' }));
  assert.equal(linux.code, 0, linux.out);
  assert.match(linux.out, /ok {4}node 22\.13\.0/); assert.match(linux.out, /ok {4}claude 2\.1\.316/);
  assert.match(linux.out, /warn {2}bwrap not found/); assert.match(linux.out, /ok {4}socat/); assert.match(linux.out, /All set/);
  const mac = await install(['--check'], fakeBin({ node: 'echo v24.1.0', claude: 'echo 2.1.316', uname: 'echo Darwin' }));
  assert.equal(mac.code, 0); assert.doesNotMatch(mac.out, /bwrap/);
  assert.equal((await install(['--bogus'], fakeBin({}))).code, 2);
});
