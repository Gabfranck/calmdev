// Opens a SQLite file with a busy timeout that holds on every supported Node. The `timeout` option of DatabaseSync only
// exists since Node 22.16: Node 22.13 (the minimum, and the CI's) ignores it without a word, and a write that meets a
// reader's lock throws « database is locked » at once (the public CI, 7 November, test/burst.test.mjs on macOS).
// The pragma does the same on every version; the option is kept for the versions that read it.
import { DatabaseSync } from 'node:sqlite';

export const BUSY_MS = 5000;

export function openDatabase(file, ms = BUSY_MS) {
  const db = new DatabaseSync(file, { timeout: ms });
  db.exec(`pragma busy_timeout = ${Number(ms) | 0}`);
  return db;
}
