// The flow canvas (public/canvas.js, docs/phase9/direction.md §5): the geometry of the view, « Ajuster », the layout
// of waves (rows) and frames (side by side), the orthogonal edges, and the time it takes to lay out and draw 50 nodes.
import { test } from 'node:test';
import assert from 'node:assert/strict';

import { i18nGlobal } from './i18n-env.mjs';
i18nGlobal();
await import('../public/canvas.js');
const C = globalThis.EscadrilleCanvas;
const G = C.geometry;
const near = (a, b, eps = 1e-6) => assert.ok(Math.abs(a - b) < eps, `${a} ≈ ${b}`);

const graphOf = (n, { waves = 3, plan = 'p' } = {}) => {
  const nodes = []; const edges = [];
  for (let i = 0; i < n; i++) { const wave = 1 + (i % waves); nodes.push({ id: `${plan}/S${i}`, plan, letter: 'S' + i, name: `Session ${i}`, wave, state: 'En cours', cost: '1 $ / 5 $', frac: 0.2, tone: 'run' }); }
  nodes.forEach((a, ia) => nodes.forEach((b, ib) => { if (b.wave === a.wave + 1 && ((ia + ib) % 2 === 0 || ib - ia === 1)) edges.push({ from: a.id, to: b.id, kind: 'after' }); }));
  return { plans: [{ id: plan, title: 'Le plan', sub: '12 $ sur 60 $', waiting: true }], nodes, edges };
};

test('zoomAt keeps the world point under the pointer and stays between 0,5 and 2', () => {
  const v = { x: 40, y: 30, k: 1 }; const under = G.toWorld(v, 300, 200);
  const z = G.zoomAt(v, 1.5, 300, 200); const after = G.toWorld(z, 300, 200);
  near(after.x, under.x); near(after.y, under.y); near(z.k, 1.5);
  assert.equal(G.zoomAt(v, 10, 0, 0).k, 2); assert.equal(G.zoomAt(v, 0.01, 0, 0).k, 0.5);
  const s = G.toScreen(v, 100, 50); assert.deepEqual(s, { x: 140, y: 80 });
});

test('fit frames the whole graph, centred when it fits, never under 0,5 nor over 1', () => {
  const vp = { w: 1000, h: 600 };
  const small = G.fit({ w: 400, h: 200 }, vp); assert.equal(small.k, 1); near(small.x, 300); near(small.y, 200);
  const wide = G.fit({ w: 1904, h: 200 }, vp); near(wide.k, (1000 - 48) / 1904); near(wide.x, 24);
  const huge = G.fit({ w: 6000, h: 4000 }, vp); assert.equal(huge.k, 0.5, 'beyond that the canvas scrolls'); near(huge.x, 24); near(huge.y, 24);
  assert.ok(G.overflows({ w: 6000, h: 4000 }, huge, vp)); assert.ok(!G.overflows({ w: 400, h: 200 }, small, vp));
  assert.deepEqual(G.fit(null, vp), { x: 24, y: 24, k: 1 });
});

test('frame puts a plan at zoom 1 at the top of the viewport; clampView keeps the graph reachable', () => {
  const vp = { w: 1200, h: 700 };
  const f = G.frame({ x: 0, y: 500, w: 1300, h: 400 }, vp, 1); assert.equal(f.k, 1); near(f.x, 24); near(f.y, 24 - 500);
  const c = G.frame({ x: 0, y: 0, w: 600, h: 400 }, vp, 1); near(c.x, 300, 1e-6);
  const b = { w: 2000, h: 1000 };
  const lost = G.clampView({ x: -5000, y: -5000, k: 1 }, b, vp); near(lost.x, 96 - 2000); near(lost.y, 96 - 1000);
  const far = G.clampView({ x: 5000, y: 5000, k: 1 }, b, vp); near(far.x, 1200 - 96); near(far.y, 700 - 96);
  const ok = G.clampView({ x: 10, y: 10, k: 1 }, b, vp); assert.deepEqual(ok, { k: 1, x: 10, y: 10 });
});

