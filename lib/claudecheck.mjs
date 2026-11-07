// Is Claude Code there? Same binary as the sessions (ESCADRILLE_CLAUDE, else `claude` on the PATH); the home says
// so when it is not, with the command that installs it (install.sh says the same in the terminal).
import { accessSync, constants } from 'node:fs';
import path from 'node:path';
import { envVar } from './names.mjs';

export const INSTALL_COMMAND = 'curl -fsSL https://claude.ai/install.sh | bash'; // shown, never run by Escadrille

const runnable = (f) => { try { accessSync(f, constants.X_OK); return true; } catch { return false; } };

export const claudeStatus = (env = process.env) => {
  const bin = envVar('CLAUDE', env) || 'claude';
  const found = bin.includes('/') ? runnable(bin) : String(env.PATH || '').split(path.delimiter).some((d) => d && runnable(path.join(d, bin)));
  return { found, command: INSTALL_COMMAND };
};
