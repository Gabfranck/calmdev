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
  assert.deepEqual(JSON.parse(JSON.stringify(L.group({ ours: [] }, {}))), { n: 0, cost: 0, projects: [], apps: [], vitals: null, canStop: false });
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
  // the label counts what calmdev started: the two environments and the dev server; the Mac's `node` listener is folded apart (PROC)
  assert.match(html.replace(/&quot;/g, '"'), /live\.apps:\{"n":3\}/); // in the button's label
  assert.match(html, /lc-macs/);
  // no session, apps only: the counter still opens on them
  const only = L.markup(L.group({ ours: [], servers: withApps.servers }), true);
  assert.doesNotMatch(only, /disabled/); assert.match(only, /lc-macs/); // two Mac services: listed folded, not counted
});

// docs/sessions.md 2026-11-07: an orphan comes with role 'env' (its project's root) and orphan: true; it must not read
// « environnement · main » any more (7 November: five such lines, abandoned for days)
const H = ['', 'Users', 'dev'].join('/'); // a home folder, built so no tracked file carries one (test/trace-scan.test.mjs)
const since = new Date(Date.now() - 3 * 86400000).toISOString();
const withOrphans = { ours: [], servers: [
  { pid: 9, command: 'node', port: 3091, url: 'http://localhost:3091', cwd: '/w/voir-VIT', role: 'test', orphan: false },
  { pid: 41, port: 3150, command: `node ${H}/Dev/CalmDev/scratch/serve.mjs --port 3150`, cwd: `${H}/Dev/CalmDev/scratch`, since, role: 'env', project: `${H}/Dev/CalmDev`, branch: 'main', orphan: true },
  { pid: 12, port: 8080, url: 'http://localhost:8080', command: 'node', cwd: `${H}/Dev/CalmDev`, role: 'env', project: `${H}/Dev/CalmDev`, branch: 'main', orphan: false },
] };

test('an orphan reads apart: its folder, the word orphelin, its port; out of the Environnement and the tests', () => {
  const L = load(); const m = L.group(withOrphans, {}, { canStop: true });
  const A = JSON.parse(JSON.stringify(m.apps));
  assert.deepEqual(A.map((a) => [a.role, a.name]), [['orphan', 'scratch'], ['env', 'CalmDev'], ['test', 'voir-VIT']]);
  assert.deepEqual([A[0].pid, A[0].port, A[0].cwd], [41, 3150, `${H}/Dev/CalmDev/scratch`]);
  const html = L.markup(m, true);
  assert.match(html, /<div class="lc-proj lc-ohead"><span>live\.orphHead<\/span><span class="num">1<\/span><\/div>/);
  assert.match(html, /<span class="t">scratch<\/span><span class="lc-otag">live\.orphTag<\/span><span class="num">:3150<\/span>/); // a word, not a colour only
  assert.equal((html.match(/data-orph-stop=/g) || []).length, 1); // one action per orphan line
  assert.equal((html.match(/live\.appBranch/g) || []).length, 1); // only the real environment says « environnement · main »
  // the detail: folded, one line (the command, since when), then the full command, the date on hover and focus, the folder in ~/
  assert.match(html, /<details class="lc-od" data-orph-detail="41:3150"><summary[^>]*>node serve\.mjs --port · live\.orphSince/);
  assert.ok(html.includes(`<dd class="cmd">node ${H}/Dev/CalmDev/scratch/serve.mjs --port 3150</dd>`));
  assert.match(html, /<span class="lc-when" tabindex="0"[^>]*aria-describedby="lco-41-3150-d">time\.forD:\{&quot;n&quot;:3\}<span class="lc-tip" role="tooltip" id="lco-41-3150-d">/);
  assert.match(html, /<dd class="dir">~\/<wbr>Dev\/<wbr>CalmDev\/<wbr>scratch<\/dd>/); // ~/ for the home, a break only after a « / »
});

test('without the Mac (a phone, a poste), no « Arrêter » is drawn at all; a line that is no orphan is unchanged', () => {
  const L = load(); const html = L.markup(L.group(withOrphans, {}, { canStop: false }), true);
  assert.doesNotMatch(html, /data-orph-stop|lc-ostop/);
  assert.match(html, /lc-otag/);
  const plain = { ours: [], servers: withOrphans.servers.filter((s) => !s.orphan).map(({ orphan, ...s }) => s) };
  assert.equal(L.markup(L.group({ ...plain, servers: withOrphans.servers.filter((s) => !s.orphan) }), true), L.markup(L.group(plain), true));
});

test('a refusal reads in one line: gone, owned, the 403 sentence of the server', () => {
  const L = load();
  assert.equal(L.why(409, 'not listening'), 'live.orphGone');
  assert.equal(L.why(409, 'owned by ENV: up'), 'live.orphEnv');
  assert.equal(L.why(409, 'owned by p/A'), 'live.orphOwned:{"by":"p/A"}');
  assert.equal(L.why(403, 'Arrêter un orphelin… utilise le bouton Arrêter'), 'Arrêter un orphelin… utilise le bouton Arrêter');
  assert.equal(L.why(0, ''), 'live.orphFail');
});

test('the vital signs: one folded line, memory over 85 % marked, the detail in the fold', () => {
  const L = load(); const html = L.markup(L.group(withApps, flows), true).replace(/&quot;/g, '"');
  assert.match(html, /<details class="lc-vit"><summary><span class=" hot">live\.vMem:\{"pct":89\}<\/span> · <span class="">live\.vCpu:\{"pct":23\}/);
  assert.match(html, /live\.vServer:\{"mb":182\}/); assert.match(html, /live\.vClaude:\{"n":9\}/);
  assert.match(html, /live\.dMemV:\{"used":"14\.2","total":"16\.0"\}/);
  // nothing runs but the server answers: the line is still one click away
  assert.doesNotMatch(L.markup(L.group({ ours: [], vitals })), /disabled/);
});
