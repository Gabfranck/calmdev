// The Mac's vital signs and the dev apps listening (lib/vitals.mjs): the parsers and the caches, no real ps, lsof or vm_stat.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseVmStat, parseListen, cpuBusy, listeners, vitals, _reset } from '../lib/vitals.mjs';

test('vm_stat: active, wired and compressed pages times the page size', () => {
  const t = 'Mach Virtual Memory Statistics: (page size of 16384 bytes)\nPages free:      1000.\nPages active:     100.\nPages inactive:   50.\nPages wired down:  20.\nPages occupied by compressor:  10.\n';
  assert.equal(parseVmStat(t), 130 * 16384);
  assert.equal(parseVmStat('nonsense'), null);
});

test('cpu: the busy share between two samples', () => {
  const a = [{ times: { user: 100, nice: 0, sys: 100, idle: 800, irq: 0 } }];
  const b = [{ times: { user: 150, nice: 0, sys: 150, idle: 900, irq: 0 } }];
  assert.equal(cpuBusy(a, b), 50);
  assert.equal(cpuBusy(a, a), null);
});

test('lsof listeners: dev commands only, local binds, port ≥ 1024, one per port', () => {
  const t = ['p10', 'cnode', 'f20', 'n*:5173', 'f21', 'n[::1]:5173', 'p11', 'crapportd', 'n*:49152', 'p12', 'ccom.docke', 'n127.0.0.1:8080',
    'p13', 'cnode', 'n192.168.1.4:4000', 'p14', 'cpython3.12', 'n*:80', 'p15', 'cpython3.12', 'n*:8000'].join('\n');
  assert.deepEqual(parseListen(t).map((s) => [s.pid, s.port]), [[15, 8000], [10, 5173], [12, 8080]].sort((a, b) => a[1] - b[1]));
});

test('listeners(): itself left out, cwd read, cached 10 s, [] when lsof is refused', async () => {
  _reset(); let calls = 0; let now = 1000;
  const run = async (cmd, args) => { calls++; return args.includes('-d') ? 'p10\nfcwd\nn/w/app\n' : 'p10\ncnode\nn*:5173\np99\ncnode\nn*:3078\n'; };
  const l = await listeners({ run, self: 99, now: () => now });
  assert.deepEqual(l, [{ pid: 10, command: 'node', port: 5173, url: 'http://localhost:5173', cwd: '/w/app' }]);
  await listeners({ run, self: 99, now: () => now + 5000 }); assert.equal(calls, 2);
  _reset(); assert.deepEqual(await listeners({ run: async () => { throw new Error('refused'); } }), []);
});

test('vitals(): memory, processor, server and claude in one answer', async () => {
  _reset();
  const v = await vitals({ claude: 7, platform: 'linux', total: 1000, free: () => 250, cpus: () => [{ times: { user: 1, nice: 0, sys: 1, idle: 1, irq: 0 } }, { times: { user: 1, nice: 0, sys: 1, idle: 1, irq: 0 } }], load: () => [1, 0.5, 0.25], rss: () => 42, now: () => 0 });
  assert.deepEqual([v.mem.pct, v.cpu.pct, v.cpu.cores, v.server.rss, v.claude], [75, 50, 2, 42, 7]);
});
