// The server's side of « who has to act » (public/todo.js, one source for the pages and the server), and the presence
// of a pilot on a project: the built-in one when it is on, or an external one (a Claude Code conversation driving the
// API) that declares itself with POST /api/pilot { project, external: true } and renews it with its calls; it goes out
// alone after EXTERNAL_TTL_MS without a call. Nothing is stored: a server restart forgets the external pilots, and the
// next call declares them again.
//   needsDev(opts)                       public/todo.js
//   createPresence({ ttlMs, now })       { touch(project), present(project), external(project), until(project) }
import { createRequire } from 'node:module';
import path from 'node:path';

const require = createRequire(import.meta.url);
const shared = require(path.join(path.dirname(new URL(import.meta.url).pathname), '..', 'public', 'todo.js'));
export const needsDev = shared.needsDev;
export const items = shared.items;
export const PILOT_KINDS = shared.PILOT_KINDS;

export const EXTERNAL_TTL_MS = 5 * 60e3;
export const createPresence = ({ ttlMs = EXTERNAL_TTL_MS, now = Date.now } = {}) => {
  const seen = new Map(); // project → the time of the last call
  const external = (project) => { const t = seen.get(project); if (t === undefined) return false; if (now() - t > ttlMs) { seen.delete(project); return false; } return true; };
  return {
    touch(project) { seen.set(project, now()); return true; },
    forget(project) { seen.delete(project); },
    external,
    // present: the built-in pilot is on, or an external one called lately
    present(project, builtInOn = false) { return !!builtInOn || external(project); },
    until(project) { const t = seen.get(project); return t === undefined ? null : new Date(t + ttlMs).toISOString(); },
  };
};
