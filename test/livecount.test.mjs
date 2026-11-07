// What runs, at once (public/livecount.js, Dev 2026-11-06): the top bar's « N tournent · X $ engagés » and its list,
// grouped by project then plan, built from /api/running and /api/projectflow. No browser: the pure parts.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { runInNewContext } from 'node:vm';
import path from 'node:path';

const PUB = path.join(path.dirname(new URL(import.meta.url).pathname), '..', 'public');
const load = () => { const g = { T: (k, v) => (v ? `${k}:${JSON.stringify(v)}` : k) }; g.T.usd = (n) => `${n.toFixed(2)} $`; runInNewContext(readFileSync(path.join(PUB, 'livecount.js'), 'utf8'), g); return g.EscadrilleLive; };

const running = { ours: [
  { kind: 'session', plan: 'see', session: 'RUN', pid: 1, since: 't', project: '/p/escadrille' },
  { kind: 'session', plan: 'see', session: 'RET', pid: 2, project: '/p/escadrille' },
  { kind: 'session', plan: 'see', session: 'RUN', pid: 1, project: '/p/escadrille' }, // the same twice counts once
  { kind: 'session', plan: 'r08', session: 'AVA', pid: 3, project: '/p/orchard' },
  { kind: 'session', plan: 'ghost', session: 'X', pid: 4, project: '/p/orchard' }, // not in the flow: still counted
  { kind: 'devserver', plan: 'see', session: 'RUN', pid: 5, project: '/p/escadrille' }, // not a session
], others: [] };
const flows = {
  '/p/escadrille': { plans: [{ id: 'see', title: 'Voir ce qui tourne' }], nodes: [{ plan: 'see', session: 'RUN', name: 'Cartes', now: 'Edit public/canvas.js', cost: 1.94 }, { plan: 'see', session: 'RET', name: 'Retirer', now: '', cost: 0.861 }] },
  '/p/orchard': { plans: [{ id: 'r08', title: 'R08' }], nodes: [{ plan: 'r08', session: 'AVA', name: 'Avatar', now: 'Read picker.tsx', cost: 1.32 }] },
};

test('the counter: live sessions once each, their cost summed, grouped by project then plan', () => {
  const L = load(); const m = JSON.parse(JSON.stringify(L.group(running, flows))); // out of the vm's realm
  assert.equal(m.n, 4);
  assert.equal(m.cost, 4.12);
  assert.deepEqual(m.projects.map((p) => [p.name, p.n, p.cost]), [['escadrille', 2, 2.8], ['orchard', 2, 1.32]]);
  const see = m.projects[0].plans[0];
  assert.equal(see.title, 'Voir ce qui tourne');
  assert.deepEqual(see.sessions.map((s) => [s.session, s.now, s.cost]), [['RUN', 'Edit public/canvas.js', 1.94], ['RET', '', 0.861]]);
  assert.match(see.sessions[0].href, /^\/plan\/see\?project=%2Fp%2Fescadrille&node=RUN&tab=RUN#flow$/);
  const ghost = m.projects[1].plans.find((p) => p.plan === 'ghost');
  assert.deepEqual([ghost.title, ghost.sessions[0].cost], ['ghost', 0]);
});

test('the markup: the figures on the button, every session a link with its line, nothing on hover only', () => {
  const L = load(); const html = L.markup(L.group(running, flows), true);
  assert.match(html, /<b class="num">4<\/b>/);
  assert.match(html, /4\.12 \$/);
  assert.equal((html.match(/class="lc-s" href="\/plan\//g) || []).length, 4);
  assert.match(html, /Edit public\/canvas\.js/);
  assert.match(html, /live\.noLine/); // a session without a line says so
  assert.doesNotMatch(html, / title="/); // the essential is written, never in a tooltip
  assert.match(L.markup(L.group(running, flows), false), /class="live-list"[^>]* hidden>/);
});

test('nothing runs: the counter says so and opens nothing', () => {
  const L = load();
  assert.deepEqual(JSON.parse(JSON.stringify(L.group({ ours: [] }, {}))), { n: 0, cost: 0, projects: [], apps: [], vitals: null });
  assert.equal(L.group(null).n, 0);
  assert.match(L.markup(L.group({ ours: [] })), /class="live-count idle"[^>]*disabled>live\.idle</);
});

const vitals = { mem: { used: 14.2 * 2 ** 30, total: 16 * 2 ** 30, pct: 89 }, cpu: { pct: 23, load: [2.1, 1.8, 1.6], cores: 10 }, server: { rss: 182 * 2 ** 20 }, claude: 9 };
const withApps = { ...running, vitals,
  ours: [...running.ours, { kind: 'devserver', plan: 'see', session: 'RUN', url: 'http://localhost:5173', project: '/p/escadrille' },
    { kind: 'devenv', plan: 'r08', session: 'AVA', url: 'http://localhost:8080/', urls: ['http://localhost:8080/', 'http://localhost:3050/'], project: '/p/orchard' }],
  servers: [{ pid: 9, command: 'node', port: 3091, url: 'http://localhost:3091', cwd: '/w/voir-VIT' }, { pid: 10, command: 'com.docke', port: 8080, url: 'http://localhost:8080' }] };

test('the front apps: one link per URL, opened in a new tab, from npm run dev, the environment and the listeners', () => {
  const L = load(); const m = L.group(withApps, flows);
  // the Environnement first (ENV: up), then the test apps (a session's npm run dev, the other listeners): lib/testapps.mjs
  assert.deepEqual(JSON.parse(JSON.stringify(m.apps)).map((a) => [a.host, a.name]), [['localhost:8080', 'orchard'], ['localhost:3050', 'orchard'], ['localhost:5173', 'escadrille'], ['localhost:3091', 'voir-VIT']]);
  const html = L.markup(m, true);
  assert.equal((html.match(/class="lc-s lc-app" href="http:\/\/localhost:\d+" target="_blank" rel="noopener"/g) || []).length, 4);
  assert.match(html.replace(/&quot;/g, '"'), /live\.apps:\{"n":4\}/); // in the button's label
  // no session, apps only: the counter still opens on them
  const only = L.markup(L.group({ ours: [], servers: withApps.servers }), true);
  assert.doesNotMatch(only, /disabled/); assert.match(only, /<b class="num">2<\/b>/);
});

test('the vital signs: one folded line, memory over 85 % marked, the detail in the fold', () => {
  const L = load(); const html = L.markup(L.group(withApps, flows), true).replace(/&quot;/g, '"');
  assert.match(html, /<details class="lc-vit"><summary><span class=" hot">live\.vMem:\{"pct":89\}<\/span> · <span class="">live\.vCpu:\{"pct":23\}/);
  assert.match(html, /live\.vServer:\{"mb":182\}/); assert.match(html, /live\.vClaude:\{"n":9\}/);
  assert.match(html, /live\.dMemV:\{"used":"14\.2","total":"16\.0"\}/);
  // nothing runs but the server answers: the line is still one click away
  assert.doesNotMatch(L.markup(L.group({ ours: [], vitals })), /disabled/);
});