test('the mini-map scales the world into 160 × 100 and a click centres the view there', () => {
  const vp = { w: 1000, h: 500 }; const b = { w: 3200, h: 1000 }; const v = { x: 0, y: 0, k: 1 };
  const m = G.minimap(b, v, vp); near(m.s, 148 / 3200); near(m.view.x, m.ox); near(m.view.w, 1000 * m.s); near(m.view.h, 500 * m.s);
  const c = G.centreOn(v, 1600, 500, vp); near(c.x, 500 - 1600); near(c.y, 250 - 500);
});

test('layout: a row per wave from top to bottom, nodes side by side 328 apart from the left, the label at the left', () => {
  const g = graphOf(6, { waves: 3 }); // two per wave
  const L = C.layout(g); const p = L.plans[0];
  assert.equal(L.plans.length, 1); assert.ok(p.framed); assert.equal(p.rows.length, 3);
  assert.deepEqual(p.rows.map((c) => c.label), ['Maintenant, en parallèle', 'Quand S0 et S3 sont fusionnées', 'Quand S1 et S4 sont fusionnées']);
  const all = graphOf(3, { waves: 3 }); all.edges = [{ from: 'p/S0', to: 'p/S1', kind: 'after' }, { from: 'p/S0', to: 'p/S2', kind: 'after' }, { from: 'p/S1', to: 'p/S2', kind: 'after' }];
  assert.deepEqual(C.layout(all).plans[0].rows.map((c) => c.label), ['Maintenant', 'Quand S0 est fusionnée', 'Quand tout est fini']);
  const s0 = L.pos['p/S0'], s3 = L.pos['p/S3'], s1 = L.pos['p/S1'], s2 = L.pos['p/S2'];
  assert.equal(s0.w, 300); assert.equal(s0.h, 100); assert.equal(s3.x - s0.x, 328, 'one wave: side by side'); assert.equal(s3.y, s0.y);
  assert.equal(s1.x, s0.x, 'the next wave under it'); assert.equal(s1.y - s0.y, 164); assert.equal(s2.y - s1.y, 164, 'the first wave on top');
  assert.equal(s0.x, 20 + 176, 'the nodes right of the labels'); assert.equal(s0.y, 80, 'the first row under the frame head');
  for (const r of p.rows) { assert.ok(r.x + r.w <= s0.x, 'a label never under a node'); assert.equal(r.x, 20); }
  assert.deepEqual(p.rows.map((r) => r.y), [80, 244, 408], 'each label at the head of its row');
  assert.equal(p.w, 20 + 176 + 2 * 328 - 28 + 20); assert.equal(p.h, 408 + 100 + 24); assert.equal(p.x, 0); assert.equal(p.y, 0);
  assert.deepEqual(L.order, ['p/S0', 'p/S3', 'p/S1', 'p/S4', 'p/S2', 'p/S5'], 'reading order: row by row, left to right');
  const bare = C.layout({ plans: [{ id: 'p', frame: false }], nodes: g.nodes, edges: g.edges }); assert.ok(!bare.plans[0].framed); assert.equal(bare.pos['p/S0'].y, 36);
});

test('layout: a wave of thirteen wraps into rows of four; the last, alone, on the left; a lone first wave reads « Maintenant »', () => {
  const nodes = Array.from({ length: 13 }, (_, i) => ({ id: 'q/' + i, plan: 'q', letter: 'A' + i, name: 'n', wave: 1 }));
  const L = C.layout({ plans: [{ id: 'q', title: 'Treize' }], nodes, edges: [] });
  assert.equal(L.pos['q/1'].x - L.pos['q/0'].x, 328); assert.equal(L.pos['q/4'].x, L.pos['q/0'].x); assert.equal(L.pos['q/4'].y - L.pos['q/0'].y, 124);
  assert.equal(L.pos['q/12'].y - L.pos['q/0'].y, 3 * 124); assert.equal(L.pos['q/12'].x, 196, 'the last, alone, on the left: no hole between the label and the row');
  assert.equal(L.plans[0].rows.length, 1, 'one label for the wave'); assert.equal(L.plans[0].rows[0].label, 'Maintenant, en parallèle');
  const one = C.layout({ plans: [{ id: 'q' }], nodes: nodes.slice(0, 1), edges: [] }); assert.equal(one.plans[0].rows[0].label, 'Maintenant');
});

