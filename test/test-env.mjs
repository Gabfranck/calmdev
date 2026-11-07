// The base of the environment a test gives the server it spawns: the caller's process.env without any CALMDEV_* or
// ESCADRILLE_* (a pilot's shell or a session carries ESCADRILLE_HOST, ESCADRILLE_PROJECTS, ESCADRILLE_SUPERVISED, a
// budget…), then ESCADRILLE_HOST=127.0.0.1. The test spreads it first and writes its own values after: `{ ...testEnv(), PORT, … }`.
// NODE_OPTIONS loads test/parent-guard.mjs: the server stops when its test dies, however it dies.
import { fileURLToPath } from 'node:url';

const GUARD = fileURLToPath(new URL('./parent-guard.mjs', import.meta.url));
export const withGuard = (env = process.env) => `${env.NODE_OPTIONS ? env.NODE_OPTIONS + ' ' : ''}--import=${GUARD}`;

export const testEnv = () => ({
  ...Object.fromEntries(Object.entries(process.env).filter(([k]) => !k.startsWith('ESCADRILLE_') && !k.startsWith('CALMDEV_'))),
  ESCADRILLE_HOST: '127.0.0.1',
  NODE_OPTIONS: withGuard(),
});
