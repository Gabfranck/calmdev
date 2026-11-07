// test/free-port.mjs: a port below the ephemeral ranges, claimed across processes, bindable (the Linux timeouts of the
// public CI, 7 November: a released ephemeral port was taken before the test's server bound it).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, realpathSync, utimesSync } from 'node:fs';
import { createServer } from 'node:net';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { freePort, claim, PORT_LOW, PORT_HIGH } from './free-port.mjs';

const tmp = () => realpathSync(mkdtempSync(path.join(tmpdir(), 'calmdev-ports-')));

test('freePort hands out a port below every ephemeral range (Linux from 32768, macOS from 49152)', () => {
  for (let i = 0; i < 5; i++) { const p = freePort(); assert.ok(p >= PORT_LOW && p <= PORT_HIGH && p < 32768, String(p)); }
});

test('a port is claimed once: a second caller, in any process, gets another one', () => {
  const dir = tmp();
  assert.equal(claim(25000, dir), true); assert.equal(claim(25000, dir), false, 'claimed already');
  // the same draw twice: the second freePort moves on to the next draw
  const a = freePort({ dir, random: () => 0.1 });
  const draws = [0.1, 0.9]; const b = freePort({ dir, random: () => draws.shift() });
  assert.notEqual(a, b); assert.equal(b, PORT_LOW + Math.floor(0.9 * (PORT_HIGH - PORT_LOW + 1)));
});

test('a stale claim (a run that died long ago) is free again', () => {
  const dir = tmp(); assert.equal(claim(26000, dir), true);
  const old = (Date.now() - 20 * 60e3) / 1000; utimesSync(path.join(dir, '26000'), old, old);
  assert.equal(claim(26000, dir), true);
});

test('a port something already listens on is skipped', async () => {
  const s = createServer(); await new Promise((r) => s.listen(0, '127.0.0.1', r));
  const busy = s.address().port; const dir = tmp();
  // first draw lands on the busy port when it is in the range; either way the answer is not the busy port
  const target = busy >= PORT_LOW && busy <= PORT_HIGH ? (busy - PORT_LOW) / (PORT_HIGH - PORT_LOW + 1) : 0.3;
  let n = 0; const p = freePort({ dir, random: () => (n++ === 0 ? target + 1e-9 : 0.6) });
  assert.notEqual(p, busy);
  s.close();
});
