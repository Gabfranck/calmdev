// A TCP port for a test's server: free when asked, and promised to that caller alone until its server binds it.
// Synchronous, so it drops in where a constant stood.
//
// History. A random draw in a range first: test files run in parallel, two draws met, or one fell on a port a dev
// server held. Then the system's choice (bind to port 0, read it, close): fine on macOS, which hands its ephemeral ports
// out in order, but not on Linux (the public CI, 7 November: api.test and qa.test timed out on ubuntu-latest only). Linux
// draws its ephemeral ports at random and gives the same range to outgoing connections, the tests' own fetch calls
// included: between the close and the server's listen (a Node start, ~200 ms), another file's server or a client socket
// could take the port, the test's server died on EADDRINUSE, and the test went on talking to whatever answered there.
//
// Now: a port below every system's ephemeral range (Linux 32768-60999, macOS 49152-65535), so no outgoing connection
// ever takes it; claimed across processes by an atomic mkdir in the temporary folder (a claim older than STALE_MS is
// free again); and checked bindable on 127.0.0.1 before it is handed out.
import { execFileSync } from 'node:child_process';
import { mkdirSync, rmdirSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

export const PORT_LOW = 20000;
export const PORT_HIGH = 32767;
const CLAIMS = path.join(tmpdir(), 'calmdev-test-ports');
const STALE_MS = 15 * 60e3;
const BINDS = "const s = require('node:net').createServer(); s.once('error', () => process.stdout.write('no')); s.listen(Number(process.argv[1]), '127.0.0.1', () => { process.stdout.write('ok'); s.close(); });";

const bindable = (port) => execFileSync(process.execPath, ['-e', BINDS, String(port)], { encoding: 'utf8' }) === 'ok';

// true when this process now holds the claim on the port
export const claim = (port, dir = CLAIMS, now = Date.now()) => {
  mkdirSync(dir, { recursive: true });
  const f = path.join(dir, String(port));
  try { mkdirSync(f); return true; } catch (e) { if (e.code !== 'EEXIST') throw e; }
  try { if (now - statSync(f).mtimeMs < STALE_MS) return false; rmdirSync(f); mkdirSync(f); return true; } catch { return false; }
};

export const freePort = ({ dir = CLAIMS, random = Math.random } = {}) => {
  for (let i = 0; i < 200; i++) {
    const port = PORT_LOW + Math.floor(random() * (PORT_HIGH - PORT_LOW + 1));
    if (claim(port, dir) && bindable(port)) return port;
  }
  throw new Error(`no free port between ${PORT_LOW} and ${PORT_HIGH} after 200 draws`);
};
