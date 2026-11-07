// The terminal "Ouvrir dans un terminal" opens, and a PATH lookup. Pure: the platform, the environment and
// the lookup are passed in, so the tests run the Linux choices on a Mac (docs/linux.md).
//
//   which(name, env)                          → the full path of an executable on env.PATH, or null
//   pickTerminal({ platform, env, which, exists })
//     → { name, argv(cwd, cmd) → { file, args, detach } }   detach: the window outlives the call (spawn, unref)
//     → { name: null, error }                                no terminal known
//
// macOS: SM_TERMINAL (ghostty or terminal), else Ghostty if installed, else Terminal.app.
// Linux: SM_TERMINAL if given, then a new tmux window inside tmux (TMUX set), kitty, gnome-terminal, konsole, xterm.
import { accessSync, constants, existsSync } from 'node:fs';
import path from 'node:path';

export const which = (name, env = process.env) => {
  for (const dir of String(env.PATH || '').split(path.delimiter)) {
    if (!dir) continue;
    const file = path.join(dir, name);
    try { accessSync(file, constants.X_OK); return file; } catch {}
  }
  return null;
};

export const LINUX_TERMINALS = ['kitty', 'gnome-terminal', 'konsole', 'xterm'];
const q = (v) => `'${String(v).replace(/'/g, `'\\''`)}'`;

// One window per terminal on Linux: the command runs in the folder, then a login shell stays open
const linuxArgv = (name, env) => (cwd, cmd) => {
  const sh = env.SHELL && /^[\w./-]+$/.test(env.SHELL) ? env.SHELL : 'sh';
  const inner = `cd ${q(cwd)} && ${cmd}; exec ${sh} -l`;
  const run = [sh, '-lic', inner];
  switch (name) {
    case 'tmux': return { file: 'tmux', args: ['new-window', '-c', cwd, ...run], detach: false };
    case 'kitty': return { file: 'kitty', args: ['--detach', '--directory', cwd, ...run], detach: true };
    case 'gnome-terminal': return { file: 'gnome-terminal', args: [`--working-directory=${cwd}`, '--', ...run], detach: true };
    case 'konsole': return { file: 'konsole', args: ['--workdir', cwd, '-e', ...run], detach: true };
    case 'ghostty': return { file: 'ghostty', args: [`--working-directory=${cwd}`, '-e', ...run], detach: true };
    default: return { file: name, args: ['-e', ...run], detach: true }; // xterm, and any terminal that takes -e
  }
};

const macArgv = (name) => (cwd, cmd) => {
  if (name === 'ghostty') return { file: 'open', args: ['-na', 'Ghostty.app', '--args', `--working-directory=${cwd}`, '-e', 'zsh', '-lic', `${cmd}; exec zsh -l`], detach: false };
  const line = `cd ${q(cwd)} && ${cmd}`;
  const script = `tell application "Terminal"\n activate\n do script "${line.replace(/\\/g, '\\\\').replace(/"/g, '\\"')}"\nend tell`;
  return { file: 'osascript', args: ['-e', script], detach: false };
};

export const pickTerminal = ({ platform = process.platform, env = process.env, which: lookup = (n) => which(n, env), exists = existsSync } = {}) => {
  const asked = (env.SM_TERMINAL || '').trim();
  if (platform === 'darwin') {
    const name = asked === 'ghostty' || asked === 'terminal' ? asked : exists('/Applications/Ghostty.app') ? 'ghostty' : 'terminal';
    return { name, argv: macArgv(name) };
  }
  if (asked) {
    if (!/^[\w.-]+$/.test(asked) || !lookup(asked)) return { name: null, error: `Terminal introuvable : SM_TERMINAL=${asked} n’est pas sur le PATH` };
    return { name: asked, argv: linuxArgv(asked, env) };
  }
  if (env.TMUX && lookup('tmux')) return { name: 'tmux', argv: linuxArgv('tmux', env) };
  const found = LINUX_TERMINALS.find((n) => lookup(n));
  if (found) return { name: found, argv: linuxArgv(found, env) };
  return { name: null, error: `Aucun terminal connu (tmux, ${LINUX_TERMINALS.join(', ')}) : SM_TERMINAL=<ton terminal> ./run.sh` };
};
