// The keys of the connectors (docs/connectors.md), one file outside every repository:
// ~/.config/escadrille/secrets.json (ESCADRILLE_SECRETS for the tests), mode 0600 in a 0700 folder,
//   { "<project path>": { "linear": "<key>" } }
// Never in the database, never returned by a route, never logged. Not encrypted: an encryption with no
// secret beside it (no keychain, no password) would protect nothing. The sessions' sandbox cannot read the folder.
import { readFileSync, writeFileSync, existsSync, mkdirSync, chmodSync, renameSync } from 'node:fs';
import { homedir } from 'node:os';
import path from 'node:path';
import { envVar, configDirIn, CONFIG_LABEL } from './names.mjs';

export const SECRETS_DIR = CONFIG_LABEL;
export const fileOf = (env = process.env) => envVar('SECRETS', env) || configDirIn(homedir(), 'secrets.json');

const readAll = (file) => { try { return existsSync(file) ? JSON.parse(readFileSync(file, 'utf8')) || {} : {}; } catch { return {}; } };
const writeAll = (file, all) => {
  mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
  const tmp = file + '.tmp';
  writeFileSync(tmp, JSON.stringify(all, null, 1), { mode: 0o600 }); chmodSync(tmp, 0o600); renameSync(tmp, file);
};

export const get = (project, name, file = fileOf()) => { const v = readAll(file)[project]?.[name]; return typeof v === 'string' && v ? v : null; };
export const has = (project, name, file = fileOf()) => !!get(project, name, file);
export const set = (project, name, value, file = fileOf()) => {
  if (!project) throw new Error('un projet est requis');
  const v = String(value ?? '').trim(); if (!v) throw new Error(`${name} : une clé non vide, ou null pour l’effacer`);
  const all = readAll(file); all[project] = { ...(all[project] || {}), [name]: v }; writeAll(file, all);
};
export const clear = (project, name, file = fileOf()) => {
  const all = readAll(file); if (!all[project]?.[name]) return;
  delete all[project][name]; if (!Object.keys(all[project]).length) delete all[project]; writeAll(file, all);
};
