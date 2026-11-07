// The install firewall (Dev, 2026-11-02): a developer who only installed Escadrille (a clone of the official repository)
// does not have it modify itself for now. Planning or launching a session on Escadrille's own repository is refused;
// the other projects are untouched.
//
//   selfEdit(root)   { allowed, why }: may sessions write in this checkout of Escadrille?
//
// Open when one of these holds:
//   - ESCADRILLE_SELF_EDIT=1 in the server's environment;
//   - a file `maintainer` in ~/.config/escadrille (ESCADRILLE_GUARD_DIR for the tests): the maintainers' Macs, outside
//     the repository and outside the sessions' sandbox;
//   - the checkout's origin is not the official repository (a fork, another remote, no remote at all).
// A soft firewall, not a security boundary: whoever edits the code by hand or removes the remote chooses to fork.
import { execFileSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { homedir } from 'node:os';
import path from 'node:path';
import { envVar, configDirIn } from './names.mjs';

export const UPSTREAM = /github\.com[:/]+gabfranck\/escadrille(\.git)?\/?$/i;
const dirOf = (env) => envVar('GUARD_DIR', env) || configDirIn(homedir());
const origin = (root) => { try { return execFileSync('git', ['remote', 'get-url', 'origin'], { cwd: root, timeout: 5000, stdio: ['ignore', 'pipe', 'ignore'] }).toString().trim(); } catch { return ''; } };

export const selfEdit = (root, { env = process.env } = {}) => {
  if (envVar('SELF_EDIT', env) === '1') return { allowed: true, why: 'env' };
  if (existsSync(path.join(dirOf(env), 'maintainer'))) return { allowed: true, why: 'maintainer' };
  const url = origin(root);
  if (!UPSTREAM.test(url)) return { allowed: true, why: url ? 'fork' : 'no-origin' };
  return { allowed: false, why: 'install' };
};

export const REFUSAL = "calmdev ne se modifie pas lui-même depuis une simple installation, pour l'instant. Pour y contribuer, forke le dépôt et clone ton fork (CONTRIBUTING.md).";
