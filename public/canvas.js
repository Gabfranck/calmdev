// The flow canvas (docs/phase9/direction.md §5), one component for the project's Flot (/flow) and a plan
// (/plan/:id#flow). No dependency. The graph is never compressed to fit the window: the world is laid out at its
// real size (a node is 300 × 100 at zoom 1) and the viewport moves over it. A phase reads from top to bottom (a row per
// wave, the first on top, its label at the left), the phases from left to right (a frame each, the oldest on the left).
//   EscadrilleCanvas.layout(graph)                 → positions, frames, wave rows, bounds, reading order, grid (pure)
//   EscadrilleCanvas.markup(graph, layout, opts)   → the world's HTML (pure, used by the perf test)
//   EscadrilleCanvas.geometry                      → zoomAt, fit, frame, clampView, toWorld, minimap… (pure)
//   EscadrilleCanvas.step / tap                    → where an arrow goes, what a click on a node does (pure)
//   EscadrilleCanvas.mount(board, opts)            → { setData, setSelected, close, focusNode, focused, fit, frame, zoom, view, reveal, setInset, destroy }
//   EscadrilleCanvas.screen({ keys, escape })      → the screen's Échap and its « ? » help (until public/ux.js holds them)
// graph: { plans: [{ id, title, sub, href?, frame?, waiting? }], nodes: [{ id, plan, letter, name, wave, state, cost,
//          frac, tone: 'run'|'done'|'wait'|'err'|'', mine?, you? (the « À toi · Verbe » pill), eta?, etaTip?, faded?, label? }],
//          edges: [{ from, to, kind, met? }], ends?: [{ id, plan, title, sub, mine?, you?, tone?, eta?, label? }] }
// An end node (phase 13 FL, docs/flot.md « L'issue d'une phase ») closes each plan under its last wave, in a row of its
// own labelled « À la fin »; the `merge` edges of the sessions without a successor lead to it.
// opts: { key (the view is kept per key in localStorage), onSelect(id|null), onOpen(id), onAct(id) (a click on the « À toi »
//   pill of a node or of an end node: the page makes the gesture), onHover(id|null), openPlan, help() }
// The contract (docs/phase11/ux.md §4.3): a click on a node selects it (its detail opens), a second click or Enter opens
// its thread; the selection happens at pointerup, never on a drag; one node is in the Tab order (roving), ← → ↑ ↓ go
// between the waves, ← → in a wave then from a frame to the next, Home / End to the ends, Space selects; close() gives
// the focus back. The ground is a light dot grid that follows the zoom and the drag.
// Moves: drag the ground, wheel pans, ⌘/Ctrl + wheel or a pinch zooms on the pointer, + − 0 (fit).
// Zoom 0,5 – 2 ; « Ajuster » never goes under 0,5 ; the opening frames the phase in flight (a running node, else the last). Under 0,8 a node keeps its letter and its name, the second line
// comes back on hover ; no text is drawn under 11 px on screen (the type grows as the zoom shrinks).
(function (root) {
  const NODE_W = 300, NODE_H = 100, END_H = 64, PITCH = 328, MAXC = 4, WGAP = 64, SUBGAP = 24, GUTTER = 176, PAD = 20, HEAD = 80, HEAD_BARE = 36, FOOT = 24, GAP = 48, DOT = 24;
  const ZMIN = 0.5, ZMAX = 2, FIT_MAX = 1, FIT_PAD = 24, KEEP = 96, MINI = { w: 160, h: 100, pad: 6 };
  const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  const T = (k, v) => (root.T ? root.T(k, v) : k);
  const andList = (a) => (a.length < 2 ? a.join('') : T('canvas.and', { a: a.slice(0, -1).join(', '), b: a[a.length - 1] }));
  const r1 = (x) => Math.round(x * 10) / 10;

  // ---- geometry (pure): the view is { x, y, k } : screen = world × k + (x, y)
  const clampK = (k) => Math.min(ZMAX, Math.max(ZMIN, Number.isFinite(k) ? k : 1));
  const toWorld = (v, sx, sy) => ({ x: (sx - v.x) / v.k, y: (sy - v.y) / v.k });
  const toScreen = (v, wx, wy) => ({ x: wx * v.k + v.x, y: wy * v.k + v.y });
  // Zoom by a factor around a screen point: the world under the pointer stays under the pointer
  const zoomAt = (v, f, cx, cy) => { const k = clampK(v.k * f); const r = k / v.k; return { k, x: cx - (cx - v.x) * r, y: cy - (cy - v.y) * r }; };
  // The view never loses the graph: at least KEEP px of it stay inside the viewport (an empty graph is free)
  const clampView = (v, b, vp) => { if (!b || !b.w || !b.h) return v; const w = b.w * v.k, h = b.h * v.k;
    return { k: v.k, x: Math.min(vp.w - KEEP, Math.max(KEEP - w, v.x)), y: Math.min(vp.h - KEEP, Math.max(KEEP - h, v.y)) }; };
  // « Ajuster »: the whole graph in the viewport, never under 0,5 nor over 1; centred when it fits, else top-left
  const fit = (b, vp, pad = FIT_PAD) => { if (!b || !b.w || !b.h || !vp.w || !vp.h) return { x: pad, y: pad, k: 1 };
    const k = Math.min(FIT_MAX, Math.max(ZMIN, Math.min((vp.w - 2 * pad) / b.w, (vp.h - 2 * pad) / b.h)));
    const w = b.w * k, h = b.h * k; return { k, x: w + 2 * pad <= vp.w ? (vp.w - w) / 2 : pad, y: h + 2 * pad <= vp.h ? (vp.h - h) / 2 : pad }; };
  // A rectangle of the world at a given zoom, its top at the top of the viewport, centred when it is narrower
  const frame = (r, vp, k = 1, pad = FIT_PAD) => { k = clampK(k); const w = r.w * k; return { k, x: (w + 2 * pad <= vp.w ? (vp.w - w) / 2 : pad) - r.x * k, y: pad - r.y * k }; };
  const overflows = (b, v, vp) => !!b && (b.w * v.k + 2 * FIT_PAD > vp.w || b.h * v.k + 2 * FIT_PAD > vp.h || v.x < 0 || v.y < 0 || v.x + b.w * v.k > vp.w || v.y + b.h * v.k > vp.h);
  // The mini-map: the world scaled into 160 × 100, and the viewport as a rectangle in it
  const minimap = (b, v, vp, box = MINI) => { const s = Math.min((box.w - 2 * box.pad) / Math.max(1, b.w), (box.h - 2 * box.pad) / Math.max(1, b.h)); const ox = (box.w - b.w * s) / 2, oy = (box.h - b.h * s) / 2;
    const tl = toWorld(v, 0, 0), br = toWorld(v, vp.w, vp.h);
    return { s, ox, oy, view: { x: ox + tl.x * s, y: oy + tl.y * s, w: (br.x - tl.x) * s, h: (br.y - tl.y) * s } }; };
  // A node is seen when some of it is inside the viewport; a node wholly outside is hidden (nobody can click it)
  const seen = (p, v, vp) => { const l = p.x * v.k + v.x, t = p.y * v.k + v.y; return l + p.w * v.k > 0 && t + p.h * v.k > 0 && l < vp.w && t < vp.h; };
  // A click in the mini-map centres the viewport on that point of the world
  const centreOn = (v, wx, wy, vp) => ({ k: v.k, x: vp.w / 2 - wx * v.k, y: vp.h / 2 - wy * v.k });

  // ---- layout (pure): a frame per plan, side by side from left to right (the order given, the oldest first), tops
  // aligned; inside a frame a row per wave from top to bottom, its nodes side by side from the left (over four wraps
  // into one more row), the wave's label in a gutter at the left of its first row
  const columnLabel = (items, earlier, edges, letterOf, last) => {
    if (!earlier.length) return T(items.length > 1 ? 'canvas.nowParallel' : 'canvas.now');
    const ids = new Set(items.map((n) => n.id)); const deps = [...new Set(edges.filter((e) => ids.has(e.to) && e.kind !== 'merge').map((e) => letterOf(e.from)).filter(Boolean))];
    if (!deps.length) return T('canvas.then');
    const all = earlier.every((n) => deps.includes(letterOf(n.id)));
    if (all && last) return T('canvas.allDone');
    if (deps.length <= 3) return T('canvas.whenMerged', { list: andList(deps), n: deps.length });
    return all ? T('canvas.whenWave') : T('canvas.whenN', { n: deps.length });
  };
  const layout = (graph) => {
    const pos = {}; const plans = []; const order = []; const grid = []; const at = {}; let x = 0; let height = 0;
    const letterOf = Object.fromEntries((graph.nodes || []).map((n) => [n.id, n.letter]));
    for (const p of graph.plans || []) {
      const mine = (graph.nodes || []).filter((n) => n.plan === p.id); if (!mine.length && p.frame === false && !(graph.ends || []).some((e) => e.plan === p.id)) continue;
      const waves = [...new Set(mine.map((n) => n.wave || 1))].sort((a, b) => a - b);
      const framed = p.frame !== false; const head = framed ? HEAD : HEAD_BARE;
      const across = Math.max(1, Math.min(MAXC, Math.max(0, ...waves.map((w) => mine.filter((n) => (n.wave || 1) === w).length))));
      const contentW = across * PITCH - (PITCH - NODE_W); const left = x + PAD + GUTTER;
      const rows = []; const fi = grid.length; const fg = []; let y = head;
      waves.forEach((w, wi) => {
        const items = mine.filter((n) => (n.wave || 1) === w); const earlier = mine.filter((n) => (n.wave || 1) < w);
        if (wi) y += WGAP - SUBGAP;
        rows.push({ x: x + PAD, y, w: GUTTER - 16, label: columnLabel(items, earlier, graph.edges || [], (id) => letterOf[id], wi === waves.length - 1), wave: w });
        for (let r = 0; r < Math.ceil(items.length / MAXC); r++) {
          const chunk = items.slice(r * MAXC, (r + 1) * MAXC); const row = []; const start = left;
          chunk.forEach((n, j) => { pos[n.id] = { x: start + j * PITCH, y, w: NODE_W, h: NODE_H, plan: p.id }; at[n.id] = { f: fi, r: fg.length, i: j }; order.push(n.id); row.push(n.id); });
          fg.push(row); y += NODE_H + SUBGAP;
        }
      });
      const end = (graph.ends || []).find((e) => e.plan === p.id);
      if (end) { if (waves.length) y += WGAP - SUBGAP; rows.push({ x: x + PAD, y, w: GUTTER - 16, label: T('canvas.endRow'), wave: 'end' });
        pos[end.id] = { x: left, y, w: NODE_W, h: END_H, plan: p.id, end: true }; at[end.id] = { f: fi, r: fg.length, i: 0 }; order.push(end.id); fg.push([end.id]); y += END_H + SUBGAP; }
      const w = Math.max(PAD + GUTTER + contentW + PAD, framed ? 420 : 0); const h = y - SUBGAP + (framed ? FOOT : 0);
      plans.push({ id: p.id, title: p.title || p.id, sub: p.sub || '', href: p.href || '', framed, waiting: !!p.waiting, runs: p.runs || '', x, y: 0, w, h, rows });
      grid.push(fg); height = Math.max(height, h); x += w + GAP;
    }
    return { pos, plans, order, grid, at, w: Math.max(0, x - GAP), h: height };
  };

  // ---- edges (pure): orthogonal, out of the bottom of a node, into the top of the next, rounded corners, an arrow
  // pointing down. ortho() rounds the corners of a polyline of horizontal and vertical segments.
  const ortho = (pts, rad = 10) => { const q = pts.filter((p, i) => !i || Math.abs(p[0] - pts[i - 1][0]) + Math.abs(p[1] - pts[i - 1][1]) > 0.5);
    let d = `M${r1(q[0][0])} ${r1(q[0][1])}`;
    for (let i = 1; i < q.length; i++) { const [x, y] = q[i]; if (i === q.length - 1) { d += x === q[i - 1][0] ? ` V${r1(y)}` : ` H${r1(x)}`; break; }
      const [px, py] = q[i - 1], [nx, ny] = q[i + 1]; const r = Math.min(rad, Math.hypot(x - px, y - py) / 2, Math.hypot(nx - x, ny - y) / 2);
      const ax = x - Math.sign(x - px) * r, ay = y - Math.sign(y - py) * r, bx = x + Math.sign(nx - x) * r, by = y + Math.sign(ny - y) * r;
      d += (ax === px ? ` V${r1(ay)}` : ` H${r1(ax)}`) + ` Q${r1(x)} ${r1(y)} ${r1(bx)} ${r1(by)}`; }
    return d; };
  // opts: { lane } a clear x for a vertical that skips rows; { side } the x to go round by when the edge goes back up
  // (or stays in its row); { gap } the x of the gap between two frames, for an edge from a frame to another
  const edgePath = (a, b, { lane, side, gap } = {}) => {
    const x1 = a.x + a.w / 2, y1 = a.y + a.h, x2 = b.x + b.w / 2, y2 = b.y; const under = y1 + 16, over = y2 - 16;
    if (gap != null) return ortho([[x1, y1], [x1, under], [gap, under], [gap, over], [x2, over], [x2, y2]]);
    if (y2 - y1 >= 24) {
      if (lane != null && Math.abs(lane - x2) > 0.5) return ortho([[x1, y1], [x1, under], [lane, under], [lane, over], [x2, over], [x2, y2]]);
      if (Math.abs(x2 - x1) < 1) return `M${r1(x1)} ${r1(y1)} V${r1(y2)}`;
      const my = y2 - Math.min(20, (y2 - y1) / 2); return ortho([[x1, y1], [x1, my], [x2, my], [x2, y2]]);
    }
    const sx = side != null ? side : Math.max(a.x + a.w, b.x + b.w) + 16; // back up: round by the side, over the target
    return ortho([[x1, y1], [x1, under], [sx, under], [sx, over], [x2, over], [x2, y2]]);
  };
  const arrow = (b) => { const x = r1(b.x + b.w / 2), y = b.y; return `M${x - 4} ${y - 6} L${x} ${y} L${x + 4} ${y - 6} Z`; };
  // where an edge goes: the gap between frames when it crosses phases, the frame's side when it goes back up, a lane
  // clear of the rows it skips (the target's centre, the source's, else the frame's side)
  const route = (L, a, b) => {
    const fa = L.plans.find((p) => p.id === a.plan), fb = L.plans.find((p) => p.id === b.plan); if (!fa || !fb) return {};
    if (fa !== fb) return { gap: fa.x < fb.x ? fb.x - GAP / 2 : fb.x + fb.w + GAP / 2 };
    const side = fa.x + fa.w - PAD / 2;
    if (b.y - (a.y + a.h) < 24) return { side };
    const between = Object.values(L.pos).filter((p) => p.plan === a.plan && p.y > a.y + a.h && p.y + p.h < b.y);
    if (!between.length) return {};
    const clear = (x) => between.every((p) => x < p.x - 6 || x > p.x + p.w + 6);
    const x2 = b.x + b.w / 2, x1 = a.x + a.w / 2; return { lane: clear(x2) ? x2 : clear(x1) ? x1 : side };
  };

  // ---- keyboard and pointer (pure): where an arrow goes, what a click on a node does. With a layout: ↓ ↑ to the
  // nearest node of the next or previous row of the frame, → ← to the neighbour in the row then to the next or previous
  // frame (its row of the same rank), and the opposite arrow right after a move goes back; Home End the ends. With a bare list: the neighbour in it, both ways.
  const BACK = { ArrowUp: 'ArrowDown', ArrowDown: 'ArrowUp', ArrowLeft: 'ArrowRight', ArrowRight: 'ArrowLeft' };
  // came: { from, to, key } the last move; the opposite arrow from where it landed goes back where it came from
  const step = (nav, id, key, came) => { if (came && came.to === id && came.from !== id && BACK[key] === came.key) return came.from; const order = Array.isArray(nav) ? nav : nav && nav.order; if (!order || !order.length) return null;
    if (key === 'Home') return order[0]; if (key === 'End') return order[order.length - 1];
    const d = key === 'ArrowDown' || key === 'ArrowRight' ? 1 : key === 'ArrowUp' || key === 'ArrowLeft' ? -1 : 0; if (!d) return null;
    const i = order.indexOf(id); if (i < 0) return order[0];
    if (Array.isArray(nav) || !nav.grid || !nav.at || !nav.at[id]) return order[Math.min(order.length - 1, Math.max(0, i + d))];
    const { f, r, i: j } = nav.at[id]; const rows = nav.grid[f]; const cx = (q) => nav.pos[q].x + nav.pos[q].w / 2;
    if (key === 'ArrowDown' || key === 'ArrowUp') { const row = rows[r + d]; if (!row) return id; const x = cx(id); return row.reduce((best, q) => (Math.abs(cx(q) - x) < Math.abs(cx(best) - x) ? q : best), row[0]); }
    const row = rows[r]; if (row[j + d]) return row[j + d];
    const next = nav.grid[f + d]; if (!next || !next.length) return id; const to = next[Math.min(r, next.length - 1)]; return d > 0 ? to[0] : to[to.length - 1]; };
  const tap = (selected, id, canOpen) => (!id ? null : id === selected && canOpen ? 'open' : 'select');

  // ---- markup (pure): frames, column labels, the edges in one SVG, the nodes as focusable blocks
  // the « À toi · Verbe » pill: the one thing on a card that asks the developer; a click on it makes the gesture (onAct)
  const youHtml = (n) => (n.mine && n.you ? `<span class="cv-you" data-cv-act>${esc(n.you)}</span>` : '');
  const etaHtml = (n) => (n.eta ? `<span class="cv-eta"${n.etaTip ? ` title="${esc(n.etaTip)}"` : ''}>${esc(n.eta)}</span>` : '');
  // a plan with live sessions says it in its title, at every zoom (« 2 tournent », Dev 2026-11-06)
  const runsHtml = (p) => (p.runs ? `<span class="cv-runs"><span class="cv-pulse" aria-hidden="true"></span>${esc(p.runs)}</span>` : '');
  const nodeHtml = (n, p, selected, current) => {
    const label = n.label || `${n.letter}, ${n.name}, ${n.state || ''}${n.cost ? ', ' + n.cost : ''}${n.eta ? ', ' + n.eta : ''}`;
    const width = Math.max(0, Math.min(100, (Number(n.frac) || 0) * 100));
    return `<div class="cv-node ${n.tone || ''}${n.mine ? ' mine' : ''}${n.faded ? ' faded' : ''}${selected === n.id ? ' sel' : ''}" data-id="${esc(n.id)}" role="button" tabindex="${current === n.id ? 0 : -1}" aria-expanded="${selected === n.id}" aria-label="${esc(label)}" style="left:${p.x}px;top:${p.y}px">
<span class="cv-badge">${esc(n.letter)}</span><span class="cv-name">${esc(n.name)}</span><span class="cv-s">${n.mine && n.you ? youHtml(n) : `<span class="cv-state"${n.tone === 'run' && n.state ? ` title="${esc(n.state)}"` : ''}>${esc(n.state || '')}</span>`}<span class="cv-cost">${esc(n.cost || '')}</span></span>${etaHtml(n)}<span class="cv-track" aria-hidden="true"><i style="width:${width}%"></i></span>${n.tone === 'run' ? '<span class="cv-pulse" aria-hidden="true"></span>' : ''}</div>`; };
  // the end node of a plan: what happens after it, in two lines, with the pill when it waits for the developer's click
  const endHtml = (n, p, selected, current) => {
    const label = n.label || `${n.title}${n.sub ? ', ' + n.sub : ''}${n.eta ? ', ' + n.eta : ''}`;
    return `<div class="cv-node cv-end ${n.tone || ''}${n.mine ? ' mine' : ''}${n.faded ? ' faded' : ''}${selected === n.id ? ' sel' : ''}" data-id="${esc(n.id)}" role="button" tabindex="${current === n.id ? 0 : -1}" aria-expanded="${selected === n.id}" aria-label="${esc(label)}" style="left:${p.x}px;top:${p.y}px">
<span class="cv-end-t">${esc(n.title || '')}</span>${youHtml(n)}<span class="cv-end-s">${esc(n.sub || '')}${n.eta ? `<span class="cv-eta"${n.etaTip ? ` title="${esc(n.etaTip)}"` : ''}>${esc(n.eta)}</span>` : ''}</span></div>`; };
  const markup = (graph, L, { selected = null, current = selected || (L.order && L.order[0]) } = {}) => {
    const frames = L.plans.map((p) => `${p.framed ? `<div class="cv-frame${p.waiting ? ' waiting' : ''}" data-plan="${esc(p.id)}" style="left:${p.x}px;top:${p.y}px;width:${p.w}px;height:${p.h}px">${p.href ? `<a class="cv-frame-t" href="${esc(p.href)}" data-cv-link>${esc(p.title)}${runsHtml(p)}</a>` : `<b class="cv-frame-t">${esc(p.title)}${runsHtml(p)}</b>`}<span class="cv-frame-s">${esc(p.sub)}</span></div>` : ''}${p.rows.map((c) => `<span class="cv-col" style="left:${c.x}px;top:${c.y}px;width:${c.w}px">${esc(c.label)}</span>`).join('')}`).join('');
    const paths = (graph.edges || []).map((e) => { const a = L.pos[e.from], b = L.pos[e.to]; if (!a || !b) return ''; const cls = `cv-edge ${e.kind || ''}${e.met ? ' met' : ''}`;
      return `<path class="${cls}" data-from="${esc(e.from)}" data-to="${esc(e.to)}" d="${edgePath(a, b, route(L, a, b))}" vector-effect="non-scaling-stroke"/><path class="cv-arrow" data-from="${esc(e.from)}" data-to="${esc(e.to)}" d="${arrow(b)}"/>`; }).join('');
    const svg = `<svg class="cv-edges" width="${Math.max(1, L.w)}" height="${Math.max(1, L.h)}" aria-hidden="true">${paths}</svg>`;
    const byId = new Map((graph.nodes || []).map((n) => [n.id, n])); // in reading order: the first in the DOM is the first one reads
    const ends = new Map((graph.ends || []).map((n) => [n.id, n]));
    const nodes = (L.order || []).map((id) => (byId.has(id) ? nodeHtml(byId.get(id), L.pos[id], selected, current) : ends.has(id) ? endHtml(ends.get(id), L.pos[id], selected, current) : '')).join('');
    return frames + svg + nodes;
  };

  // ---- the component
  const CSS = `
/* the ground: a dot grid, lighter than any line of the graph (lines would read as edges), moved and scaled with the view */
.cv-board { position: relative; overflow: hidden; background-color: var(--surface); background-image: radial-gradient(circle, var(--control) 0 1px, transparent 1.3px); background-size: var(--cv-dot, 24px) var(--cv-dot, 24px); background-position: var(--cv-dx, 0) var(--cv-dy, 0); border: 1px solid var(--border); border-radius: var(--radius-card, 8px); cursor: grab; touch-action: none; user-select: none; -webkit-user-select: none; outline: none; }
.cv-board.dragging { cursor: grabbing; }
.cv-board:focus-visible { box-shadow: inset 0 0 0 2px var(--accent); }
.cv-world { position: absolute; left: 0; top: 0; transform-origin: 0 0; --k: 1; }
.cv-edges { position: absolute; left: 0; top: 0; overflow: visible; pointer-events: none; }
.cv-edge { fill: none; stroke: var(--control); stroke-width: 1.5; stroke-linejoin: round; stroke-linecap: round; }
.cv-edge.wave { stroke-dasharray: 4 4; } .cv-edge.merge { stroke-dasharray: 2 5; } .cv-edge.met { stroke: var(--positive); opacity: .6; }
.cv-arrow { fill: var(--control); } .cv-arrow.met { fill: var(--positive); opacity: .6; }
.cv-edge.lit, .cv-arrow.lit { stroke: var(--accent); fill: var(--accent); opacity: 1; stroke-dasharray: none; } .cv-edge.lit { fill: none; }
.cv-frame { position: absolute; background: var(--raised); border-radius: 12px; }
.cv-frame-t { position: absolute; left: 20px; top: 14px; font-size: max(14px, calc(11px / var(--k))); line-height: 1.4; font-weight: 600; color: var(--text); white-space: nowrap; text-decoration: none; }
a.cv-frame-t:hover { text-decoration: underline; text-underline-offset: 3px; }
.cv-frame-s { position: absolute; left: 20px; top: 36px; font-size: max(13px, calc(11px / var(--k))); line-height: 1.4; color: var(--muted); white-space: nowrap; font-variant-numeric: tabular-nums; }
.cv-col { position: absolute; padding-top: 6px; color: var(--muted); font-size: max(13px, calc(11px / var(--k))); line-height: 1.4; white-space: normal; overflow-wrap: anywhere; }
.cv-node { position: absolute; width: 300px; height: 100px; padding: 14px 16px 0; background: var(--surface); border: 1px solid var(--border); border-radius: 8px; display: grid; grid-template-columns: auto minmax(0, 1fr); gap: 3px 12px; align-content: start; cursor: pointer; overflow: hidden; color: var(--text); transition: border-color var(--t-hover, 150ms) ease; }
.cv-node:hover { border-color: var(--control); }
.cv-node.sel { border: 1.5px solid var(--accent); padding: 13.5px 15.5px 0; }
/* a card that waits for the developer is told from afar (Dev, 2026-11-02): its border in the waiting ink and its pill
   with the verb; every other card stays calm */
.cv-node.mine { border-color: var(--pill-wait-ink); }
.cv-you { display: inline-flex; align-items: center; height: max(20px, calc(16px / var(--k))); padding: 0 8px; border-radius: 999px; background: var(--pill-wait-bg); color: var(--pill-wait-ink); font-size: max(12.5px, calc(11px / var(--k))); font-weight: 500; line-height: 1; white-space: nowrap; cursor: pointer; }
.cv-you:hover { text-decoration: underline; text-underline-offset: 2px; }
.cv-eta { grid-column: 2; color: var(--muted); font-size: max(12.5px, calc(11px / var(--k))); line-height: 1.3; font-variant-numeric: tabular-nums; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
/* the end node: two lines, no badge, no track; 64 px high */
.cv-end { height: 64px; padding: 12px 16px 0; grid-template-columns: minmax(0, 1fr) auto; gap: 2px 10px; background: var(--raised); border-style: dashed; }
.cv-end.mine { border-style: solid; background: var(--surface); }
.cv-end-t { font-weight: 600; font-size: max(14px, calc(11px / var(--k))); line-height: 1.35; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
.cv-end-s { grid-column: 1 / -1; display: flex; gap: 8px; color: var(--muted); font-size: max(13px, calc(11px / var(--k))); line-height: 1.4; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; min-width: 0; }
.cv-end-s .cv-eta { grid-column: auto; }
.cv-end-s .cv-eta::before { content: "·"; margin-right: 8px; }
/* the name holds two lines before it is cut (Dev, 2026-11-02: the title readable whole); the badge stays on the first */
.cv-node.faded { opacity: .3; }
.cv-node.cv-off { visibility: hidden; } /* wholly out of the view: nobody can see nor click it; the arrows bring it in */
.cv-node:focus-visible { outline: 2px solid var(--accent); outline-offset: 2px; }
/* the badge grows with its id and never runs under the name (Dev, 2026-11-02: a long id such as CURSEUR or EVALPROF
   overlapped the title); past 110 px it is cut with an ellipsis */
.cv-badge { min-width: max(28px, calc(20px / var(--k))); max-width: 110px; height: max(28px, calc(20px / var(--k))); line-height: max(28px, calc(20px / var(--k))); padding: 0 6px; box-sizing: border-box; align-self: start; border-radius: 6px; background: var(--raised); text-align: center; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; font-family: var(--mono, ui-monospace, monospace); font-weight: 500; font-size: max(13px, calc(11px / var(--k))); grid-row: 1 / 3; color: var(--text); }
.cv-name { font-weight: 500; font-size: max(14px, calc(11px / var(--k))); line-height: 1.35; display: -webkit-box; -webkit-line-clamp: 2; -webkit-box-orient: vertical; overflow: hidden; align-self: start; min-height: 28px; }
.cv-s { display: flex; justify-content: space-between; gap: 8px; color: var(--muted); font-size: max(13px, calc(11px / var(--k))); line-height: 1.4; min-width: 0; }
.cv-s .cv-state { white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
.cv-s .cv-cost { color: var(--text); font-family: var(--mono, ui-monospace, monospace); font-size: max(12.5px, calc(11px / var(--k))); font-variant-numeric: tabular-nums; white-space: nowrap; }
.cv-node.wait .cv-state, .cv-node.mine .cv-state { color: var(--pill-wait-ink); } .cv-node.done .cv-state { color: var(--positive); } .cv-node.err .cv-state { color: var(--negative); } .cv-node.run .cv-state { color: var(--accent); }
.cv-track { position: absolute; left: 0; right: 0; bottom: 0; height: 2px; background: var(--rule); } .cv-track i { display: block; height: 100%; background: var(--control); }
.cv-node.run .cv-track i { background: var(--accent); } .cv-node.done .cv-track i { background: var(--positive); } .cv-node.wait .cv-track i, .cv-node.mine .cv-track i { background: var(--pill-wait-ink); } .cv-node.err .cv-track i { background: var(--negative); }
.cv-world.low .cv-node { grid-template-rows: 1fr; } .cv-world.low .cv-node .cv-s, .cv-world.low .cv-node .cv-eta { display: none; } .cv-world.low .cv-node .cv-badge { grid-row: 1; }
/* the pill stays at every zoom: it is the signal; it takes its own line under the name, never over it (ATOI, Dev 7 Nov.:
   the badge was laid over the title) */
.cv-world.low .cv-node.mine { grid-template-rows: auto auto; } .cv-world.low .cv-node.mine .cv-badge { grid-row: 1 / 3; }
.cv-world.low .cv-node.mine .cv-s { display: flex; grid-column: 2; justify-content: flex-start; min-width: 0; } .cv-world.low .cv-node.mine .cv-s .cv-cost { display: none; }
.cv-world.low .cv-node.mine .cv-name { -webkit-line-clamp: 1; min-height: 0; } .cv-world.low .cv-node.mine .cv-you { max-width: 100%; overflow: hidden; text-overflow: ellipsis; }
.cv-world.low .cv-end .cv-end-s { display: none; }
.cv-world.low .cv-col, .cv-world.low .cv-frame-s { display: none; } /* under 0,8 the letters and the names stay, the rest comes back with the zoom */
.cv-world.low .cv-node:not(.mine):hover .cv-s, .cv-world.low .cv-node:not(.mine).sel .cv-s { display: flex; position: absolute; left: 0; right: 0; bottom: 2px; padding: 0 16px; background: var(--surface); font-size: max(13px, calc(11px / var(--k))); line-height: 1.5; }
.cv-world.low .cv-node .cv-s .cv-cost { font-size: inherit; }
/* a running card is told at once (Dev, 2026-11-06): an accent edge, the breathing dot (still under reduced motion,
   app.css), its activity line in the ink instead of its bare state, its cost; both stay at every zoom, never only on hover */
.cv-node.run { border-color: color-mix(in srgb, var(--accent) 45%, var(--border)); box-shadow: inset 3px 0 0 var(--accent); }
.cv-node.run.sel { border-color: var(--accent); }
.cv-node .cv-pulse { position: absolute; top: 10px; right: 10px; width: max(8px, calc(6px / var(--k))); height: max(8px, calc(6px / var(--k))); }
.cv-node.run .cv-state { color: var(--text); } .cv-node.run .cv-state::before { content: "▸ "; color: var(--accent); }
.cv-world.low .cv-node.run .cv-s { display: flex; position: absolute; left: 0; right: 0; bottom: 2px; padding: 0 16px; background: var(--surface); font-size: max(13px, calc(11px / var(--k))); line-height: 1.5; }
.cv-runs { display: inline-flex; align-items: center; gap: 6px; margin-left: 10px; height: max(22px, calc(16px / var(--k))); padding: 0 8px; border-radius: 999px; background: var(--accent-tint); color: var(--accent); font-size: max(12.5px, calc(11px / var(--k))); font-weight: 500; vertical-align: middle; }
.cv-runs .cv-pulse { width: 6px; height: 6px; }
a.cv-frame-t:hover .cv-runs { text-decoration: none; }
.cv-ctl { position: absolute; right: 12px; bottom: 12px; display: flex; gap: 6px; } .cv-ctl[hidden] { display: none; }
.cv-ctl .btn { height: 32px; min-width: 32px; padding: 0 10px; background: var(--surface); }
.cv-mini { position: absolute; left: 12px; bottom: 12px; width: 160px; height: 100px; background: var(--raised); border-radius: 6px; overflow: hidden; cursor: pointer; }
.cv-mini[hidden] { display: none; }
.cv-mini i { position: absolute; background: var(--control); border-radius: 1px; } .cv-mini i.mine { background: var(--pill-wait-ink); } .cv-mini i.run { background: var(--accent); }
.cv-mini b { position: absolute; border: 1px solid var(--accent); border-radius: 2px; box-sizing: border-box; }
.cv-sticky { position: absolute; left: 0; right: 0; top: 0; padding: 10px 16px; background: var(--surface); border-bottom: 1px solid var(--border); display: flex; gap: 12px; align-items: baseline; pointer-events: none; min-width: 0; }
.cv-sticky[hidden] { display: none; }
.cv-sticky b { font-weight: 600; font-size: 13px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; min-width: 0; } .cv-sticky span { color: var(--muted); font-size: 13px; white-space: nowrap; font-variant-numeric: tabular-nums; }
.cv-empty { position: absolute; inset: 0; display: grid; place-content: center; text-align: center; color: var(--muted); padding: 24px; cursor: default; }
.cv-empty[hidden] { display: none; } .cv-empty a { color: var(--text); text-decoration: underline; text-underline-offset: 3px; }
@media (max-width: 860px) { .cv-mini, .cv-sticky { display: none; } .cv-ctl .btn { height: 36px; min-width: 36px; } }
@media (prefers-reduced-motion: reduce) { .cv-node { transition: none; } }
.cv-keys { border: 1px solid var(--border); border-radius: 12px; background: var(--surface); color: var(--text); padding: 20px 24px 24px; width: min(420px, calc(100vw - 32px)); }
.cv-keys::backdrop { background: rgb(0 0 0 / .24); }
.cv-keys header { display: flex; align-items: center; justify-content: space-between; gap: 12px; margin-bottom: 12px; }
.cv-keys h2 { font-size: var(--fs-section, 15px); font-weight: 600; }
.cv-keys dl { display: grid; grid-template-columns: max-content minmax(0, 1fr); gap: 8px 16px; margin: 0; align-items: baseline; }
.cv-keys dt { white-space: nowrap; } .cv-keys dd { margin: 0; color: var(--muted); }`;
  let styled = false;
  const style = (doc) => { if (styled || !doc || doc.getElementById('cv-style')) { styled = true; return; } const s = doc.createElement('style'); s.id = 'cv-style'; s.textContent = CSS; doc.head.appendChild(s); styled = true; };

  // the phase in flight: the one asked, else the last with a running node, else the last waiting for the developer, else the most recent (the last)
  const phaseNow = (L, graph, asked) => { const ps = L.plans; if (!ps.length) return null; const has = (p, t) => (graph.nodes || []).some((n) => n.plan === p.id && t(n));
    return ps.find((p) => p.id === asked) || ps.findLast((p) => has(p, (n) => n.tone === 'run')) || ps.findLast((p) => p.waiting) || ps[ps.length - 1]; };
  const mount = (board, opts = {}) => {
    const doc = board.ownerDocument; style(doc);
    const store = opts.key ? 'escadrille.canvas.' + opts.key : null;
    board.classList.add('cv-board'); board.tabIndex = -1; // the way in is the current node (roving): Tab never stops on the ground
    board.insertAdjacentHTML('afterbegin', `<div class="cv-world"></div><div class="cv-sticky" hidden></div><div class="cv-mini" hidden aria-label="${T('canvas.mini')}" role="img"></div><div class="cv-ctl"><button type="button" class="btn" data-cv="in" aria-label="${T('canvas.zoomIn')}">+</button><button type="button" class="btn" data-cv="out" aria-label="${T('canvas.zoomOut')}">−</button><button type="button" class="btn" data-cv="fit">${T('canvas.fit')}</button>${opts.help ? `<button type="button" class="btn" data-cv="help" aria-haspopup="dialog" aria-label="${T('canvas.keys')}">?</button>` : ''}</div><p class="cv-empty" hidden></p>`);
    const world = board.querySelector('.cv-world'), mini = board.querySelector('.cv-mini'), ctl = board.querySelector('.cv-ctl'), sticky = board.querySelector('.cv-sticky'), emptyEl = board.querySelector('.cv-empty');
    const S = { graph: null, L: null, view: { x: FIT_PAD, y: FIT_PAD, k: 1 }, selected: null, current: null, ptr: false, hover: null, mode: 'auto', inset: { right: 0 }, opened: false, saveT: null };
    const vp = () => { const r = board.getBoundingClientRect(); return { w: Math.max(1, r.width - S.inset.right), h: Math.max(1, r.height) }; };
    const bounds = () => (S.L && S.L.w ? { w: S.L.w, h: S.L.h } : null);
    const saved = () => { if (!store) return null; try { const v = JSON.parse(root.localStorage.getItem(store)); return v && Number.isFinite(v.x) && Number.isFinite(v.y) && Number.isFinite(v.k) ? { x: v.x, y: v.y, k: clampK(v.k) } : null; } catch { return null; } };
    const save = () => { if (!store) return; clearTimeout(S.saveT); S.saveT = setTimeout(() => { try { if (S.mode === 'user') root.localStorage.setItem(store, JSON.stringify(S.view)); else root.localStorage.removeItem(store); } catch {} }, 250); };
    const light = () => { const id = S.hover || S.selected; for (const p of world.querySelectorAll('.cv-edge, .cv-arrow')) p.classList.toggle('lit', !!id && (p.dataset.from === id || p.dataset.to === id)); };
    const drawMini = () => { const b = bounds(); const v = vp(); const on = !!b && !!S.graph && overflows(b, S.view, v); mini.hidden = !on; if (!on) return;
      const m = minimap(b, S.view, v); if (mini.dataset.for !== String(S.L.order.length) + ':' + m.s) { mini.dataset.for = String(S.L.order.length) + ':' + m.s;
        mini.innerHTML = S.L.order.map((id) => { const p = S.L.pos[id]; const n = S.graph.nodes.find((x) => x.id === id) || {}; return `<i class="${n.mine ? 'mine' : n.tone === 'run' ? 'run' : ''}" style="left:${r1(m.ox + p.x * m.s)}px;top:${r1(m.oy + p.y * m.s)}px;width:${Math.max(2, r1(p.w * m.s))}px;height:${Math.max(2, r1(p.h * m.s))}px"></i>`; }).join('') + '<b></b>'; }
      const vb = mini.querySelector('b'); const x = Math.max(0, m.view.x), y = Math.max(0, m.view.y); vb.style.left = x + 'px'; vb.style.top = y + 'px'; vb.style.width = Math.max(6, Math.min(MINI.w - x, m.view.w + Math.min(0, m.view.x))) + 'px'; vb.style.height = Math.max(6, Math.min(MINI.h - y, m.view.h + Math.min(0, m.view.y))) + 'px'; };
    const drawSticky = () => { const mid = vp().w / 2; const f = S.L && S.L.plans.find((p) => p.framed && S.view.y + p.y * S.view.k < 0 && S.view.y + (p.y + p.h) * S.view.k > 48 && S.view.x + p.x * S.view.k < mid && S.view.x + (p.x + p.w) * S.view.k > mid); sticky.hidden = !f; if (f) sticky.innerHTML = `<b>${esc(f.title)}</b><span>${esc(f.sub)}</span>`; };
    const apply = () => { const v = S.view; world.style.transform = `translate(${v.x}px, ${v.y}px) scale(${v.k})`; world.style.setProperty('--k', String(v.k)); const g = DOT * v.k; board.style.setProperty('--cv-dot', g + 'px'); board.style.setProperty('--cv-dx', r1(((v.x % g) + g) % g - g / 2) + 'px'); board.style.setProperty('--cv-dy', r1(((v.y % g) + g) % g - g / 2) + 'px'); world.classList.toggle('low', v.k < 0.8); paint(); drawMini(); drawSticky(); };
    const setView = (v, user) => { S.view = clampView({ ...v, k: clampK(v.k) }, bounds(), vp()); if (user) S.mode = 'user'; apply(); save(); };
    const opening = () => { const b = bounds(); const v = vp(); if (!b) return; const kept = saved(); if (kept) { S.mode = 'user'; S.view = clampView(kept, b, v); apply(); return; }
      // « Ajuster » when the whole graph fits at 1, else the phase in flight framed by its width (0,5 – 1), its top on top
      S.mode = 'auto'; const whole = fit(b, v); const plan = whole.k < 1 && phaseNow(S.L, S.graph, opts.openPlan);
      S.view = plan ? frame(plan, v, Math.min(FIT_MAX, (v.w - 2 * FIT_PAD) / plan.w)) : whole; apply(); };
    // one node is in the Tab order: the one last focused, else the selected one, else the first one in view (reading
    // order); a node wholly out of the view is hidden (the others are drawn), except that one
    const nodeEl = (id) => (id ? world.querySelector(`.cv-node[data-id="${CSS_escape(id)}"]`) : null);
    const inView = (id, v = vp()) => seen(S.L.pos[id], S.view, v);
    const current = () => { if (!S.L) return null; if (S.current && S.L.pos[S.current]) return S.current; if (S.selected && S.L.pos[S.selected]) return S.selected; const v = vp(); return S.L.order.find((id) => inView(id, v)) || S.L.order[0] || null; };
    const paint = () => { if (!S.L) return; const cur = current(); const v = vp(); for (const n of world.querySelectorAll('.cv-node')) { const id = n.dataset.id; n.tabIndex = id === cur ? 0 : -1; n.classList.toggle('cv-off', id !== cur && !!S.L.pos[id] && !inView(id, v)); } };
    const rove = paint;
    const focusedId = () => { const a = doc.activeElement; const n = a && world.contains(a) && a.closest('.cv-node'); return n ? n.dataset.id : null; };
    // a re-render (the live stream) keeps the focused node focused, and moves nothing
    const render = () => { const had = focusedId(); world.innerHTML = S.graph ? markup(S.graph, S.L, { selected: S.selected, current: current() }) : ''; rove(); light(); mini.dataset.for = '';
      if (had) { const el = nodeEl(had); if (el) { S.quiet = true; el.focus({ preventScroll: true }); S.quiet = false; } } apply(); };

    const api = {
      setData(graph, { empty = '' } = {}) { S.graph = graph; S.L = layout(graph); const none = !S.L.order.length;
        emptyEl.hidden = !none; emptyEl.innerHTML = none ? empty : ''; ctl.hidden = none; board.classList.toggle('empty', none);
        if (S.selected && !S.L.pos[S.selected]) S.selected = null; render(); if (!S.opened && !none) { S.opened = true; opening(); } else apply(); },
      setSelected(id, { reveal = true } = {}) { S.selected = id || null; if (S.selected) S.current = S.selected; for (const n of world.querySelectorAll('.cv-node')) { const on = n.dataset.id === S.selected; n.classList.toggle('sel', on); n.setAttribute('aria-expanded', String(on)); } rove(); light(); if (reveal && S.selected) api.reveal(S.selected); },
      // Échap or ×: the detail closes, the node is deselected and gets the focus back
      close() { const id = S.selected; if (!id) return false; api.setSelected(null, { reveal: false }); if (opts.onSelect) opts.onSelect(null); api.focusNode(id); return true; },
      focusNode(id) { if (!S.L || !S.L.pos[id]) return; S.current = id; api.reveal(id); rove(); const el = nodeEl(id); if (el) el.focus({ preventScroll: true }); },
      focused: focusedId, selected() { return S.selected; },
      fit() { const b = bounds(); if (!b) return; S.mode = 'auto'; S.view = fit(b, vp()); apply(); save(); },
      frame(planId) { const p = S.L && S.L.plans.find((x) => x.id === planId); if (p) setView(frame(p, vp(), 1), true); },
      zoom(f, cx, cy) { const v = vp(); setView(zoomAt(S.view, f, cx ?? v.w / 2, cy ?? v.h / 2), true); },
      // Pan the least needed so a node is fully in view (focus by keyboard, a pick from the phone's list)
      // the foot keeps the room of the mini-map and the buttons (124 px): a revealed node is never under them
      reveal(id) { const p = S.L && S.L.pos[id]; if (!p) return; const v = vp(); const k = S.view.k; let { x, y } = S.view; const m = 16; const mb = v.h > 360 ? 124 : m;
        const l = p.x * k + x, t = p.y * k + y, r = l + p.w * k, b = t + p.h * k;
        if (l < m) x += m - l; else if (r > v.w - m) x -= r - (v.w - m); if (t < m) y += m - t; else if (b > v.h - mb) y -= b - (v.h - mb);
        if (x !== S.view.x || y !== S.view.y) setView({ x, y, k }, true); },
      setInset(inset) { S.inset = { right: 0, ...inset }; apply(); }, // a side panel narrows the viewport « Ajuster » and reveal() use; the view does not jump
      view() { return { ...S.view }; }, layout() { return S.L; }, mode() { return S.mode; },
      destroy() { if (ro) ro.disconnect(); for (const [name, f, o] of handlers) board.removeEventListener(name, f, o); },
    };

    // ---- pointer: drag the ground (or a node: a drag never selects), two fingers pinch, the wheel pans or zooms.
    // No capture at pointerdown: with it the click went to the board and a node never opened (phase 11, cause E). The
    // node under the pointer is kept at pointerdown and picked at pointerup when nothing moved; the capture starts
    // with the drag.
    const ptrs = new Map(); let drag = null; let moved = false; let pinch = null;
    const isStatic = (t) => t.closest && t.closest('.cv-ctl, .cv-mini, [data-cv-static], a[data-cv-link]');
    const pickNode = (id) => { const what = tap(S.selected, id, !!opts.onOpen); if (what === 'open') opts.onOpen(id); else if (what === 'select') { api.setSelected(id, { reveal: false }); if (opts.onSelect) opts.onSelect(id); } };
    const onDown = (e) => { if (isStatic(e.target) || (e.pointerType === 'mouse' && e.button !== 0)) return; ptrs.set(e.pointerId, { x: e.clientX, y: e.clientY }); S.ptr = true;
      if (ptrs.size === 2) { const [a, b] = [...ptrs.values()]; pinch = { d: Math.hypot(a.x - b.x, a.y - b.y), cx: (a.x + b.x) / 2, cy: (a.y + b.y) / 2 }; drag = null; return; }
      const n = e.target.closest('.cv-node'); drag = { x: e.clientX, y: e.clientY, vx: S.view.x, vy: S.view.y, id: n ? n.dataset.id : null, act: !!(n && opts.onAct && e.target.closest('[data-cv-act]')) }; moved = false; };
    const onMove = (e) => { if (!ptrs.has(e.pointerId)) return; ptrs.set(e.pointerId, { x: e.clientX, y: e.clientY });
      if (pinch && ptrs.size === 2) { const [a, b] = [...ptrs.values()]; const d = Math.hypot(a.x - b.x, a.y - b.y); const cx = (a.x + b.x) / 2, cy = (a.y + b.y) / 2; const r = board.getBoundingClientRect();
        let v = zoomAt(S.view, d / (pinch.d || d), cx - r.left, cy - r.top); v = { ...v, x: v.x + cx - pinch.cx, y: v.y + cy - pinch.cy }; pinch = { d, cx, cy }; moved = true; setView(v, true); return; }
      if (!drag) return; const dx = e.clientX - drag.x, dy = e.clientY - drag.y; if (!moved && Math.hypot(dx, dy) < 4) return;
      if (!moved) { moved = true; board.classList.add('dragging'); try { board.setPointerCapture(e.pointerId); } catch {} }
      setView({ k: S.view.k, x: drag.vx + dx, y: drag.vy + dy }, true); };
    const onUp = (e) => { const d = drag; const wasPinch = !!pinch; ptrs.delete(e.pointerId); if (ptrs.size < 2) pinch = null;
      if (!ptrs.size) { drag = null; S.ptr = false; board.classList.remove('dragging'); if (e.type === 'pointerup' && d && d.id && !moved && !wasPinch) { if (d.act) opts.onAct(d.id); else pickNode(d.id); } setTimeout(() => { moved = false; }, 0); } };
    const onWheel = (e) => { if (isStatic(e.target)) return; e.preventDefault(); const r = board.getBoundingClientRect();
      if (e.ctrlKey || e.metaKey) setView(zoomAt(S.view, Math.exp(-e.deltaY * 0.01), e.clientX - r.left, e.clientY - r.top), true);
      else setView({ k: S.view.k, x: S.view.x - e.deltaX, y: S.view.y - e.deltaY }, true); };
    // the click is for the controls and the mini-map only: a node is picked at pointerup
    const onClick = (e) => { const c = e.target.closest('[data-cv]'); const v = vp();
      if (c) { if (c.dataset.cv === 'help') { if (opts.help) opts.help(); } else if (c.dataset.cv === 'fit') api.fit(); else api.zoom(c.dataset.cv === 'in' ? 1.25 : 0.8, v.w / 2, v.h / 2); return; }
      if (e.target.closest('.cv-mini')) { const b = bounds(); if (!b) return; const m = minimap(b, S.view, v); const r = mini.getBoundingClientRect(); setView(centreOn(S.view, (e.clientX - r.left - m.ox) / m.s, (e.clientY - r.top - m.oy) / m.s, v), true); } };
    const onKey = (e) => { if (/^(INPUT|TEXTAREA|SELECT)$/.test(e.target.tagName) || e.altKey || (e.target.closest && e.target.closest('[data-cv-static]'))) return; const v = vp(); const n = e.target.closest && e.target.closest('.cv-node');
      if (e.metaKey || e.ctrlKey) return;
      if (e.key === '+' || e.key === '=') { e.preventDefault(); api.zoom(1.25, v.w / 2, v.h / 2); return; }
      if (e.key === '-') { e.preventDefault(); api.zoom(0.8, v.w / 2, v.h / 2); return; }
      if (e.key === '0') { e.preventDefault(); api.fit(); return; }
      if (!n) return; const id = n.dataset.id;
      // both ways: ↓ → the next node in reading order, ↑ ← the one before, Home End the ends; an open detail follows
      if (/^(Arrow(Up|Down|Left|Right)|Home|End)$/.test(e.key)) { e.preventDefault(); const to = step(S.L || [], id, e.key, S.came); if (!to || to === id) return; S.came = { from: id, to, key: e.key };
        api.focusNode(to); if (S.selected) { api.setSelected(to); if (opts.onSelect) opts.onSelect(to); } return; }
      if (e.key === 'Enter') { e.preventDefault(); if (opts.onOpen) opts.onOpen(id); else pickNode(id); return; }
      if (e.key === ' ') { e.preventDefault(); if (S.selected !== id) { api.setSelected(id, { reveal: false }); if (opts.onSelect) opts.onSelect(id); } } };
    const CSS_escape = (s) => (root.CSS && root.CSS.escape ? root.CSS.escape(s) : String(s).replace(/["\\]/g, '\\$&'));
    const onOver = (e) => { const n = e.target.closest && e.target.closest('.cv-node'); const id = n ? n.dataset.id : null; if (id === S.hover) return; S.hover = id; light(); if (opts.onHover) opts.onHover(id); };
    // a focus by the keyboard brings the node into view; a focus by the pointer moves nothing (the node is under it)
    const onFocus = (e) => { const n = e.target.closest && e.target.closest('.cv-node'); if (n) { if (S.current !== n.dataset.id) { S.current = n.dataset.id; rove(); } if (!S.ptr && !S.quiet) api.reveal(n.dataset.id); } board.scrollLeft = 0; board.scrollTop = 0; };
    // the board never scrolls: what scrolled it (a focus, a scrollIntoView) becomes a move of the view
    const onScroll = () => { const dx = board.scrollLeft, dy = board.scrollTop; if (!dx && !dy) return; board.scrollLeft = 0; board.scrollTop = 0; if (S.L) setView({ k: S.view.k, x: S.view.x - dx, y: S.view.y - dy }, true); };
    const handlers = [['pointerdown', onDown], ['pointermove', onMove], ['pointerup', onUp], ['pointercancel', onUp], ['wheel', onWheel, { passive: false }], ['click', onClick], ['keydown', onKey], ['pointerover', onOver], ['pointerout', onOver], ['focusin', onFocus], ['scroll', onScroll]];
    for (const [name, f, o] of handlers) board.addEventListener(name, f, o);
    // a resize re-frames an untouched view and keeps a moved one reachable; a detached board (no size) changes nothing
    const ro = typeof ResizeObserver !== 'undefined' ? new ResizeObserver(() => { const r = board.getBoundingClientRect(); if (!S.L || !r.width || !r.height) return; if (S.mode === 'auto') opening(); else setView(S.view); }) : null; if (ro) ro.observe(board);
    return api;
  };

  // ---- the screen (Flot, a plan): Échap and the « ? » help. public/ux.js (session G) takes them over when it is there:
  // the generic part (a details, an aria-expanded) is left to it, the page's own Échap (its detail) stays here.
  const identity = (el) => { if (!el || !el.tagName || el === el.ownerDocument.body) return null; const q = (v) => (root.CSS && root.CSS.escape ? root.CSS.escape(v) : String(v).replace(/["\\]/g, '\\$&'));
    if (el.id) return '#' + q(el.id); const attrs = [...el.attributes].filter((a) => a.name.startsWith('data-') && a.name !== 'data-i18n'); return attrs.length ? el.tagName.toLowerCase() + attrs.map((a) => `[${a.name}="${q(a.value)}"]`).join('') : null; };
  // a full render replaced the focused element: the focus goes to its twin (same id or same data-*), without scrolling
  const keepFocus = (doc, fn) => { const sel = identity(doc.activeElement); fn(); if (!sel || (doc.activeElement && doc.activeElement !== doc.body)) return; const el = doc.querySelector(sel); if (el) el.focus({ preventScroll: true }); };
  const keyLine = (keys, verb) => `<dt>${keys.map((k) => `<kbd>${esc(k)}</kbd>`).join(' ')}</dt><dd>${esc(verb)}</dd>`;
  const screen = ({ keys = () => [], escape = () => false, doc = root.document } = {}) => {
    let dlg = null; let back = null;
    const help = () => { if (root.escadrilleUX && root.escadrilleUX.keys) return root.escadrilleUX.keys(keys());
      if (!dlg) { dlg = doc.createElement('dialog'); dlg.className = 'cv-keys'; dlg.setAttribute('aria-labelledby', 'cv-keys-h'); doc.body.appendChild(dlg);
        dlg.addEventListener('close', () => { if (back && back.isConnected) back.focus({ preventScroll: true }); back = null; });
        dlg.addEventListener('click', (e) => { if (e.target === dlg || e.target.closest('[data-cv-keys-close]')) dlg.close(); }); }
      if (dlg.open) return; back = doc.activeElement;
      dlg.innerHTML = `<header><h2 id="cv-keys-h">${esc(T('canvas.keys'))}</h2><button type="button" class="btn ghost" data-cv-keys-close aria-label="${esc(T('canvas.close'))}">×</button></header><dl>${keys().map(([k, v]) => keyLine(k, v)).join('')}</dl>`;
      dlg.showModal(); };
    const field = (t) => t && /^(INPUT|TEXTAREA|SELECT)$/.test(t.tagName);
    doc.addEventListener('keydown', (e) => { if (e.key === '?' && !field(e.target) && !e.metaKey && !e.ctrlKey && !e.altKey && !e.defaultPrevented) { e.preventDefault(); help(); } });
    // in capture on window: before any other listener, so the last thing opened closes first
    root.addEventListener('keydown', (e) => { if (e.key !== 'Escape' || e.defaultPrevented || doc.querySelector('dialog[open]')) return;
      if (escape(e)) { e.preventDefault(); e.stopPropagation(); return; }
      if (root.escadrilleUX) return; const a = doc.activeElement; if (!a || !a.closest) return;
      const d = a.closest('details[open]'); if (d && !field(a)) { e.preventDefault(); d.open = false; const s = d.querySelector('summary'); if (s) s.focus({ preventScroll: true }); return; }
      const x = a.closest('[aria-expanded="true"]:not(.cv-node)'); if (x) { e.preventDefault(); const sel = identity(x); x.click(); const el = (sel && doc.querySelector(sel)) || x; if (el.isConnected) el.focus({ preventScroll: true }); } }, true);
    return { help };
  };
  // the canvas's own keys, as the help says them
  const canvasKeys = () => [[['←', '→', '↑', '↓'], T('canvas.k.move')], [[T('canvas.kHome'), T('canvas.kEnd')], T('canvas.k.ends')], [[T('canvas.kSpace')], T('canvas.k.select')], [[T('main.enter')], T('canvas.k.open')], [[T('canvas.kEsc')], T('canvas.k.close')], [['+', '−'], T('canvas.k.zoom')], [['0'], T('canvas.k.fit')]];
  const commonKeys = () => [[['1', '2', '3', '4'], T('canvas.k.screens')], [['?'], T('canvas.k.help')]];

  root.EscadrilleCanvas = { NODE_W, NODE_H, END_H, PITCH, MAXC, GAP, ZMIN, ZMAX, phaseNow, geometry: { clampK, toWorld, toScreen, zoomAt, clampView, fit, frame, overflows, minimap, centreOn, seen }, columnLabel, layout, edgePath, route, arrow, markup, step, tap, identity, keepFocus, screen, canvasKeys, commonKeys, mount };
})(typeof window !== 'undefined' ? window : globalThis);
