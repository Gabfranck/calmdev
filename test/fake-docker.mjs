// A fake `docker` CLI for test/docker.test.mjs (docs/docker.md): a compose of five services, no Docker needed.
// FAKE_DOCKER_MODE: ok (default) | daemon (the daemon is stopped) | nocompose (no compose file in the folder)
// FAKE_DOCKER_PS: ndjson (default, compose ≥ 2.21) | array (older compose)
// FAKE_DOCKER_LOG: a file where each call's argv is appended as one JSON line
import { appendFileSync } from 'node:fs';

const args = process.argv.slice(2);
if (!args.length) process.exit(0); // `node --test` runs every file of test/: run alone, the fake has nothing to answer
if (process.env.FAKE_DOCKER_LOG) appendFileSync(process.env.FAKE_DOCKER_LOG, JSON.stringify({ args, cwd: process.cwd(), lan: process.env.LAN_IP || null }) + '\n');
const mode = process.env.FAKE_DOCKER_MODE || 'ok';
const out = (s) => process.stdout.write(s + '\n');
const fail = (s, code = 1) => { process.stderr.write(s + '\n'); process.exit(code); };

if (args[0] !== 'compose') fail(`fake docker: compose only (${args.join(' ')})`);
if (mode === 'daemon') fail('Cannot connect to the Docker daemon at unix:///var/run/docker.sock. Is the docker daemon running?');
if (mode === 'nocompose') fail('no configuration file provided: not found', 14);
let a = args.slice(1);
while (a[0] === '-f') a = a.slice(2);
const SERVICES = ['api', 'mysql', 'redis', 'student', 'web'];
const [cmd, ...rest] = a;
const svc = rest.filter((x) => !x.startsWith('-') && !/^\d+$/.test(x)).at(-1);
const need = (s) => { if (!SERVICES.includes(s)) fail(`no such service: ${s}`); };

const PS = [
  { Name: 'aq-api-1', Service: 'api', State: 'running', Health: 'healthy', Status: 'Up 2 minutes (healthy)', Publishers: [{ URL: '0.0.0.0', TargetPort: 3000, PublishedPort: 3050, Protocol: 'tcp' }, { URL: '::', TargetPort: 3000, PublishedPort: 3050, Protocol: 'tcp' }], Labels: 'x'.repeat(400) },
  { Name: 'aq-mysql-1', Service: 'mysql', State: 'running', Health: 'healthy', Status: 'Up 2 minutes (healthy)', Publishers: [{ URL: '', TargetPort: 3306, PublishedPort: 0, Protocol: 'tcp' }] },
  { Name: 'aq-redis-1', Service: 'redis', State: 'running', Health: '', Status: 'Up 2 minutes', Publishers: [] },
  { Name: 'aq-student-1', Service: 'student', State: 'exited', Health: '', Status: 'Exited (1) 1 minute ago', Ports: '' },
  { Name: 'aq-web-1', Service: 'web', State: 'running', Health: '', Status: 'Up 2 minutes', Ports: '0.0.0.0:8080->80/tcp, :::8080->80/tcp' },
];

switch (cmd) {
  case 'config': out(SERVICES.join('\n')); break;
  case 'ps': if (process.env.FAKE_DOCKER_PS === 'array') out(JSON.stringify(PS)); else for (const c of PS) out(JSON.stringify(c)); break;
  case 'logs': {
    need(svc);
    const tail = Number(rest[rest.indexOf('--tail') + 1]);
    for (let i = 1; i <= 300; i++) if (i > 300 - tail) out(`2026-11-02T10:00:${String(i % 60).padStart(2, '0')}Z ${svc}  | line ${i}${i === 300 ? ' DB_PASSWORD=hunter22 Authorization: Bearer abcdefgh12345678 mysql://root:s3cret@mysql/db' : ''}`);
    if (rest.includes('--follow')) { let n = 0; const t = setInterval(() => { out(`${svc}  | live ${++n}`); }, 30); process.on('SIGTERM', () => { clearInterval(t); process.exit(143); }); }
    break;
  }
  case 'restart': need(svc); process.stderr.write(` Container aq-${svc}-1  Restarting\n Container aq-${svc}-1  Started\n`); break;
  case 'stop': need(svc); process.stderr.write(` Container aq-${svc}-1  Stopped\n`); break;
  case 'up': need(svc); out(`#1 building ${svc}`); process.stderr.write(` Container aq-${svc}-1  Started\n`); break;
  case 'exec': { const i = rest.indexOf('-T'); const s = rest[i + 1]; need(s); const words = rest.slice(i + 2); out(`exec in ${s}: ${JSON.stringify(words)}`); out('API_SECRET=topsecret99'); if (words[0] === 'false') process.exit(3); break; }
  default: fail(`fake docker: unknown command ${cmd}`);
}
