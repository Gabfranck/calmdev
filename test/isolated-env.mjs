// The environment of a server started by a test, the same inside a session's sandbox and outside it (the pilot's shell,
// the test box): run there, a test server inherited the caller's ESCADRILLE_* (ESCADRILLE_SUPERVISED, ESCADRILLE_PROJECTS,
// ESCADRILLE_SECRETS, a budget, a burst deadline…) and read the real home (~/.config/escadrille, ~/.claude, ~/.escadrille),
// which the sandbox hides. Every ESCADRILLE_* and PORT is dropped, HOME is a throwaway folder, and the server's readers of
// the home get their own throwaway paths; `extra` comes last.
import { mkdtempSync, realpathSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { withGuard } from './test-env.mjs';

const tmp = (p) => realpathSync(mkdtempSync(path.join(tmpdir(), p)));
const DROP = /^(ESCADRILLE_|CALMDEV_|SM_DB$|PORT$|NODE_TEST_CONTEXT$)/; // NODE_TEST_CONTEXT: a child under node --test would speak TAP to the runner

export const isolatedEnv = (extra = {}) => {
  const env = Object.fromEntries(Object.entries(process.env).filter(([k]) => !DROP.test(k)));
  const home = tmp('escadrille-home-');
  return {
    ...env,
    HOME: home,
    NODE_OPTIONS: withGuard(env), // the server stops when its test dies (test/parent-guard.mjs)
    // git still needs a name for the commits a test repo makes, without the developer's ~/.gitconfig
    GIT_AUTHOR_NAME: 't', GIT_AUTHOR_EMAIL: 't@t', GIT_COMMITTER_NAME: 't', GIT_COMMITTER_EMAIL: 't@t',
    ESCADRILLE_HOME: home,
    ESCADRILLE_GUARD_DIR: path.join(home, '.config', 'escadrille'),
    ESCADRILLE_SECRETS: path.join(home, '.config', 'escadrille', 'secrets.json'),
    ESCADRILLE_MODELS: path.join(home, '.escadrille', 'models.json'),
    ESCADRILLE_TRANSCRIPTS: tmp('escadrille-none-'),
    ESCADRILLE_SESSIONS: tmp('escadrille-none-'),
    ESCADRILLE_CLAUDE_PROJECTS: tmp('escadrille-ccp-'),
    ESCADRILLE_PUSH_URL: 'http://127.0.0.1:9/',
    ESCADRILLE_LEARNING: 'off',
    // The gate (docs/gate.md): a test server answers its test's bare fetches; NODE_TEST_CONTEXT is dropped above, so say it.
    // test/gate.test.mjs passes ESCADRILLE_GATE: 'on' to test the gate itself
    ESCADRILLE_GATE: 'off',
    ESCADRILLE_HOST: '127.0.0.1',
    ...extra,
  };
};
