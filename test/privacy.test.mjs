// The developer's private life never leaves the Mac (lib/privacy.mjs, a protected guardrail).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as P from '../lib/privacy.mjs';

const ctx = P.context({ home: '/Users/jdoe', names: ['Jane Doe', 'jane.doe@example.org'], projects: ['/Users/jdoe/Dev/Acme/acme-web', '/Users/jdoe/Dev/escadrille'] });

test('redact: secrets, home, e-mail, phone, LAN, name, other projects', () => {
  const r = P.redact('key=abcdef123456 sk-ant-abcdefghijklmnopqrst /Users/jdoe/Dev/x ?project=%2FUsers%2Fjdoe%2FDev jane.doe@example.org 06 12 34 56 78 192.168.1.2 Jane Doe, Jane Do… acme-web and Acme, escadrille stays', ctx);
  for (const leak of ['abcdef123456', 'sk-ant', '/Users/jdoe', 'example.org', '06 12', '192.168', 'Jane', 'acme-web', 'Acme']) assert.ok(!r.includes(leak), leak + ' in ' + r);
  assert.match(r, /escadrille stays/); assert.match(r, /~\/Dev\/x/);
});

test('privateTopic withholds a message about the developer\'s life, not a technical one', () => {
  assert.ok(P.privateTopic('mon TJM pour la mission de janvier')); assert.ok(P.privateTopic('my wife says'));
  assert.ok(!P.privateTopic('the HTTP client retries the merge gate'));
});

test('scan: what forbids a push as is', () => {
  assert.deepEqual(P.scan('const x = 1;', ctx), []);
  assert.deepEqual(P.scan('cwd: "/Users/jdoe/Dev/app"', ctx).map((f) => f.kind), ['home']);
  assert.ok(P.scan('Authorization: Bearer abcdefghijklmnopqrstuvwx', ctx).some((f) => f.kind === 'secret'));
});
