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
  const group = (running, flows = {}, opts = {}) => {
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
    return { n: projects.reduce((a, p) => a + p.n, 0), cost: r2(projects.reduce((a, p) => a + p.cost, 0)), projects, apps: apps(running), vitals: (running && running.vitals) || null, canStop: !!opts.canStop };
  };

  // The front apps that run, one line each with its link (backlog, Dev 2 November): a session's `npm run dev`, the project's
  // environment (`ENV: up`, every environment.health URL), and the dev servers listening on the Mac (Docker started by
  // hand, a capture instance), the server names the project whose health has their port. One line per URL.
  const apps = (running) => {
    const out = []; const seen = new Set();
    // role 'env': the Environnement (the project's own server, on the branch it follows); anything else is a test app (lib/testapps.mjs)
    const add = (url, name, what, role, own = false) => { const u = String(url || '').replace(/\/$/, ''); if (!/^https?:\/\//.test(u) || seen.has(u)) return; seen.add(u); out.push({ url: u, host: u.replace(/^https?:\/\//, ''), name, what, role, own }); };
    const ours = (running && running.ours) || [];
    // an orphan (docs/sessions.md 2026-11-07: in a project, owned by no live session nor ENV: up) leaves the Environnement
    // and the tests: it reads apart, named by its own folder, with what « Arrêter » and its detail need
    const all = (running && running.servers) || []; const servers = all.filter((s) => !s.orphan);
    for (const s of all) if (s.orphan) {
      const u = String(s.url || `http://localhost:${s.port}`).replace(/\/$/, ''); if (seen.has(u)) continue; seen.add(u);
      out.push({ url: u, host: u.replace(/^https?:\/\//, ''), name: base(s.cwd) || base(s.project) || String(s.command || '').split(/\s+/)[0], what: '', role: 'orphan', pid: s.pid, port: s.port, command: String(s.command || ''), cwd: String(s.cwd || ''), since: s.since || null });
    }
    for (const r of ours) if (r.kind === 'devenv') for (const u of (r.urls && r.urls.length ? r.urls : [r.url])) add(u, base(r.project || r.cwd), T('live.appEnv'), 'env', true);
    for (const s of servers) if (s.role === 'env') add(s.url || `http://localhost:${s.port}`, base(s.project), s.branch ? T('live.appBranch', { b: s.branch }) : T('live.appEnv'), 'env');
    for (const r of ours) if (r.kind === 'devserver') add(r.url, base(r.project) || r.plan, T('live.appDev', { s: r.session }), 'test');
    // role 'other' is the Mac's own services (Docker, php-fpm…): not calmdev's, never counted as a test app, never stoppable
    for (const s of servers) if (s.role !== 'env') { const mac = s.role !== 'test'; add(s.url || `http://localhost:${s.port}`, s.session ? s.session : s.project ? base(s.project) : base(s.cwd) || macName(s.command), mac ? macName(s.command) : T('live.appTest'), mac ? 'mac' : 'test'); }
    return out;
  };
  // « com.docke » (lsof's cut name) → Docker; « php-fpm: master process » → php-fpm; a path → its file name
  const macName = (c) => { const w = String(c || '').trim().split(/\s+/)[0] || ''; const n = w.replace(/:$/, '').split('/').filter(Boolean).pop() || w; return /^com\.docke|^docker/i.test(n) ? 'Docker' : n; };
  // What calmdev started and the top line counts: test apps, orphans, the environment `ENV: up` started. Never the Mac's services,
  // never the developer's own server found in a project folder.
  const counted = (A) => A.filter((a) => a.role === 'test' || a.role === 'orphan' || (a.role === 'env' && a.own)).length;
  // The Environnement shown, the test apps folded in one line; both from the same array as the count (6 November: « 72 apps »
  // read after 53 had stopped)
  let testsOpen = false; let macsOpen = false;
  // The orphans' own state, kept across redraws (the list is redrawn on every refresh): the detail opened, the « Arrêter »
  // armed (a second click confirms; Échap or 3 s disarm), the stop in flight, the refusal of the server under its line
  const O = { open: new Set(), armed: null, timer: null, busy: new Set(), err: new Map() };
  const okey = (a) => `${a.pid}:${a.port}`;
  const ago = (iso, now = Date.now()) => { const t = Date.parse(iso); if (!Number.isFinite(t)) return ''; const m = Math.max(0, Math.round((now - t) / 60000));
    return m < 1 ? T('time.now') : m < 60 ? T('time.forMin', { n: m }) : m < 48 * 60 ? T('time.forH', { n: Math.floor(m / 60) }) : T('time.forD', { n: Math.floor(m / 1440) }); };
  const dateOf = (iso) => { const t = new Date(iso); if (!Number.isFinite(t.getTime())) return ''; let lang = 'fr'; try { lang = root.document.documentElement.lang || 'fr'; } catch {} try { return t.toLocaleString(lang, { day: 'numeric', month: 'short', year: 'numeric', hour: '2-digit', minute: '2-digit' }); } catch { return t.toISOString().slice(0, 16).replace('T', ' '); } };
  const home = (p) => String(p || '').replace(/^\/(Users|home)\/[^/]+(?=\/|$)/, '~');
  const shortCmd = (c) => { const parts = String(c || '').trim().split(/\s+/).filter(Boolean); return parts.slice(0, 3).map((p) => (p.includes('/') ? p.split('/').filter(Boolean).pop() : p)).join(' '); };
  const orphanRow = (a, canStop) => {
    const k = okey(a); const id = 'lco-' + String(k).replace(/[^\w-]/g, '-'); const when = ago(a.since); const armed = O.armed === k; const busy = O.busy.has(k);
    // the two labels share one cell: arming changes the word, never the width
    const stop = canStop ? `<button type="button" class="lc-ostop${armed ? ' armed' : ''}" data-orph-stop="${esc(k)}" data-fk="stop-${esc(k)}" aria-label="${esc(T('live.orphStopFor', { name: a.name, port: a.port }))}${armed ? ' · ' + esc(T('live.orphConfirm')) : ''}"${busy ? ' disabled' : ''}><span${armed || busy ? ' class="off"' : ''}>${esc(T('live.orphStop'))}</span><span class="${armed || busy ? '' : 'off'}">${esc(busy ? T('live.orphStopping') : T('live.orphConfirm'))}</span></button>` : '';
    const sum = [shortCmd(a.command), when ? T('live.orphSince', { d: when }) : ''].filter(Boolean).join(' · ');
    const err = O.err.get(k);
    return `<div class="lc-orph" data-orph="${esc(k)}"><div class="lc-oline"><span class="t">${esc(a.name)}</span><span class="lc-otag">${esc(T('live.orphTag'))}</span><span class="num">:${esc(a.port)}</span>${stop}</div>`
      + `<details class="lc-od" data-orph-detail="${esc(k)}"${O.open.has(k) ? ' open' : ''}><summary data-fk="sum-${esc(k)}" aria-label="${esc(T('live.orphDetail', { name: a.name }))}">${esc(sum || a.host)}</summary>`
      + `<dl><dt>${esc(T('live.orphCmd'))}</dt><dd class="cmd">${esc(a.command)}</dd>`
      + (when ? `<dt>${esc(T('live.orphFrom'))}</dt><dd><span class="lc-when" tabindex="0" data-fk="when-${esc(k)}" aria-describedby="${id}-d">${esc(when)}<span class="lc-tip" role="tooltip" id="${id}-d">${esc(dateOf(a.since))}</span></span></dd>` : '')
      + `<dt>${esc(T('live.orphDir'))}</dt><dd class="dir">${esc(home(a.cwd)).replace(/\//g, '/<wbr>')}</dd></dl></details>`
      + (err ? `<p class="lc-oerr" role="status">${esc(err)}</p>` : '') + '</div>';
  };
  const appsHtml = (A, canStop = false) => {
    if (!A.length) return '';
    const env = A.filter((a) => a.role === 'env'); const orph = A.filter((a) => a.role === 'orphan'); const tests = A.filter((a) => a.role === 'test'); const macs = A.filter((a) => a.role === 'mac');
    const macNames = [...new Set(macs.map((a) => a.what).filter(Boolean))]; const macHead = T('live.macHead', { n: macs.length, names: macNames.slice(0, 3).join(', ') + (macNames.length > 3 ? '…' : '') });
    const row = (a) => `<a class="lc-s lc-app" href="${esc(a.url)}" target="_blank" rel="noopener"><span class="t">${esc(a.name)}</span><span class="num">${esc(a.host)}</span><span class="act">${esc(a.what)}</span></a>`;
    return `<div class="lc-proj"><span>${esc(T('live.envHead'))}</span><span class="num">${env.length}</span></div>`
      + (env.length ? env.map(row).join('') : `<p class="lc-none">${esc(T('live.envNone'))}</p>`)
      + (orph.length ? `<div class="lc-proj lc-ohead"><span>${esc(T('live.orphHead'))}</span><span class="num">${orph.length}</span></div>${orph.map((a) => orphanRow(a, canStop)).join('')}` : '')
      + (tests.length ? `<details class="lc-tests"${testsOpen ? ' open' : ''}><summary><span>${esc(T('live.testsHead', { n: tests.length }))}</span><span class="num">${tests.length}</span></summary>${tests.map(row).join('')}</details>` : '')
      + (macs.length ? `<details class="lc-tests lc-macs"${macsOpen ? ' open' : ''}><summary><span>${esc(macHead)}</span><span class="num">${macs.length}</span></summary>${macs.map(row).join('')}</details>` : '');
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
    const A = (m && m.apps) || []; const nA = counted(A); // the top line counts what calmdev started; the Mac's services only fill the folded line
    if (!m || (!m.n && !A.length && !m.vitals)) return `<button type="button" class="live-count idle" data-live-toggle aria-expanded="false" disabled>${esc(T('live.idle'))}</button>`;
    const label = m.n ? T('live.count', { n: m.n, usd: usd(m.cost) }) + (nA ? ' · ' + T('live.apps', { n: nA }) : '') : nA ? T('live.apps', { n: nA }) : T('live.idle');
    const appRows = appsHtml(A, !!m.canStop);
    const head = vitalsLine(m.vitals);
    if (!m.n) return `<button type="button" class="live-count${nA ? '' : ' quiet'}" data-live-toggle aria-expanded="${open}" aria-haspopup="true" aria-label="${esc(label)}">${nA ? `<span><b class="num">${nA}</b><span class="lc-word">&nbsp;${esc(T('live.appsWord', { n: nA }))}</span></span>` : esc(T('live.idle'))}</button>`
      + `<div class="live-list" role="dialog" aria-label="${esc(label)}"${open ? '' : ' hidden'}>${head}${appRows}<div class="lc-foot"><button type="button" class="card-link" data-live-mac>${esc(T('live.allMac'))}</button></div></div>`;
    const rows = m.projects.map((P) => `<div class="lc-proj"><span>${esc(P.name)}</span><span class="num">${P.n}</span></div>`
      + P.plans.map((L) => `<div class="lc-plan"><span class="t">${esc(L.title)}</span><span class="num">${esc(usd(L.cost))}</span></div>`
        + L.sessions.map((s) => `<a class="lc-s" href="${esc(s.href)}"><span class="id">${esc(s.session)}</span><span class="t">${esc(s.name)}</span><span class="num">${esc(usd(s.cost))}</span><span class="act">${esc(s.now || T('live.noLine'))}</span></a>`).join('')).join('')).join('');
    return `<button type="button" class="live-count" data-live-toggle aria-expanded="${open}" aria-haspopup="true" aria-label="${esc(label)}"><span class="live-pulse" aria-hidden="true"></span><span><b class="num">${m.n}</b><span class="lc-word">&nbsp;${esc(T('live.running', { n: m.n }))}</span> · <span class="num">${esc(usd(m.cost))}</span><span class="lc-word">&nbsp;${esc(T('live.engaged'))}</span>${nA ? ` · <span class="num">${nA}</span><span class="lc-word">&nbsp;${esc(T('live.appsWord', { n: nA }))}</span>` : ''}</span></button>`
      + `<div class="live-list" role="dialog" aria-label="${esc(label)}"${open ? '' : ' hidden'}>${head}${rows}${appRows}<div class="lc-foot"><button type="button" class="card-link" data-live-mac>${esc(T('live.allMac'))}</button></div></div>`;
  };

  // ?live=open opens the list at once (a capture, a link from a notification)
  const S = { model: null, open: (() => { try { return /[?&]live=open(&|$)/.test(root.location.search || ''); } catch { return false; } })(), busy: false, canStop: false, who: false };
  const get = async (u) => { try { const r = await fetch(u); return r.ok ? await r.json() : null; } catch { return null; } };
  const draw = () => {
    if (!root.document) return;
    // the list is redrawn whole: the focus goes back to the same control (data-fk), so Tab and a refresh never fight
    const ae = root.document.activeElement; const fk = ae && ae.closest && ae.closest('.live-box') && ae.getAttribute('data-fk');
    for (const bar of root.document.querySelectorAll('.topbar')) {
      let box = bar.querySelector('.live-box');
      if (!box) { box = root.document.createElement('div'); box.className = 'live-box'; const sp = bar.querySelector('.spacer'); if (sp) sp.after(box); else { const c = bar.querySelector('.crumb'); if (c) c.after(box); else bar.append(box); } }
      box.innerHTML = markup(S.model, S.open);
    }
    if (fk) { const el = root.document.querySelector(`.live-box [data-fk="${fk.replace(/"/g, '')}"]`); if (el && el.focus) el.focus(); }
  };
  // « Arrêter » an orphan only where the developer's own browser is: on the Mac (GET /api/whoami, as public/remote.js), never
  // on a poste nor a phone; the server still asks for the guard cookie and its 403 is shown under the line
  const whoami = async () => { if (S.who) return; S.who = true; const w = await get('/api/whoami'); S.canStop = !!(w && w.mac && !w.poste); };
  const refresh = async () => {
    if (S.busy) return; S.busy = true;
    try {
      await whoami();
      const running = await get('/api/running');
      const projects = [...new Set(((running && running.ours) || []).filter((r) => r.kind === 'session').map((r) => r.project || ''))];
      const flows = Object.fromEntries(await Promise.all(projects.map(async (p) => [p, p ? await get('/api/projectflow?project=' + encodeURIComponent(p)) : null])));
      S.model = group(running, flows, { canStop: S.canStop }); S.flows = flows; if (!S.model.n && !S.model.apps.length && !S.model.vitals) S.open = false;
      const alive = new Set(S.model.apps.filter((a) => a.role === 'orphan').map(okey)); for (const k of [...O.open]) if (!alive.has(k)) O.open.delete(k); for (const k of [...O.err.keys()]) if (!alive.has(k)) O.err.delete(k);
      draw();
    } finally { S.busy = false; }
  };
  // The bar's « Ce Mac » (public/mac.js) hands its fresh /api/running answer here: the count moves with the list it shows
  const use = (running) => { if (!running) return; S.model = group(running, S.flows || {}, { canStop: S.canStop }); draw(); };
  const disarm = () => { clearTimeout(O.timer); O.timer = null; if (O.armed == null) return false; O.armed = null; draw(); return true; };
  // a refusal in one line: 403 says the way that works (the server's own sentence), 409 why it is not an orphan any more
  const why = (status, error) => {
    const e = String(error || '');
    if (status === 409) { const own = /^owned by (.+)$/.exec(e);
      return /not listening/.test(e) ? T('live.orphGone') : own ? (own[1] === 'ENV: up' ? T('live.orphEnv') : T('live.orphOwned', { by: own[1] })) : T('live.orphNot', { why: e }); }
    return e || T('live.orphFail');
  };
  const stopOrphan = async (k) => {
    const a = S.model && S.model.apps.find((x) => x.role === 'orphan' && okey(x) === k); if (!a) return;
    O.busy.add(k); O.err.delete(k); draw();
    let status = 0; let body = null;
    try { const r = await fetch('/api/running/stop-orphan', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ pid: a.pid, port: a.port }) }); status = r.status; body = await r.json().catch(() => null); }
    catch (e) { body = { error: e.message }; }
    O.busy.delete(k);
    if (status === 200 && body && body.ok) { O.open.delete(k); await refresh(); return; } // the line goes with the next answer
    O.err.set(k, why(status, body && body.error)); draw();
  };
  if (root.document && root.document.addEventListener) {
    root.document.addEventListener('click', (e) => {
      const t = e.target.closest && e.target.closest('[data-live-toggle]');
      if (t) { S.open = !S.open; disarm(); draw(); return; }
      const st = e.target.closest && e.target.closest('[data-orph-stop]');
      if (st) { const k = st.getAttribute('data-orph-stop'); if (O.busy.has(k)) return;
        if (O.armed !== k) { clearTimeout(O.timer); O.armed = k; O.err.delete(k); draw(); O.timer = setTimeout(disarm, 3000); return; }
        clearTimeout(O.timer); O.timer = null; O.armed = null; stopOrphan(k); return; }
      if (O.armed != null && e.target.closest && e.target.closest('.live-list')) disarm();
      // « Ce Mac, tout arrêter… »: the block of the bar that already stops one or all (mac.js), opened
      if (e.target.closest && e.target.closest('[data-live-mac]')) { S.open = false; draw(); const d = root.document; const sb = root.escadrilleSidebar;
        if (sb && sb.open) sb.open(true); const bl = d.getElementById('bottomLine'); if (bl) bl.open = true; const mac = d.getElementById('mac'); if (mac) { mac.open = true; if (mac.scrollIntoView) mac.scrollIntoView({ block: 'nearest' }); } return; }
      if (S.open && !(e.target.closest && e.target.closest('.live-list'))) { S.open = false; draw(); }
    });
    root.document.addEventListener('keydown', (e) => {
      if (e.key !== 'Escape' || !S.open) return;
      // Échap, innermost first: an armed « Arrêter » disarms, then an opened detail closes (focus back on its line), then the list
      if (O.armed != null) { const k = O.armed; disarm(); const b = root.document.querySelector(`.live-box [data-fk="stop-${k}"]`); if (b) b.focus(); return; }
      const od = e.target && e.target.closest && e.target.closest('.lc-od[open]');
      if (od) { const k = od.getAttribute('data-orph-detail'); O.open.delete(k); od.open = false; const s = od.querySelector('summary'); if (s) s.focus(); return; }
      S.open = false; draw(); const b = root.document.querySelector('[data-live-toggle]'); if (b) b.focus();
    });
  }
  if (root.document && root.document.addEventListener) root.document.addEventListener('toggle', (e) => {
    const el = e.target; if (!el || !el.classList) return;
    if (el.classList.contains('lc-macs')) macsOpen = el.open; else if (el.classList.contains('lc-tests')) testsOpen = el.open;
    if (el.classList.contains('lc-od')) { const k = el.getAttribute('data-orph-detail'); if (el.open) O.open.add(k); else O.open.delete(k); }
  }, true);
  root.EscadrilleLive = { group, markup, refresh, draw, use, why };
})(typeof window !== 'undefined' ? window : globalThis);
