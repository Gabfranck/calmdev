// A TCP port nobody listens on, asked of the system (bind to port 0, read it, close) instead of drawn at random
// in a range: test files run in parallel, and two random draws in overlapping ranges, or one on a port a dev
// server already holds, made the servers of the tests fail to start. Synchronous, so it drops in where a
// constant stood; the system does not hand the same ephemeral port out twice in a row.
import { execFileSync } from 'node:child_process';

const CODE = "const s = require('node:net').createServer(); s.listen(0, '127.0.0.1', () => { process.stdout.write(String(s.address().port)); s.close(); });";

export const freePort = () => Number(execFileSync(process.execPath, ['-e', CODE], { encoding: 'utf8' }));