test('layout: two plans side by side from left to right, in the order given, tops aligned, 48 px apart; a bare empty plan is skipped', () => {
  const a = graphOf(2, { waves: 1, plan: 'a' }); const b = graphOf(3, { waves: 3, plan: 'b' });
  const L = C.layout({ plans: [...a.plans, ...b.plans, { id: 'c', frame: false }], nodes: [...a.nodes, ...b.nodes], edges: [] });
  assert.equal(L.plans.length, 2); assert.deepEqual(L.plans.map((p) => p.id), ['a', 'b']);
  assert.equal(L.plans[1].x, L.plans[0].w + 48); assert.equal(L.plans[0].y, 0); assert.equal(L.plans[1].y, 0);
  assert.ok(L.pos['b/S0'].x > L.plans[0].x + L.plans[0].w, 'the second frame on the right of the first');
  assert.equal(L.w, L.plans[1].x + L.plans[1].w); assert.equal(L.h, Math.max(L.plans[0].h, L.plans[1].h));
  assert.deepEqual(L.order.slice(0, 3), ['a/S0', 'a/S1', 'b/S0'], 'reading order: frame after frame');
});

test('the phase in flight: the one asked, else the last with a running node, else the last waiting, else the most recent', () => {
  const a = graphOf(1, { waves: 1, plan: 'a' }), b = graphOf(1, { waves: 1, plan: 'b' }); b.nodes[0].tone = 'done';
  const g = { plans: [...a.plans, { ...b.plans[0], waiting: false }], nodes: [...a.nodes, ...b.nodes], edges: [] }; const L = C.layout(g);
  assert.equal(C.phaseNow(L, g).id, 'a'); assert.equal(C.phaseNow(L, g, 'b').id, 'b');
  a.nodes[0].tone = 'done'; g.plans[0].waiting = false; assert.equal(C.phaseNow(C.layout(g), g).id, 'b', 'nothing in flight: the most recent, on the right');
});

test('column labels: a wave that depends on more than three names them by count, « Ensuite » without edges', () => {
  const letter = (id) => id.split('/')[1];
  const items = [{ id: 'p/K' }]; const earlier = ['A', 'B', 'C', 'D', 'E'].map((l) => ({ id: 'p/' + l }));
  const edges = earlier.slice(0, 4).map((e) => ({ from: e.id, to: 'p/K', kind: 'after' }));
  assert.equal(C.columnLabel(items, earlier, edges, letter, false), 'Quand 4 sessions sont fusionnées');
  assert.equal(C.columnLabel(items, earlier, [...edges, { from: 'p/E', to: 'p/K', kind: 'wave' }], letter, false), 'Quand la vague d’avant est fusionnée');
  assert.equal(C.columnLabel(items, earlier, [], letter, true), 'Ensuite');
  assert.equal(C.columnLabel(items, earlier.slice(0, 1), [{ from: 'p/A', to: 'p/K', kind: 'after' }], letter, false), 'Quand A est fusionnée');
});

test('edges leave from the bottom, arrive at the top, orthogonal with rounded corners; an edge back up goes round by the side', () => {
  const a = { x: 20, y: 80, w: 300, h: 100 }, b = { x: 348, y: 244, w: 300, h: 100 };
  assert.equal(C.edgePath(a, b), 'M170 180 V214 Q170 224 180 224 H488 Q498 224 498 234 V244');
  assert.equal(C.edgePath(a, { x: 20, y: 244, w: 300, h: 100 }), 'M170 180 V244', 'right under: a straight line');
  const back = C.edgePath(b, a); assert.ok(back.startsWith('M498 344 V'), back); assert.ok(back.includes('664'), 'round by the right side: ' + back); assert.ok(back.endsWith('V80'), back);
  assert.equal(C.arrow(b), 'M494 238 L498 244 L502 238 Z', 'the arrow points down into the top');
  const lane = C.edgePath(a, { x: 20, y: 408, w: 300, h: 100 }, { lane: 600 }); assert.ok(lane.includes('H590') && lane.endsWith('V408'), lane);
});

