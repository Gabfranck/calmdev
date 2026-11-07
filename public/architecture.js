// The architecture map page (docs/architecture.md): GET /api/architecture and /api/architecture/delta, drawn in SVG by
// hand. ?project=&ref= the map; &base=&head= or ?plan=&session= the delta coloured on the head's map.
(() => {
  const P = window.escadrilleProjects;
  const $ = (id) => document.getElementById(id);
  const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  const T = (k, v) => window.T(k, v);
  const fmt = (n) => window.T.num(Number(n || 0));
  const plural = (n, key) => T(key, { n: Number(n || 0) });
  const ROLES = ['pages', 'routes', 'lib', 'migrations', 'scripts', 'config', 'tests'];
  const ROLE = { pages: 'Pages', routes: 'Routes', lib: 'Lib', migrations: 'Migrations', scripts: 'Scripts', config: 'Config', tests: 'Tests' };
  const TOP_EDGES = 12;

  const q = new URLSearchParams(location.search);
  let project = q.get('project') || localStorage.getItem('escadrille.project') || null;
  const planId = q.get('plan'); const sessionId = q.get('session');
  const base = q.get('base'); const head = q.get('head') || q.get('ref') || null;
  const isDelta = !!(planId && sessionId) || !!(base && head);
  let map = null; let delta = null; let baseMap = null; let selected = decodeURIComponent((location.hash.match(/^#m=(.+)$/) || [])[1] || '') || null; let allEdges = false;

  // ---------------------------------------------------------------- data
  const api = async (path) => { const r = await fetch(path); const b = await r.json(); if (!r.ok) throw new Error(b.error || r.statusText); return b; };
  const qs = (o) => Object.entries(o).filter(([, v]) => v).map(([k, v]) => `${k}=${encodeURIComponent(v)}`).join('&');
  const load = async () => {
    const target = planId ? { plan: planId, session: sessionId } : { project };
    map = await api('/api/architecture?' + qs({ ...target, ref: planId ? null : head }));
    if (isDelta) {
      delta = await api('/api/architecture/delta?' + qs(planId ? target : { project, base, head }));
      if (delta.removed.modules.length) baseMap = await api('/api/architecture?' + qs({ project: delta.repo, ref: delta.baseSha }));
    }
  };

  // ---------------------------------------------------------------- the status of each module in the delta
  const statusOf = (id) => {
    if (!delta) return null;
    if (delta.added.modules.includes(id)) return 'added';
    if (delta.removed.modules.includes(id)) return 'removed';
    if (delta.changedModules.some((c) => c.id === id)) return 'changed';
    return null;
  };
  const changeOf = (id) => delta?.changedModules.find((c) => c.id === id) || null;
  const modulesShown = () => {
    const mods = [...map.modules];
    if (baseMap) for (const id of delta.removed.modules) { const m = baseMap.modules.find((x) => x.id === id); if (m) mods.push(m); }
    return mods;
  };

  // ---------------------------------------------------------------- the layout: one column per role present
  const boxH = (lines) => Math.round(44 + Math.min(72, Math.sqrt(lines || 0) * 1.4));
  const layout = (width) => {
    const mods = modulesShown();
    const roles = ROLES.filter((r) => mods.some((m) => m.role === r));
    const gap = width < 600 ? 20 : 32; const n = Math.max(1, roles.length);
    const colW = Math.max(132, Math.min(320, Math.floor((width - gap * (n - 1)) / n)));
    const pos = new Map(); let height = 0;
    roles.forEach((role, ci) => {
      let y = 30;
      const inCol = mods.filter((m) => m.role === role).sort((a, b) => b.lines - a.lines || a.id.localeCompare(b.id));
      for (const m of inCol) { const h = boxH(m.lines); pos.set(m.id, { x: ci * (colW + gap), y, w: colW, h, col: ci, m }); y += h + 10; }
      height = Math.max(height, y);
    });
    return { roles, colW, gap, pos, width: n * colW + (n - 1) * gap, height: height + 4 };
  };
  // The code root: the top folder that holds most of the files (server/, src/), else none; a name is the last two
  // segments under it, the same rule for every box (server/domains/questions → domains/questions, server/config → config)
  const codeRoot = () => { const n = {}; let all = 0; for (const m of map.modules) { const t = m.id.split('/')[0]; n[t] = (n[t] || 0) + m.files.length; all += m.files.length; } const top = Object.entries(n).sort((a, b) => b[1] - a[1])[0]; return top && top[0] !== '.' && top[1] > all / 2 ? top[0] + '/' : ''; };
  const label = (id, w) => { if (id === '.') return T('arch.rootShort'); const root = codeRoot(); const rest = root && id.startsWith(root) ? id.slice(root.length) : id; const s = rest.split('/').slice(-2).join('/'); const max = Math.floor((w - 20) / 6.6); return s.length <= max ? s : s.slice(0, max - 1) + '…'; };

  const edgesShown = () => {
    const edges = map.edges.map((e) => ({ ...e, added: !!delta?.added.edges.some((a) => a.from === e.from && a.to === e.to) }));
    if (selected) return edges.filter((e) => e.from === selected || e.to === selected);
    if (allEdges) return edges;
    if (delta) return edges.filter((e) => e.added || statusOf(e.from) || statusOf(e.to));
    return edges.slice(0, TOP_EDGES);
  };
  let L_GAP = 32;
  const edgePath = (a, b) => {
    let ax, bx, dx;
    if (b.col > a.col) { ax = a.x + a.w; bx = b.x; dx = (bx - ax) / 2; }
    else if (b.col < a.col) { ax = a.x; bx = b.x + b.w; dx = (bx - ax) / 2; }
    else { ax = a.x + a.w; bx = b.x + b.w; const out = 14 + Math.min(L_GAP - 18, Math.abs(b.y - a.y) * 0.08); return `M${ax} ${a.y + a.h / 2} C${ax + out} ${a.y + a.h / 2}, ${bx + out} ${b.y + b.h / 2}, ${bx} ${b.y + b.h / 2}`; } // the same column: a loop in the gap, wider the further apart
    const ay = a.y + a.h / 2; const by = b.y + b.h / 2;
    return `M${ax} ${ay} C${ax + dx} ${ay}, ${bx - dx} ${by}, ${bx} ${by}`;
  };

  // ---------------------------------------------------------------- the map
  const drawMap = () => {
    const box = $('map'); const L = layout(box.clientWidth || 800); L_GAP = L.gap;
    const near = new Set(); if (selected) for (const e of map.edges) { if (e.from === selected) near.add(e.to); if (e.to === selected) near.add(e.from); }
    const edges = edgesShown().filter((e) => L.pos.has(e.from) && L.pos.has(e.to)).map((e) => {
      const a = L.pos.get(e.from); const b = L.pos.get(e.to);
      const on = selected && (e.from === selected || e.to === selected);
      const cls = ['edge', e.added ? 'added' : '', on ? 'on' : selected ? 'off' : ''].join(' ');
      return `<path class="${cls}" d="${edgePath(a, b)}" stroke-width="${Math.min(4, 1 + Math.log2(e.count)).toFixed(1)}"><title>${esc(T('arch.edgeTitle', { a: e.from, b: e.to, n: e.count }))}</title></path>`;
    }).join('');
    const heads = L.roles.map((r, i) => `<text class="col-h" x="${i * (L.colW + L.gap) + 2}" y="14">${ROLE[r]} · ${modulesShown().filter((m) => m.role === r).length}</text>`).join('');
    const boxes = [...L.pos.values()].map(({ x, y, w, h, m }) => {
      const st = statusOf(m.id); const ch = changeOf(m.id);
      const cls = ['mod', st || '', m.id === selected ? 'sel' : near.has(m.id) ? 'near' : selected ? 'dim' : ''].join(' ');
      const second = st === 'removed' ? `<tspan>${esc(T('arch.removedSvg'))}</tspan>` : ch ? `<tspan class="a">+${fmt(ch.additions)}</tspan><tspan> </tspan><tspan class="d">−${fmt(ch.deletions)}</tspan>` : `<tspan>${plural(m.lines, 'arch.lines')}</tspan>`;
      const what = ({ added: T('arch.whatAdded'), removed: T('arch.whatRemoved'), changed: T('arch.whatChanged') })[st] || '';
      return `<g class="${cls}" data-id="${esc(m.id)}" tabindex="0" role="button" aria-pressed="${m.id === selected}" aria-label="${esc(m.id)}, ${ROLE[m.role]}, ${plural(m.lines, 'arch.lines')}${what}">
        <rect x="${x}" y="${y}" width="${w}" height="${h}" rx="6"/><text class="n" x="${x + 12}" y="${y + 21}">${esc(label(m.id, w))}</text><text class="l" x="${x + 12}" y="${y + 38}">${second}</text></g>`;
    }).join('');
    box.innerHTML = `<svg width="${L.width}" height="${L.height}" viewBox="0 0 ${L.width} ${L.height}" aria-hidden="false">${heads}<g>${boxes}</g><g class="edges">${edges}</g></svg>`;
  };

  // ---------------------------------------------------------------- the rail: the module read, or the plan's lines
  const modButton = (id, extra = '') => `<button type="button" class="linkish" data-go="${esc(id)}">${esc(id === '.' ? T('arch.root') : id)}</button>${extra}`;
  const list = (items, empty, max = 30) => !items.length ? `<p class="none">${esc(empty)}</p>` : `<ul>${items.slice(0, max).join('')}</ul>${items.length > max ? `<p class="none">${esc(T('arch.andMore', { n: items.length - max }))}</p>` : ''}`;
  // the panel at the right, only while a module is selected: the map keeps the whole width otherwise
  const drawRail = () => {
    const rail = $('rail');
    const m = selected && modulesShown().find((x) => x.id === selected);
    $('arch').classList.toggle('sel', !!m); rail.hidden = !m;
    if (!m) { rail.innerHTML = ''; return; }
    const st = statusOf(m.id); const ch = changeOf(m.id); const src = st === 'removed' ? baseMap : map;
    const by = src.edges.filter((e) => e.to === m.id).map((e) => `<li>${modButton(e.from, `<span class="c">${e.count}</span>`)}</li>`);
    const uses = src.edges.filter((e) => e.from === m.id).map((e) => `<li>${modButton(e.to, `<span class="c">${e.count}</span>`)}</li>`);
    const routes = src.routes.filter((r) => r.module === m.id).map((r) => `<li>${esc(r.method)} ${esc(r.path)}</li>`);
    const tables = src.tables.filter((t) => t.module === m.id).map((t) => `<li>${esc(t.name)}<span class="c">${esc(t.kind)}</span></li>`);
    const files = m.files.map((f) => `<li>${esc(f)}</li>`);
    const pill = st ? ` <span class="pill ${{ added: 'pos', removed: 'neg', changed: 'warn' }[st]}">${{ added: esc(T('arch.added')), removed: esc(T('arch.removed')), changed: `+${fmt(ch.additions)} −${fmt(ch.deletions)}` }[st]}</span>` : '';
    rail.innerHTML = `<div><h2>${esc(m.id === '.' ? T('arch.root') : m.id)}${pill}</h2><p class="meta">${ROLE[m.role]} · ${plural(m.lines, 'arch.lines')} · ${plural(m.files.length, 'arch.files')}${m.entry ? ` · ${esc(T('arch.entry', { f: m.entry.split('/').pop() }))}` : ''}</p></div>
      <div><h3>${esc(T('arch.importedBy'))}</h3>${list(by, T('arch.nobody'))}</div>
      <div><h3>${esc(T('arch.imports'))}</h3>${list(uses, T('arch.nothing'))}</div>
      ${routes.length ? `<div><h3>${esc(T('arch.routes'))}</h3>${list(routes, '')}</div>` : ''}
      ${tables.length ? `<div><h3>${esc(T('arch.tables'))}</h3>${list(tables, '')}</div>` : ''}
      <div><h3>${esc(T('arch.filesH'))}</h3>${list(files, T('arch.none'), 40)}</div>
      <p><button type="button" class="btn" data-go="">${esc(T('arch.close'))}</button></p>`;
  };

  // ---------------------------------------------------------------- the secondary, folded: routes and tables, all the imports, compare
  const drawMore = () => {
    const deps = [...new Map(map.deps.map((d) => [d.name, d])).values()];
    const routes = map.routes.map((r) => `<li>${esc(r.method)} ${esc(r.path)} <span class="c">${esc(r.module)}</span></li>`);
    const tables = map.tables.map((t) => `<li>${esc(t.name)} <span class="c">${esc(t.module)}</span></li>`);
    const depl = deps.map((d) => `<li>${esc(d.name)} <span class="c">${esc(d.version)}${d.dev ? ' · dev' : ''}</span></li>`);
    const edgesL = map.edges.map((e) => `<li>${esc(e.from)} → ${esc(e.to)} <span class="c">${e.count}</span></li>`);
    const cmpBase = delta?.base || base || ''; const cmpHead = delta?.head || head || '';
    // a delta: the modules touched, one folded line, ranked by lines changed
    const touched = delta ? delta.changedModules.map((c) => `<li>${modButton(c.id, `<span class="c">+${fmt(c.additions)} −${fmt(c.deletions)}</span>`)}</li>`) : [];
    $('more').innerHTML = `${delta ? `<details class="acc-row" id="moreTouched"><summary><span class="acc-name">${esc(T('arch.touched'))}</span><span class="acc-line">${plural(delta.changedModules.length, 'arch.changedN')} · ${plural(delta.added.modules.length, 'arch.addedN')} · ${plural(delta.removed.modules.length, 'arch.removedN')}</span></summary>
        <div class="cols3"><div style="grid-column: 1 / -1">${delta.summary.length > 1 ? `<div class="lines">${delta.summary.slice(1).map((l) => `<p>${esc(l)}</p>`).join('')}</div>` : ''}${list(touched, T('arch.none'), 500)}</div></div></details>` : ''}
      <details class="acc-row" id="moreLists"><summary><span class="acc-name">${esc(T('arch.routesTables'))}</span><span class="acc-line">${plural(map.routes.length, 'arch.routesN')} · ${plural(map.tables.length, 'arch.tablesN')} · ${plural(deps.length, 'arch.depsN')}</span></summary>
        <div class="cols3"><div><h3>${esc(T('arch.routes'))}</h3>${list(routes, T('arch.noneSeen'), 500)}</div><div><h3>${esc(T('arch.tables'))}</h3>${list(tables, T('arch.noneSeen'), 500)}</div><div><h3>${esc(T('arch.deps'))}</h3>${list(depl, T('arch.noneF'), 500)}</div></div></details>
      <details class="acc-row" id="moreEdges" ${allEdges ? 'open' : ''}><summary><span class="acc-name">${esc(T('arch.allImports'))}</span><span class="acc-line">${esc(delta ? plural(map.edges.length, 'arch.changedOnly') : map.edges.length > TOP_EDGES ? T('arch.shownOf', { k: TOP_EDGES, n: map.edges.length }) : plural(map.edges.length, 'arch.edgesN'))}</span></summary>
        <div class="cols3"><div style="grid-column: 1 / -1">${list(edgesL, T('arch.noEdge'), 1000)}</div></div></details>
      <details class="acc-row" id="moreCompare"><summary><span class="acc-name">${esc(T('arch.compare'))}</span><span class="acc-line">${delta ? `${esc(cmpBase)} ← ${esc(cmpHead)}` : esc(T('arch.twoBranches'))}</span></summary>
        <form id="cmp"><label>${esc(T('arch.base'))}<input name="base" value="${esc(cmpBase || 'main')}" autocomplete="off" spellcheck="false"></label><label>${esc(T('arch.branch'))}<input name="head" value="${esc(cmpHead)}" placeholder="escadrille/…" autocomplete="off" spellcheck="false"></label><button class="btn" type="submit">${esc(T('arch.compare'))}</button>${delta ? ` <a class="card-link" href="${esc(P.withProject('/architecture', project))}">${esc(T('arch.mapOnly'))}</a>` : ''}</form></details>`;
  };

  // ---------------------------------------------------------------- the head
  // the title is the screen's noun (the project is in the breadcrumb); « lue dans git, rien n'est écrit » is its title
  const drawHead = () => {
    const name = P.name(project || delta?.repo || map.repo);
    document.title = `Architecture · ${name}`;
    $('title').textContent = 'Architecture';
    const lines = map.modules.reduce((s, m) => s + m.lines, 0);
    const facts = esc(`${plural(map.files, 'arch.files')} · ${plural(map.modules.length, 'arch.modules')} · ${plural(lines, 'arch.lines')}${map.skipped ? ` · ${T('arch.skipped', { n: map.skipped })}` : ''}${map.truncated ? ' · ' + T('arch.truncated') : ''}`);
    const sub = $('sub'); sub.title = T('arch.readOnly');
    sub.innerHTML = delta ? `<b>${esc(delta.summary[0])}</b> · ${esc(delta.base === 'HEAD' ? '' : delta.base)} ← ${esc(delta.head)}` : `${esc(map.ref)} · ${facts}`;
    $('stamp').textContent = map.sha.slice(0, 7);
    $('crumb').textContent = 'Architecture';
    const lg = $('legend'); lg.hidden = !delta;
    if (delta) $('legendItems').innerHTML = `<span class="add"><i></i>${esc(T('arch.added'))}</span><span class="del"><i></i>${esc(T('arch.removed'))}</span><span class="chg"><i></i>${esc(T('arch.changed'))}</span><span>${facts}</span>`;
  };
  // the delta of a plan, a select in the title row: « La carte seule », then every session of the project's plans that
  // has worked (its branch exists); choosing one reloads the page on ?plan=&session=
  const drawDeltaPick = async () => {
    const pick = $('deltaPick'); const sel = $('deltaSel'); const proj = project || delta?.repo; if (!pick || !sel || !proj) return;
    let plans = []; try { plans = (await api('/api/plans?project=' + encodeURIComponent(proj))) || []; } catch { return; }
    const recent = plans.slice(0, 8);
    const details = await Promise.all(recent.map((p) => api('/api/plan/' + encodeURIComponent(p.id)).catch(() => null)));
    const opts = [];
    recent.forEach((p, i) => { const d = details[i]; if (!d || !d.plan) return;
      for (const s of d.plan.sessions || []) { const st = (d.state || []).find((x) => (x.id || x.session) === s.id); if (!st || st.status === 'todo') continue; opts.push({ plan: p.id, session: s.id, label: `${p.title || p.id} · ${s.id}` }); } });
    if (!opts.length) return;
    sel.innerHTML = `<option value="">${esc(T('arch.mapOnly'))}</option>${opts.map((o) => `<option value="${esc(o.plan)}|${esc(o.session)}" ${planId === o.plan && sessionId === o.session ? 'selected' : ''}>${esc(o.label)}</option>`).join('')}`;
    pick.hidden = false;
  };

  const draw = () => { drawHead(); drawMap(); drawRail(); drawMore(); drawDeltaPick(); };
  document.addEventListener('change', (e) => { if (e.target.id !== 'deltaSel') return; const v = e.target.value; const proj = project || delta?.repo;
    location.href = '/architecture?' + (v ? qs({ project: proj, plan: v.split('|')[0], session: v.split('|')[1] }) : qs({ project: proj })); });
  const select = (id) => { selected = id || null; history.replaceState(null, '', location.pathname + location.search + (selected ? '#m=' + encodeURIComponent(selected) : '')); drawMap(); drawRail(); if (selected && window.innerWidth <= 1100) $('rail').scrollIntoView({ block: 'start', behavior: 'smooth' }); };

  // ---------------------------------------------------------------- events
  // the panel is a layer (public/ux.js): Escape or « Fermer » closes it and gives the focus back to the module
  const UX = window.escadrilleUX;
  const modEl = (id) => (id ? document.querySelector(`.mod[data-id="${CSS.escape(id)}"]`) : null);
  const choose = (id) => {
    select(id);
    if (UX) { UX.close($('rail'), { focus: false }); if (id) UX.open($('rail'), { trigger: null, restore: () => modEl(id), close: () => select(null) }); }
  };
  const toggle = (id) => { const prev = selected; const next = id === selected ? null : id; choose(next); modEl(next || id || prev)?.focus({ preventScroll: true }); };
  document.addEventListener('click', (e) => {
    const g = e.target.closest('.mod'); if (g) return toggle(g.dataset.id);
    const go = e.target.closest('[data-go]'); if (go) { const was = selected; choose(go.dataset.go || null); modEl(go.dataset.go || was)?.focus({ preventScroll: true }); return; }
  });
  document.addEventListener('keydown', (e) => {
    const g = e.target.closest && e.target.closest('.mod');
    if (g && (e.key === 'Enter' || e.key === ' ')) { e.preventDefault(); toggle(g.dataset.id); return; }
    // the arrows go to the nearest module that way, both ways (docs/phase11/ux.md §4.7)
    if (g && UX && /^Arrow/.test(e.key)) {
      const mods = [...document.querySelectorAll('.mod')]; const rects = mods.map((m) => { const r = m.getBoundingClientRect(); return { x: r.left, y: r.top, w: r.width, h: r.height }; });
      const j = UX.nearest(rects, mods.indexOf(g), e.key); e.preventDefault(); if (j >= 0) mods[j].focus();
      return;
    }
    if (e.key === 'Escape' && selected && !e.target.closest('details')) { const was = selected; choose(null); modEl(was)?.focus({ preventScroll: true }); }
  });
  if (UX) UX.keys([[['Tab'], T('arch.keyTab')], [['←', '→', '↑', '↓'], T('arch.keyArrows')], [[T('arch.keySpace')], T('arch.keySelect')]]);
  document.addEventListener('toggle', (e) => { if (e.target.id === 'moreEdges') { allEdges = e.target.open; drawMap(); } }, true);
  document.addEventListener('submit', (e) => {
    if (e.target.id !== 'cmp') return; e.preventDefault();
    const f = new FormData(e.target); const b = String(f.get('base') || '').trim(); const h = String(f.get('head') || '').trim(); if (!h) return;
    location.href = '/architecture?' + qs({ project: project || delta?.repo, base: b || 'main', head: h });
  });
  let rt = null; addEventListener('resize', () => { clearTimeout(rt); rt = setTimeout(() => map && drawMap(), 120); });

  // ---------------------------------------------------------------- start
  (async () => {
    let projects = [];
    try { projects = (await api('/api/projects')).projects || []; } catch {}
    if (!project && !planId) project = projects[0]?.path || null;
    // the shell is the one sidebar (sidebar.js): the project picker and every link come from it
    if (window.escadrilleSidebar) window.escadrilleSidebar.render($('sidebar'), { project: project || null });
    if (!project && !planId) { $('sub').textContent = T('arch.pickProject'); return; }
    try { await load(); } catch (err) { $('sub').textContent = err.message; return; }
    if (!project && delta) project = delta.repo;
    draw();
    if (window.escadrilleI18n) window.escadrilleI18n.onChange(async () => { try { await load(); } catch {} draw(); drawDeltaPick(); }); // the delta's summary comes from the server
  })();
})();
