// The base of the environment a test gives the server it spawns: the caller's process.env without any CALMDEV_* or
// ESCADRILLE_* (a pilot's shell or a session carries ESCADRILLE_HOST, ESCADRILLE_PROJECTS, ESCADRILLE_SUPERVISED, a
// budget…), then ESCADRILLE_HOST=127.0.0.1. The test spreads it first and writes its own values after: `{ ...testEnv(), PORT, … }`.
export const testEnv = () => ({
  ...Object.fromEntries(Object.entries(process.env).filter(([k]) => !k.startsWith('ESCADRILLE_') && !k.startsWith('CALMDEV_'))),
  ESCADRILLE_HOST: '127.0.0.1',
});
