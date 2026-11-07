// What runs, seen at once (Dev, 2026-11-06: 17 live sessions found by chance). One counter in the top bar of every app
// page, « 3 tournent · 4,12 $ engagés », that opens the live sessions grouped by project then plan, a link to each.
// No new route: who runs is GET /api/running (ours, kind 'session'), what each does and costs is GET /api/projectflow of
// each project that has one (node.now, node.cost). Loaded by sidebar.js; refreshed by its refresh (the event stream's
// `change` and the 30 s timer), so the counter moves with the rest of the bar.
//   EscadrilleLive.group(running, flows) → { n, cost, projects: [{ project, name, n, cost, plans: [{ plan, title, n, cost, sessions }] }] } (pure)
//   EscadrilleLive.markup(model)         → the button and its list (pure)
//   EscadrilleLive.refresh()             → reads the two routes, draws in every .topbar
(function (root) {
  const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  const T = (k, v) => (root.T ? root.T(k, v) : k);
  const usd = (x) => (root.T && root.T.usd ? root.T.usd(x) : `${(Number(x) || 0).toFixed(2)} $`);
  const base = (p) => String(p || '').split('/').filter(Boolean).pop() || String(p || '');
  const r2 = (x) => Math.round(x * 100) / 100;
  const href = (project, plan, session) => `/plan/${encodeURIComponent(plan)}?${project ? `project=${encodeURIComponent(project)}&` : ''}node=${encodeURIComponent(session)}&tab=${encodeURIComponent(session)}#flow`;

  // running: the /api/running answer; flows: { [project]: the /api/projectflow answer }. A session counts once, even when
  // its row is missing from the flow (then its cost is 0 and its line empty): what runs is never hidden.
  const group = (running, flows = {}) => {
    const ours = running && Array.isArray(running.ours) ? running.ours.filter((r) => r.kind === 'session' && r.plan && r.session) : [];
    const seen = new Set(); const byP = new Map();
    for (const r of ours) {
      const key = `${r.project || ''}\u0000${r.plan}\u0000${r.session}`; if (seen.has(key)) continue; seen.add(key);
      const f = flows[r.project || ''] || null;
      const node = f && Array.isArray(f.nodes) ? f.nodes.find((n) => n.plan === r.plan && n.session === r.session) : null;
      const plan = f && Array.isArray(f.plans) ? f.plans.find((p) => p.id === r.plan) : null;
      if (!byP.has(r.project || '')) byP.set(r.project || '', { project: r.project || '', name: (f && f.name) || base(r.project) || T('live.noProject'), n: 0, cost: 0, plans: new Map() });
      const P = byP.get(r.project || '');
      if (!P.plans.has(r.plan)) P.plans.set(r.plan, { plan: r.plan, title: (plan && plan.title) || r.plan, n: 0, cost: 0, sessions: [] });
      const L = P.plans.get(r.plan); const cost = node ? Number(node.cost) || 0 : 0;
      L.sessions.push({ session: r.session, name: (node && node.name) || r.session, now: node && node.now ? (root.T && root.T.decode ? root.T.decode(node.now) : node.now) : '', cost, since: r.since || null, href: href(r.project, r.plan, r.session) });
      L.n++; L.cost += cost; P.n++; P.cost += cost;
    }
    const projects = [...byP.values()].map((P) => ({ ...P, cost: r2(P.cost), plans: [...P.plans.values()].map((L) => ({ ...L, cost: r2(L.cost) })).sort((a, b) => b.cost - a.cost) })).sort((a, b) => b.cost - a.cost);
    return { n: projects.reduce((a, p) => a + p.n, 0), cost: r2(projects.reduce((a, p) => a + p.cost, 0)), projects, apps: apps(running), vitals: (running && running.vitals) || null };
  };

  // The front apps that run, one line each with its link (backlog, Dev 2 November): a session's `npm run dev`, the project's
  // environment (`ENV: up`, every environment.health URL), and the dev servers listening on the Mac (Docker started by
  // hand, a capture instance), the server names the project whose health has their port. One line per URL.
  const apps = (running) => {
    const out = []; const seen = new Set();
    // role 'env': the Environnement (the project's own server, on the branch it follows); anything else is a test app (lib/testapps.mjs)
    const add = (url, name, what, role) => { const u = String(url || '').replace(/\/$/, ''); if (!/^https?:\/\//.test(u) || seen.has(u)) return; seen.add(u); out.push({ url: u, host: u.replace(/^https?:\/\//, ''), name, what, role }); };
    const ours = (running && running.ours) || [];
    for (const r of ours) if (r.kind === 'devenv') for (const u of (r.urls && r.urls.length ? r.urls : [r.url])) add(u, base(r.project || r.cwd), T('live.appEnv'), 'env');
    for (const s of (running && running.servers) || []) if (s.role === 'env') add(s.url || `http://localhost:${s.port}`, base(s.project), s.branch ? T('live.appBranch', { b: s.branch }) : T('live.appEnv'), 'env');
    for (const r of ours) if (r.kind === 'devserver') add(r.url, base(r.project) || r.plan, T('live.appDev', { s: r.session }), 'test');
    for (const s of (running && running.servers) || []) if (s.role !== 'env') add(s.url || `http://localhost:${s.port}`, s.session ? s.session : s.project ? base(s.project) : base(s.cwd) || s.command, s.role === 'test' ? T('live.appTest') : String(s.command || '').replace(/^com\.docke$/, 'Docker'), 'test');
    return out;
  };
  // The Environnement shown, the test apps folded in one line; both from the same array as the count (6 November: « 72 apps »
  // read after 53 had stopped)
  let testsOpen = false;
  const appsHtml = (A) => {
    if (!A.length) return '';
    const env = A.filter((a) => a.role === 'env'); const tests = A.filter((a) => a.role !== 'env');
    const row = (a) => `<a class="lc-s lc-app" href="${esc(a.url)}" target="_blank" rel="noopener"><span class="t">${esc(a.name)}</span><span class="num">${esc(a.host)}</span><span class="act">${esc(a.what)}</span></a>`;
    return `<div class="lc-proj"><span>${esc(T('live.envHead'))}</span><span class="num">${env.length}</span></div>`
      + (env.length ? env.map(row).join('') : `<p class="lc-none">${esc(T('live.envNone'))}</p>`)
      + (tests.length ? `<details class="lc-tests"${testsOpen ? ' open' : ''}><summary><span>${esc(T('live.testsHead', { n: tests.length }))}</span><span class="num">${tests.length}</span></summary>${tests.map(row).join('')}</details>` : '');
  };

  // One folded line: the Mac's memory and processor, the server's memory, the claude processes; the detail on click.
  const GB = (b) => (b / 1073741824).toFixed(1).replace('.', T('live.dec') === 'live.dec' ? '.' : T('live.dec'));
  const MB = (b) => Math.round(b / 1048576);
  const vitalsLine = (v) => {
    if (!v || !v.mem) return '';
    const hot = (p) => (p >= 85 ? ' hot' : '');
    const sum = `<span class="${hot(v.mem.pct)}">${esc(T('live.vMem', { pct: v.mem.pct }))}</span> · <span class="${hot(v.cpu && v.cpu.pct)}">${esc(T('live.vCpu', { pct: v.cpu && v.cpu.pct != null ? v.cpu.pct : '–' }))}</span> · ${esc(T('live.vServer', { mb: MB(v.server.rss) }))}${v.claude != null ? ` · ${esc(T('live.vClaude', { n: v.claude }))}` : ''}`;
    const rows = [[T('live.dMem'), T('live.dMemV', { used: GB(v.mem.used), total: GB(v.mem.total) })],
      [T('live.dLoad'), T('live.dLoadV', { load: (v.cpu.load || []).join(' · '), cores: v.cpu.cores })],
      [T('live.dServer'), T('live.vServer', { mb: MB(v.server.rss) })]].concat(v.claude != null ? [[T('live.dClaude'), String(v.claude)]] : []);
    return `<details class="lc-vit"><summary>${sum}</summary><dl>${rows.map(([k, x]) => `<dt>${esc(k)}</dt><dd class="num">${esc(x)}</dd>`).join('')}</dl></details>`;
  };

  const markup = (m, open = false) => {
    const A = (m && m.apps) || [];
    if (!m || (!m.n && !A.length && !m.vitals)) return `<button type="button" class="live-count idle" data-live-toggle aria-expanded="false" disabled>${esc(T('live.idle'))}</button>`;
    const label = m.n ? T('live.count', { n: m.n, usd: usd(m.cost) }) + (A.length ? ' · ' + T('live.apps', { n: A.length }) : '') : A.length ? T('live.apps', { n: A.length }) : T('live.idle');
    const appRows = appsHtml(A);
    const head = vitalsLine(m.vitals);
    if (!m.n) return `<button type="button" class="live-count${A.length ? '' : ' quiet'}" data-live-toggle aria-expanded="${open}" aria-haspopup="true" aria-label="${esc(label)}">${A.length ? `<span><b class="num">${A.length}</b><span class="lc-word">&nbsp;${esc(T('live.appsWord', { n: A.length }))}</span></span>` : esc(T('live.idle'))}</button>`
      + `<div class="live-list" role="dialog" aria-label="${esc(label)}"${open ? '' : ' hidden'}>${head}${appRows}<div class="lc-foot"><button type="button" class="card-link" data-live-mac>${esc(T('live.allMac'))}</button></div></div>`;
    const rows = m.projects.map((P) => `<div class="lc-proj"><span>${esc(P.name)}</span><span class="num">${P.n}</span></div>`
      + P.plans.map((L) => `<div class="lc-plan"><span class="t">${esc(L.title)}</span><span class="num">${esc(usd(L.cost))}</span></div>`
        + L.sessions.map((s) => `<a class="lc-s" href="${esc(s.href)}"><span class="id">${esc(s.session)}</span><span class="t">${esc(s.name)}</span><span class="num">${esc(usd(s.cost))}</span><span class="act">${esc(s.now || T('live.noLine'))}</span></a>`).join('')).join('')).join('');
    return `<button type="button" class="live-count" data-live-toggle aria-expanded="${open}" aria-haspopup="true" aria-label="${esc(label)}"><span class="live-pulse" aria-hidden="true"></span><span><b class="num">${m.n}</b><span class="lc-word">&nbsp;${esc(T('live.running', { n: m.n }))}</span> · <span class="num">${esc(usd(m.cost))}</span><span class="lc-word">&nbsp;${esc(T('live.engaged'))}</span>${A.length ? ` · <span class="num">${A.length}</span><span class="lc-word">&nbsp;${esc(T('live.appsWord', { n: A.length }))}</span>` : ''}</span></button>`
      + `<div class="live-list" role="dialog" aria-label="${esc(label)}"${open ? '' : ' hidden'}>${head}${rows}${appRows}<div class="lc-foot"><button type="button" class="card-link" data-live-mac>${esc(T('live.allMac'))}</button></div></div>`;
  };

  // ?live=open opens the list at once (a capture, a link from a notification)
  const S = { model: null, open: (() => { try { return /[?&]live=open(&|$)/.test(root.location.search || ''); } catch { return false; } })(), busy: false };
  const get = async (u) => { try { const r = await fetch(u); return r.ok ? await r.json() : null; } catch { return null; } };
  const draw = () => {
    if (!root.document) return;
    for (const bar of root.document.querySelectorAll('.topbar')) {
      let box = bar.querySelector('.live-box');
      if (!box) { box = root.document.createElement('div'); box.className = 'live-box'; const sp = bar.querySelector('.spacer'); if (sp) sp.after(box); else { const c = bar.querySelector('.crumb'); if (c) c.after(box); else bar.append(box); } }
      box.innerHTML = markup(S.model, S.open);
    }
  };
  const refresh = async () => {
    if (S.busy) return; S.busy = true;
    try {
      const running = await get('/api/running');
      const projects = [...new Set(((running && running.ours) || []).filter((r) => r.kind === 'session').map((r) => r.project || ''))];
      const flows = Object.fromEntries(await Promise.all(projects.map(async (p) => [p, p ? await get('/api/projectflow?project=' + encodeURIComponent(p)) : null])));
      S.model = group(running, flows); S.flows = flows; if (!S.model.n && !S.model.apps.length && !S.model.vitals) S.open = false; draw();
    } finally { S.busy = false; }
  };
  // The bar's « Ce Mac » (public/mac.js) hands its fresh /api/running answer here: the count moves with the list it shows
  const use = (running) => { if (!running) return; S.model = group(running, S.flows || {}); draw(); };
  if (root.document && root.document.addEventListener) {
    root.document.addEventListener('click', (e) => {
      const t = e.target.closest && e.target.closest('[data-live-toggle]');
      if (t) { S.open = !S.open; draw(); return; }
      // « Ce Mac, tout arrêter… »: the block of the bar that already stops one or all (mac.js), opened
      if (e.target.closest && e.target.closest('[data-live-mac]')) { S.open = false; draw(); const d = root.document; const sb = root.escadrilleSidebar;
        if (sb && sb.open) sb.open(true); const bl = d.getElementById('bottomLine'); if (bl) bl.open = true; const mac = d.getElementById('mac'); if (mac) { mac.open = true; if (mac.scrollIntoView) mac.scrollIntoView({ block: 'nearest' }); } return; }
      if (S.open && !(e.target.closest && e.target.closest('.live-list'))) { S.open = false; draw(); }
    });
    root.document.addEventListener('keydown', (e) => { if (e.key === 'Escape' && S.open) { S.open = false; draw(); const b = root.document.querySelector('[data-live-toggle]'); if (b) b.focus(); } });
  }
  if (root.document && root.document.addEventListener) root.document.addEventListener('toggle', (e) => { if (e.target && e.target.classList && e.target.classList.contains('lc-tests')) testsOpen = e.target.open; }, true);
  root.EscadrilleLive = { group, markup, refresh, draw, use };
})(typeof window !== 'undefined' ? window : globalThis);
