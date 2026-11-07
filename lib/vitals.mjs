// The Mac's vital signs and the dev servers listening on it, in the answer of GET /api/running (no route of its own:
// docs/perf.md, a change reloads nothing more). Dev, 2 November: know at a glance whether opening the app or launching a
// burst will slow the Mac, without Activity Monitor; and open every front app that runs from the top bar.
//
//   vitals({ claude, run, cpus, mem, rss, now })  → Promise<{ mem: { used, total, pct }, cpu: { pct, load, cores }, server: { rss }, claude, at }>
//                                     mem from vm_stat (active + wired + compressed, what Activity Monitor calls used, roughly),
//                                     else os.freemem; cpu: the busy share of every core since the last call (5 s at least
//                                     apart), the load average before that; claude: the count the caller already has (ps)
//   listeners({ run, self })        → Promise<[{ pid, command, port, url, cwd }]>: the TCP servers listening on the Mac that
//                                     look like a dev app (node, bun, deno, python, ruby, php, java, Docker…), port ≥ 1024,
//                                     minus this server; cached 10 s; [] when lsof is missing or refused
//   parseVmStat(text), parseListen(text), cpuBusy(a, b)   the parsers, exported for the tests
import { execFile } from 'node:child_process';
import os from 'node:os';
import { parseLsof } from './running.mjs';

const execOut = (cmd, args) => new Promise((resolve, reject) => execFile(cmd, args, { timeout: 4000, maxBuffer: 4e6, env: { ...process.env, LC_ALL: 'C', LANG: 'C' } }, (err, out) => (err && !String(out || '').trim() ? reject(err) : resolve(String(out || '')))));

// "Mach Virtual Memory Statistics: (page size of 16384 bytes)\nPages active:   123.\n…" → bytes used, or null
export const parseVmStat = (text) => {
  const t = String(text || ''); const size = Number((/page size of (\d+) bytes/.exec(t) || [])[1]); if (!size) return null;
  const n = (label) => Number((new RegExp(`^${label}:\\s+(\\d+)`, 'm').exec(t) || [])[1] || 0);
  const pages = n('Pages active') + n('Pages wired down') + n('Pages occupied by compressor');
  return pages ? pages * size : null;
};
// two os.cpus() samples → the busy share of all cores between them, 0-100
export const cpuBusy = (a, b) => {
  let busy = 0; let all = 0;
  (b || []).forEach((c, i) => { const p = (a || [])[i]; if (!p) return; const d = (k) => (c.times[k] || 0) - (p.times[k] || 0);
    const tot = d('user') + d('nice') + d('sys') + d('idle') + d('irq'); all += tot; busy += tot - d('idle'); });
  return all > 0 ? Math.max(0, Math.min(100, Math.round((busy / all) * 100))) : null;
};
// `lsof -nP -iTCP -sTCP:LISTEN -Fpcn`: "p812\ncnode\nf23\nn*:5173\n…" → [{ pid, command, port }], one per port
const DEV_CMD = /^(node|bun|deno|python[\d.]*|Python|ruby|php|java|com\.docke|docker|vite|next-serv|uvicorn|gunicorn|caddy|nginx|hugo|rails|puma)/;
export const parseListen = (text) => {
  const out = new Map(); let pid = null; let command = '';
  for (const line of String(text || '').split('\n')) {
    if (line[0] === 'p') { pid = Number(line.slice(1)); command = ''; }
    else if (line[0] === 'c') command = line.slice(1);
    else if (line[0] === 'n' && pid !== null) {
      const m = /^(.*):(\d+)$/.exec(line.slice(1)); if (!m) continue; const port = Number(m[2]); const host = m[1];
      if (port < 1024 || out.has(port) || !DEV_CMD.test(command)) continue;
      if (host !== '*' && !/^(127\.0\.0\.1|\[::1\]|localhost|\[::\]|0\.0\.0\.0)$/.test(host)) continue; // a LAN-only bind is not ours to open
      out.set(port, { pid, command, port });
    }
  }
  return [...out.values()].sort((a, b) => a.port - b.port);
};

const L = { at: -Infinity, list: [] };
export const listeners = async ({ run = execOut, self = process.pid, now = Date.now } = {}) => {
  if (now() - L.at < 10000) return L.list;
  let list = [];
  try {
    list = parseListen(await run('lsof', ['-nP', '-iTCP', '-sTCP:LISTEN', '-Fpcn'])).filter((s) => s.pid !== self);
    if (list.length) { let cwds = new Map(); try { cwds = parseLsof(await run('lsof', ['-a', '-p', [...new Set(list.map((s) => s.pid))].join(','), '-d', 'cwd', '-Fn'])); } catch {}
      list = list.map((s) => ({ ...s, url: `http://localhost:${s.port}`, cwd: cwds.get(s.pid) ?? null })); }
  } catch { list = []; }
  L.at = now(); L.list = list; return list;
};
// After a stop, the next read is fresh: a list kept 10 s showed 72 apps after 53 had stopped (6 November)
export const forgetListeners = () => { L.at = -Infinity; };

const V = { cpus: null, cpuAt: -Infinity, cpu: null, memAt: -Infinity, used: null };
export const vitals = async ({ claude = null, run = execOut, cpus = os.cpus, total = os.totalmem(), free = os.freemem, rss = () => process.memoryUsage().rss, load = os.loadavg, platform = process.platform, now = Date.now } = {}) => {
  const t = now(); const cur = cpus();
  if (!V.cpus) V.cpu = Math.min(100, Math.round((load()[0] / Math.max(1, cur.length)) * 100));
  else if (t - V.cpuAt >= 5000) V.cpu = cpuBusy(V.cpus, cur) ?? V.cpu;
  if (!V.cpus || t - V.cpuAt >= 5000) { V.cpus = cur; V.cpuAt = t; }
  if (t - V.memAt >= 5000) { V.memAt = t; V.used = null; if (platform === 'darwin') { try { V.used = parseVmStat(await run('vm_stat', [])); } catch {} } if (V.used === null) V.used = total - free(); }
  const used = Math.min(total, V.used);
  return { mem: { used, total, pct: Math.round((used / total) * 100) }, cpu: { pct: V.cpu, load: load().map((x) => Math.round(x * 100) / 100), cores: cur.length }, server: { rss: rss() }, claude, at: new Date(t).toISOString() };
};
export const _reset = () => { L.at = -Infinity; L.list = []; V.cpus = null; V.cpuAt = -Infinity; V.cpu = null; V.memAt = -Infinity; V.used = null; };