test('routes: an edge that skips a row goes by a clear lane, an edge between phases by the gap between the frames', () => {
  const nodes = ['A', 'B', 'C'].map((l, i) => ({ id: 'p/' + l, plan: 'p', letter: l, name: l, wave: i + 1 }));
  const L = C.layout({ plans: [{ id: 'p', title: 'P' }], nodes, edges: [] }); const f = L.plans[0];
  const r = C.route(L, L.pos['p/A'], L.pos['p/C']); assert.equal(r.lane, f.x + f.w - 10, 'B is in the way: the side of the frame');
  const d = C.edgePath(L.pos['p/A'], L.pos['p/C'], r); const x = f.x + f.w - 10; assert.ok(!(x > L.pos['p/B'].x && x < L.pos['p/B'].x + 300), d);
  assert.deepEqual(C.route(L, L.pos['p/A'], L.pos['p/B']), {}, 'the next row: straight');
  const two = C.layout({ plans: [{ id: 'p' }, { id: 'q' }], nodes: [...nodes, { id: 'q/D', plan: 'q', letter: 'D', name: 'D', wave: 1 }], edges: [] });
  const g = C.route(two, two.pos['p/A'], two.pos['q/D']).gap; const pf = two.plans[0], qf = two.plans[1];
  assert.ok(g > pf.x + pf.w && g < qf.x, 'between the frames, through no node');
});

