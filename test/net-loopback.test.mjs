// A curl or wget whose every URL is loopback is local for the server (isNetwork, which the pilot never answers when true)
// and for the pilot's policy (suggest); one external URL, or a network command chained to it, stays network.
// The defect of 2 November (docs/backlog.md, PERF and AUD): file names next to the curl were read as hosts.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { isNetwork } from '../lib/planner.mjs';
import { suggest } from '../lib/policy.mjs';
// Fake home folders are assembled at run time: scripts/trace-scan.mjs takes a written one for a real one.
const USERS = '/Users'; const HOMES = '/home';

const net = (command) => isNetwork('Bash', { command });
const pilot = (command) => suggest({ tool: 'Bash', input: { command }, cwd: process.cwd() });

const LOCAL = [
  `curl -s http://127.0.0.1:4123/api/flow | node -e "let s='';process.stdin.on('data',d=>s+=d).on('end',()=>console.log(JSON.parse(s).ok))"`,
  `curl -s http://127.0.0.1:4123/api/flow`,
  `curl -s 'http://[::1]:4123/api/flow'`,
  `curl -s http://[::1]:4123/api/flow`,
  `curl -s localhost:4123/api/flow`,
  `wget -qO- http://127.0.0.1:4123/api/flow`,
  `curl -s -H 'Content-Type: application/json' -X POST http://localhost:4123/api/memory -d '{"line":"voir docs/decisions.md sur github.com"}'`,
  `curl -s -H "Authorization: Bearer x" http://localhost:4123/api/flow`,
  `curl -s http://127.0.0.1:4123/api/flow | jq .`,
  `time curl -s -o /dev/null http://localhost:3078/api/projectflow?project=${USERS}/dev/Dev/escadrille`,
  `curl -s -o out.json http://127.0.0.1:4123/api/flow && node -e "console.log(require('./out.json'))"`,
  `curl -s http://127.0.0.1:4123/api/flow > out.json`,
  `node server.mjs & sleep 1; curl -s http://127.0.0.1:4123/api/flow`,
  `curl -s "http://127.0.0.1:4123/api/flow?a=1&b=2"`,
  `curl -s --max-time 5 http://127.0.0.1:4123/api/plan/x/session/y/reviewed -d @body.json`,
  `curl -s http://localhost:4123/a && git status`,
];
const NETWORK = [
  `curl -s https://example.com`,
  `curl -s http://127.0.0.1:4123/a && curl -s https://example.com`,
  `curl -s http://127.0.0.1:4123/x -o /dev/null https://github.com`,
  `curl -s http://127.0.0.1:4123/a && git push`,
  `curl -s http://127.0.0.1:4123/a; npm install`,
  `curl -s http://127.0.0.1:4123/a | node -e "fetch('https://example.com')"`,
  `curl -s $URL`,
  `curl -s http://127.0.0.1:4123/a && bash -c "cd x && git push"`,
  `curl -s http://127.0.0.1.example.com/`,
  `curl -s http://localhost@evil.example.com/`,
];

test('a curl or wget aimed only at loopback is local for the server', () => {
  for (const c of LOCAL) assert.equal(net(c), false, c);
});

test('one external URL or a chained network command stays network', () => {
  for (const c of NETWORK) assert.equal(net(c), true, c);
});

test('the pilot lets a loopback curl through and refuses an external one', () => {
  for (const c of LOCAL.slice(0, 9)) { const s = pilot(c); assert.equal(s.allow, true, `${c} → ${s.rule}`); }
  assert.equal(pilot(`curl -s http://127.0.0.1:4123/a && curl -s https://example.com`).allow, false);
  assert.equal(pilot(`curl -s http://127.0.0.1:4123/a && git push`).allow, false);
  assert.notEqual(pilot(`curl -s http://127.0.0.1:4123/a; npm install`).allow, true);
});