test('markup: one block per node with its letter, name, state and bar; one path and one arrow per edge; merges are not drawn', () => {
  const g = graphOf(4, { waves: 2 }); g.edges.push({ from: 'p/S1', to: 'p/main', kind: 'merge' });
  const html = C.markup(g, C.layout(g), { selected: 'p/S0' });
  assert.equal((html.match(/class="cv-node/g) || []).length, 4);
  assert.match(html, /class="cv-node run sel" data-id="p\/S0" role="button" tabindex="0" aria-expanded="true"/);
  assert.equal((html.match(/tabindex="0"/g) || []).length, 1, 'one node in the Tab order (roving)'); assert.ok(!html.includes('data-jk'), 'j and k are gone');
  assert.match(html, /<span class="cv-badge">S0<\/span><span class="cv-name">Session 0<\/span>/);
  assert.match(html, /<i style="width:20%">/);
  const after = g.edges.filter((e) => e.kind === 'after').length;
  assert.equal((html.match(/class="cv-edge after"/g) || []).length, after); assert.equal((html.match(/class="cv-arrow"/g) || []).length, after);
  assert.ok(!html.includes('p/main'));
  assert.match(html, /class="cv-frame waiting"/); assert.match(html, /<b class="cv-frame-t">Le plan<\/b><span class="cv-frame-s">12 \$ sur 60 \$<\/span>/);
  assert.match(html, /vector-effect="non-scaling-stroke"/, 'the edges keep their width at every zoom');
  assert.ok(!/<script/i.test(C.markup({ plans: [{ id: 'x', title: '<script>' }], nodes: [{ id: 'x/1', plan: 'x', letter: '<', name: '"', wave: 1 }], edges: [] }, C.layout({ plans: [{ id: 'x' }], nodes: [{ id: 'x/1', plan: 'x', letter: '<', name: '"', wave: 1 }], edges: [] }))));
});

test('the keyboard goes both ways: arrows to the neighbour in reading order, Home and End to the ends, never past them', () => {
  const o = ['a', 'b', 'c'];
  assert.equal(C.step(o, 'b', 'ArrowDown'), 'c'); assert.equal(C.step(o, 'b', 'ArrowRight'), 'c');
  assert.equal(C.step(o, 'b', 'ArrowUp'), 'a'); assert.equal(C.step(o, 'b', 'ArrowLeft'), 'a');
  assert.equal(C.step(o, 'c', 'ArrowDown'), 'c', 'no wrap'); assert.equal(C.step(o, 'a', 'ArrowUp'), 'a');
  assert.equal(C.step(o, 'b', 'Home'), 'a'); assert.equal(C.step(o, 'a', 'End'), 'c');
  assert.equal(C.step(o, 'zz', 'ArrowDown'), 'a', 'from nowhere: the first'); assert.equal(C.step(o, 'a', 'j'), null, 'j and k move nothing'); assert.equal(C.step([], 'a', 'End'), null);
  const L = C.layout(graphOf(6, { waves: 3 })); // S0 S3 / S1 S4 / S2 S5
  assert.equal(C.step(L, 'p/S0', 'ArrowRight'), 'p/S3', '→ in the wave'); assert.equal(C.step(L, 'p/S3', 'ArrowLeft'), 'p/S0');
  assert.equal(C.step(L, 'p/S0', 'ArrowDown'), 'p/S1', '↓ to the next wave, the node under'); assert.equal(C.step(L, 'p/S4', 'ArrowDown'), 'p/S5'); assert.equal(C.step(L, 'p/S5', 'ArrowUp'), 'p/S4');
  assert.equal(C.step(L, 'p/S0', 'ArrowUp'), 'p/S0', 'no wrap'); assert.equal(C.step(L, 'p/S3', 'ArrowRight'), 'p/S3'); assert.equal(C.step(L, 'p/S2', 'ArrowDown'), 'p/S2');
  assert.equal(C.step(L, 'p/S4', 'Home'), 'p/S0'); assert.equal(C.step(L, 'p/S0', 'End'), 'p/S5');
  const a = graphOf(2, { waves: 1, plan: 'a' }), b = graphOf(4, { waves: 2, plan: 'b' }); const two = C.layout({ plans: [...a.plans, ...b.plans], nodes: [...a.nodes, ...b.nodes], edges: [] });
  assert.equal(C.step(two, 'a/S1', 'ArrowRight'), 'b/S0', '→ at the end of a row: the next frame'); assert.equal(C.step(two, 'b/S0', 'ArrowLeft'), 'a/S1', '← back to the frame before');
  assert.equal(C.step(two, 'b/S1', 'ArrowLeft'), 'a/S1', 'from the second row: the last row the frame before has');
});

test('a click on a node selects it (its detail opens); a second click on the selected node opens its thread', () => {
  assert.equal(C.tap(null, 'a', true), 'select'); assert.equal(C.tap('b', 'a', true), 'select', 'another node: the detail follows');
  assert.equal(C.tap('a', 'a', true), 'open'); assert.equal(C.tap('a', 'a', false), 'select', 'a screen without a thread keeps it selected');
  assert.equal(C.tap('a', null, true), null, 'the ground selects nothing');
});

test('markup: the roving node is the selected one, else the one asked, else the first in reading order', () => {
  const g = graphOf(4, { waves: 2 }); const L = C.layout(g);
  const first = C.markup(g, L); assert.match(first, new RegExp(`data-id="${L.order[0]}" role="button" tabindex="0"`));
  const cur = C.markup(g, L, { current: 'p/S1' }); assert.match(cur, /data-id="p\/S1" role="button" tabindex="0" aria-expanded="false"/);
  const sel = C.markup(g, L, { selected: 'p/S2' }); assert.match(sel, /data-id="p\/S2" role="button" tabindex="0" aria-expanded="true"/);
});

test('identity: the twin of an element after a full render is found by its id, else by its data-* attributes', () => {
  const el = (tag, attrs, id = '') => ({ tagName: tag, id, ownerDocument: { body: null }, attributes: Object.entries(attrs).map(([name, value]) => ({ name, value })) });
  assert.equal(C.identity(el('BUTTON', {}, 'more')), '#more');
  assert.equal(C.identity(el('DIV', { 'data-id': 'p/B', class: 'x' })), 'div[data-id="p/B"]');
  assert.equal(C.identity(el('BUTTON', { 'data-fold': 'sum:B', 'data-i18n': 'x' })), 'button[data-fold="sum:B"]');
  assert.equal(C.identity(el('SPAN', { class: 'x' })), null, 'nothing to find it by'); assert.equal(C.identity(null), null);
});

test('the help says every key the canvas keeps, and not j nor k', () => {
  const keys = [...C.canvasKeys(), ...C.commonKeys()]; const flat = keys.flatMap(([k]) => k);
  for (const k of ['←', '→', '↑', '↓', '+', '−', '0', '?', '1']) assert.ok(flat.includes(k), k);
  assert.ok(!flat.includes('j') && !flat.includes('k')); for (const [, verb] of keys) assert.ok(verb && !verb.startsWith('canvas.'), verb);
});

test('a node wholly out of the view is not seen (hidden, never clicked); a node partly in is', () => {
  const p = { x: 20, y: 600, w: 260, h: 88 }; const vp = { w: 1000, h: 500 };
  assert.equal(G.seen(p, { x: 0, y: 0, k: 1 }, vp), false, 'under the board');
  assert.equal(G.seen(p, { x: 0, y: -150, k: 1 }, vp), true, 'its top in view');
  assert.equal(G.seen(p, { x: 0, y: -700, k: 1 }, vp), false, 'above the board');
  assert.equal(G.seen(p, { x: -300, y: -300, k: 1 }, vp), false, 'left of the board'); assert.equal(G.seen(p, { x: 0, y: 0, k: 0.5 }, vp), true, 'zoomed out');
});

test('performance: fifty nodes are laid out and drawn in well under a frame', () => {
  const g = graphOf(50, { waves: 5 });
  const times = []; for (let i = 0; i < 7; i++) { const t = performance.now(); const L = C.layout(g); const html = C.markup(g, L); times.push(performance.now() - t); assert.ok(html.length > 50 * 200); }
  times.sort((a, b) => a - b); const median = times[3];
  assert.ok(median < 40, `median ${median.toFixed(1)} ms for 50 nodes and ${g.edges.length} edges`);
  const L = C.layout(g); assert.equal(Object.keys(L.pos).length, 50); assert.equal(L.plans[0].rows.length, 5); assert.ok(L.h > 5 * 100);
});

test('layout: the frame is as wide as its widest wave; every node and every label inside it, none on another', () => {
  const sizes = [2, 4, 1, 3]; const nodes = []; sizes.forEach((k, w) => { for (let i = 0; i < k; i++) nodes.push({ id: `p/${w}${i}`, plan: 'p', letter: `${w}${i}`, name: 'n', wave: w + 1 }); });
  const L = C.layout({ plans: [{ id: 'p', title: 'P' }, { id: 'q', title: 'Q' }], nodes: [...nodes, { id: 'q/A', plan: 'q', letter: 'A', name: 'n', wave: 1 }], edges: [] });
  const f = L.plans[0]; assert.equal(f.w, 20 + 176 + 4 * 328 - 28 + 20);
  const ps = Object.values(L.pos);
  for (const p of ps.filter((q) => q.plan === 'p')) { assert.ok(p.x >= f.x + 196 && p.x + p.w <= f.x + f.w - 20, 'inside its frame, right of the labels'); }
  for (const a of ps) for (const b of ps) if (a !== b) assert.ok(a.x + a.w <= b.x || b.x + b.w <= a.x || a.y + a.h <= b.y || b.y + b.h <= a.y, 'no overlap');
  assert.ok(L.pos['q/A'].x > f.x + f.w, 'the next frame on the right');
});

test("markup: the nodes are written in reading order, so the first in the DOM is the first in view at the opening", () => {
  const a = graphOf(2, { waves: 1, plan: "a" }), b = graphOf(2, { waves: 1, plan: "b" });
  const g = { plans: [...a.plans, ...b.plans], nodes: [...b.nodes, ...a.nodes], edges: [] }; const L = C.layout(g);
  const ids = [...C.markup(g, L).matchAll(/class="cv-node[^"]*" data-id="([^"]+)"/g)].map((m) => m[1]);
  assert.deepEqual(ids, L.order); assert.equal(ids[0], "a/S0", "the oldest phase, on the left, first");
});

test("the opposite arrow right after a move goes back where it came from (↓ then ↑ gives the same node)", () => {
  const nodes = [["SEC", 1], ["TB", 1], ["NEUF", 1], ["COMM", 2], ["QA", 3]].map(([l, w]) => ({ id: "p/" + l, plan: "p", letter: l, name: l, wave: w }));
  const L = C.layout({ plans: [{ id: "p", frame: false }], nodes, edges: [] });
  const down = C.step(L, "p/NEUF", "ArrowDown"); assert.equal(down, "p/COMM");
  assert.equal(C.step(L, down, "ArrowUp", { from: "p/NEUF", to: down, key: "ArrowDown" }), "p/NEUF", "back to NEUF, not the nearest");
  assert.equal(C.step(L, down, "ArrowUp"), "p/SEC", "without a move before: the nearest in x");
  assert.equal(C.step(L, down, "ArrowUp", { from: "p/NEUF", to: "p/QA", key: "ArrowDown" }), "p/SEC", "a memory of another node is ignored");
  assert.equal(C.step(L, down, "ArrowDown", { from: "p/NEUF", to: down, key: "ArrowDown" }), "p/QA", "the same arrow goes on");
});

test('the end node of a plan (phase 13 FL): a row « À la fin » under the last wave, the merge edges lead to it, the pill when it waits for the click; a card says its ETA and its verb', () => {
  const g = graphOf(3, { waves: 2 }); g.ends = [{ id: 'p/main', plan: 'p', title: 'Enchaîner sur Phase 13', sub: 'attend ton clic', mine: true, you: 'À toi · Lancer', tone: 'wait', eta: 'vers 14:20', etaTip: 'entre 13:50 et 15:10' }];
  g.edges.push({ from: 'p/S1', to: 'p/main', kind: 'merge' });
  g.nodes[0].mine = true; g.nodes[0].you = 'À toi · Juger'; g.nodes[0].eta = 'vers 11:40'; g.nodes[0].etaTip = 'entre 11:20 et 12:10';
  const L = C.layout(g);
  assert.ok(L.pos['p/main'], 'the end node has a place'); assert.equal(L.pos['p/main'].h, C.END_H); assert.equal(L.order[L.order.length - 1], 'p/main', 'last in reading order');
  const lastWave = Math.max(...g.nodes.map((n) => L.pos[n.id].y + L.pos[n.id].h)); assert.ok(L.pos['p/main'].y > lastWave, 'under the last wave');
  assert.equal(L.plans[0].rows[L.plans[0].rows.length - 1].label, 'À la fin'); assert.ok(L.plans[0].h > L.pos['p/main'].y + C.END_H, 'inside the frame');
  const html = C.markup(g, L);
  assert.match(html, /class="cv-node cv-end wait mine" data-id="p\/main" role="button"/);
  assert.match(html, /<span class="cv-end-t">Enchaîner sur Phase 13<\/span><span class="cv-you" data-cv-act>À toi · Lancer<\/span><span class="cv-end-s">attend ton clic<span class="cv-eta" title="entre 13:50 et 15:10">vers 14:20<\/span><\/span>/);
  assert.match(html, /class="cv-edge merge" data-from="p\/S1" data-to="p\/main"/, 'the merge edge is drawn to the end node');
  assert.match(html, /<span class="cv-s"><span class="cv-you" data-cv-act>À toi · Juger<\/span><span class="cv-cost">1 \$ \/ 5 \$<\/span><\/span><span class="cv-eta" title="entre 11:20 et 12:10">vers 11:40<\/span>/, 'the pill replaces the state, the ETA has its row');
  assert.match(html, /aria-label="S0, Session 0, En cours, 1 \$ \/ 5 \$, vers 11:40"/);
  assert.ok(!C.markup(graphOf(2), C.layout(graphOf(2))).includes('cv-you'), 'a calm card has no pill');
});
