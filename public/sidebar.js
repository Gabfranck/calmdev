// The one navigation of Escadrille (docs/phase9/direction.md §2), the same on every page. A page holds only
// `<nav class="sidebar" id="sidebar"></nav>` and a top bar with `.menu-toggle`, `#crumbProj` and `#crumb`, then calls
//   escadrilleSidebar.render(el, { project?, current?, plan? })
// once the script is loaded (the skeleton is drawn at once, so mac.js and phone.js find #mac and #phone), and again
// whenever the project changes. Without `project` the bar finds it as the home does: ?project=, else localStorage,
// else the last escadrille. Without `current` the bar reads the URL (escadrilleSidebar.current).
// No project picker any more (session NAV, Dev 2026-11-02): the entry « Escadrille » first (the one entry conversation
// of every project, session ENT), then every project of GET /api/projects stacked, the current one first and unfolded
// with its menu, the others one line each (logo, name, a dot when something waits for the developer); « Ajouter un
// projet… » one line at the end. ↑ ↓ move through the bar, → ← unfold and fold, Enter opens.
// Counts: Conversation = plans to accept or questions in the thread (GET /api/main), Flot = sessions waiting for the
// developer (GET /api/projectflow), Revue = open reviews (GET /api/reviews); dots on Rafale and Pilote; the folded
// projects' dot reads the same two routes for each of them, on the 30 s timer only (docs/perf.md); the bottom
// line (this Mac, the phone, the quota, the rank) reads /api/running, /api/devices, /api/project/horizon, /api/game.
// Refreshed by /api/events (change) and every 30 s. Keys 1 to 4 open the four screens; Escape closes the add form, then the drawer.
(function (root) {
  const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  const folderOf = (p) => String(p || '').split('/').filter(Boolean).pop() || '';
  const name = (p) => (p && root.escadrilleProjects && root.escadrilleProjects.name ? root.escadrilleProjects.name(p) : folderOf(p)); // free names (docs/multiproject.md), the folder otherwise
  const withProject = (href, project) => { if (!project) return href; const [p, h] = String(href).split('#'); return `${p}${p.includes('?') ? '&' : '?'}project=${encodeURIComponent(project)}${h !== undefined ? '#' + h : ''}`; };
  const T = (k, v) => (root.T ? root.T(k, v) : k); // public/i18n/i18n.js, loaded first
  // the rank by its level (lib/game.mjs RANKS), in the page's language; the server's name when the key is missing
  const rankName = (g) => (root.T && root.T.has && g.level && root.T.has('game.rank.' + g.level) ? T('game.rank.' + g.level) : g.rank);

  // The entry conversation of every project (session ENT); its address is the one written in docs/entry.md
  const ENTRY = '/#/entree';
  // The Conversation is the home (session B): `/`; the old anchor `/#conversation` still lands there.
  const CONVERSATION = '/';
  const STEPS = [
    { id: 'conversation', label: 'nav.conversation', href: CONVERSATION, key: '1' },
    { id: 'resources', label: 'nav.resources', href: '/resources', key: '2' },
    { id: 'flow', label: 'nav.flow', href: '/flow', key: '3' },
    { id: 'review', label: 'nav.review', href: '/review', key: '4' },
  ];
  const PROJECT = [
    { id: 'backlog', label: 'nav.backlog', href: '/backlog' }, // docs/backlog.md, read and written (docs/backlog-page.md)
    { id: 'memory', label: 'nav.memory', href: '/#memoire' },
    { id: 'access', label: 'nav.access', href: '/#acces' },
    { id: 'burst', label: 'nav.burst', href: '/#rafale' },
    { id: 'pilot', label: 'nav.pilot', href: '/#pilote' },
    { id: 'team', label: 'nav.team', href: '/#equipe' }, // Escadrille en équipe (docs/team.md): the dot when the sharing is on
    { id: 'architecture', label: 'nav.architecture', href: '/architecture' },
    { id: 'learning', label: 'nav.learning', href: '/learning' },
    { id: 'replies', label: 'nav.replies', href: '/replies' }, // FILE: the replies to the launch posts (docs/replies.md)
    { id: 'comm', label: 'nav.comm', href: '/comm' }, // the communication plan, read from comm/ (lib/comm.mjs)
  ];
  const ALIASES = { '#limite': '#rafale' }; // old anchors that still land on the right screen

  // The current screen of a URL: one per page, never two; /signaler has none; the entry is `entry`
  const current = ({ pathname = '/', hash = '' } = {}) => {
    const p = String(pathname).replace(/\/+$/, '') || '/'; const h = ALIASES[hash] || String(hash || '');
    if (p === '/') {
      if (/^#\/entree(\/|$)/.test(h)) return 'entry';
      if (h === '#memoire') return 'memory';
      if (/^#acces(-\w+)?$/.test(h)) return 'access';
      if (h === '#rafale') return 'burst';
      if (h === '#pilote') return 'pilot';
      if (h === '#equipe') return 'team';
      return 'conversation';
    }
    if (p === '/entree') return 'entry';
    if (p.startsWith('/e/')) return 'conversation';
    if (p === '/resources') return 'resources';
    if (p === '/flow' || p === '/plan' || p.startsWith('/plan/')) return 'flow';
    if (p === '/review' || p.startsWith('/review/')) return 'review';
    if (p === '/backlog') return 'backlog';
    if (p === '/architecture') return 'architecture';
    if (p === '/learning') return 'learning';
    if (p === '/replies') return 'replies';
    if (p === '/comm') return 'comm';
    return null;
  };

  // The one line at the bottom, folded: « Ce Mac · 2 sessions · iPhone · quota 74 % · Pilote confirmé »
  const line = ({ running = null, devices = null, horizon = null, game = null, team = null } = {}) => {
    const parts = [];
    const n = running && Array.isArray(running.ours) ? running.ours.filter((r) => r.kind === 'session').length : null;
    parts.push(n === null ? T('nav.thisMac') : n ? T('nav.macSessions', { n }) : T('nav.macIdle'));
    if (devices && Array.isArray(devices.devices)) parts.push(devices.devices.length ? devices.devices[0].name + (devices.devices.length > 1 ? ` +${devices.devices.length - 1}` : '') : T('nav.noPhone'));
    if (horizon && typeof horizon.usedPct === 'number') parts.push(T('nav.quotaShort', { pct: Math.round(horizon.usedPct) }));
    if (game && !game.off && game.rank) parts.push(rankName(game));
    if (team && team.on) parts.push(T('nav.teamOn')); // the sharing is on: said on every page (docs/team.md)
    return parts.join(' · ');
  };

  // The theme: the system's, unless the URL says ?theme=dark or ?theme=light (a capture, a check of the other theme);
  // app.css reads data-theme on <html>. Set before the bar is drawn so the mark and the page take it together.
  const theme = () => { try { const q = new URLSearchParams(root.location.search); const t = q.get('theme'); if (t === 'dark' || t === 'light') root.document.documentElement.dataset.theme = t; } catch {} };
  // The mark, inline: the geometry of scripts/brand.mjs (public/brand/symbol.svg, test/tokens.test.mjs keeps them equal),
  // calmdev's open c in the text ink and its still point in the accent, so the mark follows the theme like every other token
  const MARK = '<svg viewBox="0 0 256 256" aria-hidden="true" focusable="false"><path fill="none" stroke="currentColor" stroke-width="34" stroke-linecap="round" d="M196.37 66.44A92 92 0 1 0 196.37 189.56"/><circle fill="var(--accent)" cx="128" cy="128" r="30"/></svg>';

  const item = (x, { group }) => `<a class="nav-item" data-nav="${x.id}" data-href="${esc(x.href)}" data-jk${x.key ? ` title="${esc(T('nav.key', { name: T(x.label), key: x.key }))}" aria-keyshortcuts="${x.key}"` : ''}><span class="label">${esc(T(x.label))}</span>${group ? '<span class="dot" hidden></span>' : '<span class="count" hidden></span>'}</a>`;
  // « Ce qu'Escadrille fait » (docs/capacites.md, the one source, kept honest by test/capacites.test.mjs): one folded
  // line in the bottom line; opened, it reads the page GET /docs/capacites.md already serves and lists what is not
  // done yet first, then what is, each with its proof in its title, and a link to the whole list; a row is done when
  // its proof is a test file (the test enforces it), so the page compares no French word
  const caps = (() => { let rows = null;
    const summary = () => (rows ? T('caps.summary', { done: rows.filter((r) => r.done).length, todo: rows.filter((r) => !r.done).length }) : T('caps.title'));
    const body = () => { if (!rows) return `<p class="m">${esc(T('caps.none'))}</p>`; const li = (r) => `<li title="${esc(r.proof)}">${esc(r.what)}</li>`; const todo = rows.filter((r) => !r.done); const done = rows.filter((r) => r.done);
      return `${todo.length ? `<p class="caps-h">${esc(T('caps.todo', { n: todo.length }))}</p><ul class="caps-list">${todo.map(li).join('')}</ul>` : ''}<p class="caps-h">${esc(T('caps.done', { n: done.length }))}</p><ul class="caps-list">${done.map(li).join('')}</ul><a class="caps-all" href="/docs/capacites.md">${esc(T('caps.all'))}</a>`; };
    const load = async (el) => { if (!rows) { try { const r = await root.fetch('/docs/capacites.md'); if (r.ok) { const d = new root.DOMParser().parseFromString(await r.text(), 'text/html');
      rows = [...d.querySelectorAll('tbody tr')].map((tr) => [...tr.children].map((c) => c.textContent.trim())).filter((c) => c.length >= 3).map(([what, , proof]) => ({ what, done: /^test\//.test(proof), proof })); } } catch {} }
      const s = el.querySelector(':scope > summary'); if (s) s.textContent = summary(); const b = el.querySelector('.caps-body'); if (b) b.innerHTML = body(); };
    return { summary, load }; })();
  // The skeleton, drawn once: the entry, the place of the projects, the add line, the bottom line with the blocks
  // mac.js and phone.js fill
  const markup = () => `<button type="button" class="btn ghost close" data-close>${esc(T('nav.close'))}</button>
<a class="nav-item entry" data-entry href="${ENTRY}" title="${esc(T('nav.entryTitle'))}">${MARK}<span class="label">${esc(T('nav.entry'))}</span></a>
<div class="projects" id="sbProjects" role="list" aria-label="${esc(T('nav.projectsAria'))}"></div>
<p class="pp-note" id="ppNote" aria-live="polite" hidden></p>
${addMarkup()}
<div class="bottom"><div class="lang-pick" role="group" aria-label="${esc(T('lang.aria'))}">${['en', 'fr'].map((l) => `<button type="button" data-lang="${l}" lang="${l}" aria-pressed="${String(lang() === l)}" data-tip="${esc(T('lang.' + l))}">${esc(T('lang.' + l + 'Short'))}</button>`).join('<span aria-hidden="true">·</span>')}</div>
<details class="bottom-line" id="bottomLine"><summary><span class="live-dot" id="liveDot" aria-hidden="true"></span><span class="t" id="bottomText">${esc(T('nav.thisMac'))}</span></summary>
  <div class="b">
    <details class="mac" id="mac" hidden><summary>${esc(T('nav.onThisMac'))}</summary><div class="mac-body"></div></details>
    <details class="mac phone" id="phone" hidden><summary>${esc(T('nav.phone'))}</summary><div class="phone-body"></div></details>
    <details class="mac caps" id="caps"><summary>${esc(caps.summary())}</summary><div class="caps-body"></div></details>
    <div id="sbQuota">${esc(T('nav.quotaNone'))}</div>
    <div id="sbTeam" hidden></div>
    <div id="sbGrade" hidden></div>
    <div><b id="host"></b> · <span class="live" id="live">${esc(T('nav.connecting'))}</span></div>
    <div><a id="sbSignal" href="/signaler.html">${esc(T('nav.reportDefect'))}</a><span id="sbExport" hidden> · <a href="#" download>${esc(T('nav.exportJson'))}</a></span></div>
  </div>
</details></div>`;

  const lang = () => (root.escadrilleI18n ? root.escadrilleI18n.lang : 'en');
  const doc = root.document;
  const S = { el: null, project: null, current: undefined, plan: null, projects: null, es: null, timer: null, data: {}, waits: {}, folded: false };
  const $ = (sel) => (S.el && S.el.querySelector ? S.el.querySelector(sel) : null);
  const $$ = (sel) => (S.el && S.el.querySelectorAll ? [...S.el.querySelectorAll(sel)] : []);
  const api = (p) => fetch(p).then((r) => (r.ok ? r.json() : null)).catch(() => null);
  const q = () => (S.project ? '?project=' + encodeURIComponent(S.project) : '');
  const curOf = () => (S.current === undefined ? current(root.location || {}) : S.current);

  // Links and the current mark: the current project's menu keeps ?project= on every href; the entry is marked on its page
  const links = () => {
    const cur = curOf();
    for (const a of $$('.pj[data-current] [data-nav]')) {
      const id = a.dataset.nav; a.href = withProject(a.dataset.href, S.project);
      if (id === cur) a.setAttribute('aria-current', 'page'); else a.removeAttribute('aria-current');
    }
    const en = $('[data-entry]'); if (en) { if (cur === 'entry') en.setAttribute('aria-current', 'page'); else en.removeAttribute('aria-current'); }
    const sig = $('#sbSignal'); if (sig) { const screen = { entry: 'Entrée', conversation: 'Conversation', resources: 'Ressources', flow: 'Flot', review: 'Revue', memory: 'Mémoire', access: 'Accès', burst: 'Rafale', pilot: 'Pilote', team: 'Équipe', architecture: 'Architecture', learning: 'Apprentissage', comm: 'Communication' }[cur]; /* i18n-ok: the screen's id in the report, read by the server */ sig.href = withProject('/signaler.html' + (screen ? '?ecran=' + encodeURIComponent(screen) : ''), S.project); }
    const ex = $('#sbExport'); if (ex) { ex.hidden = !S.plan; const a = ex.querySelector && ex.querySelector('a'); if (a && S.plan) a.href = '/api/export/' + encodeURIComponent(S.plan); }
    const mac = $('#mac'); if (mac && mac.dataset) mac.dataset.project = S.project || '';
    const cp = doc && doc.getElementById('crumbProj'); if (cp) { cp.textContent = name(S.project); cp.title = S.project || ''; cp.hidden = !S.project; const sep = cp.nextElementSibling; if (sep && sep.tagName === 'I') sep.hidden = !S.project; }
  };

  // ---- The projects, stacked (session NAV). The list is the registry of Escadrille (GET /api/projects, lib/projects.mjs,
  // already the most recently used first), never every folder Claude Code knows; the current project leads.
  const short = (p) => { const parts = String(p || '').split('/').filter(Boolean); parts.pop(); const h = parts.slice(0, 2).join('/'); return (/^(Users|home)\/[^/]+$/.test(h) ? '~/' + parts.slice(2).join('/') : '/' + parts.join('/')).replace(/\/$/, '') || '/'; };
  // The order of the bar: the current project, then the others as the API gives them (by recent activity)
  const order = (projects, project) => { const list = (projects || []).filter((p) => p && p !== project); return project ? [project, ...list] : list; };
  // The next row, ↓ (+1) or ↑ (-1), wrapping at both ends; -1 when there is none
  const step = (i, n, dir) => (n ? (i < 0 ? (dir > 0 ? 0 : n - 1) : (i + dir + n) % n) : -1);
  const addError = (code) => (['not-absolute', 'not-found', 'not-a-folder'].includes(code) ? T('nav.pp.err.' + code) : T('nav.pp.err.other', { why: code || '?' }));
  // the project's logo when the server finds one in its folder (GET /api/projects/logo, lib/projectlogo.mjs), its initial otherwise
  const logoUrl = (p) => '/api/projects/logo?project=' + encodeURIComponent(p);
  // Another project, on the same screen: ?project= changes, an object's page goes to its screen, the object's keys go
  const hrefFor = (p, loc = root.location || {}) => {
    const path = String(loc.pathname || '/').replace(/\/+$/, '') || '/';
    const base = path === '/plan' || path.startsWith('/plan/') ? '/flow' : path.startsWith('/e/') ? '/' : path.startsWith('/review/') ? '/review' : path === '/signaler.html' || path === '/signaler' ? '/' : path;
    const keep = new URLSearchParams(loc.search || ''); keep.set('project', p); for (const k of ['node', 'tab', 'plan', 'session', 'base', 'head', 'pick']) keep.delete(k);
    const hash = base === path && loc.hash && !/^#\/entree/.test(loc.hash) ? loc.hash : '';
    return base + '?' + keep.toString() + hash;
  };
  // What waits for the developer in a project: sessions waiting for an answer, reviews to read; { n, text }
  const waitOf = ({ flow = 0, review = 0 } = {}) => {
    const f = Number(flow) || 0; const r = Number(review) || 0; const parts = [];
    if (f) parts.push(T('nav.wait.flow', { n: f })); if (r) parts.push(T('nav.wait.review', { n: r }));
    return { n: f + r, text: parts.join(' · ') };
  };
  const toReviewCount = (reviews) => { const rvs = reviews ? (Array.isArray(reviews) ? reviews : reviews.reviews || []) : []; return root.escadrilleProjects && root.escadrilleProjects.toReview ? root.escadrilleProjects.toReview(rvs).length : rvs.length; };
  // One project: its head (logo, name, the waiting dot), its menu when it is the current one. A folded project's head is
  // a link to the same screen in that project (one click, never two); the current one's head folds and unfolds its menu.
  const projectHtml = (p, { cur = false, open = true, wait = { n: 0, text: '' } } = {}) => {
    const n = name(p); const showWait = wait.n > 0 && !(cur && open);
    const inner = `<span class="pj-logo" aria-hidden="true"><img alt="" loading="lazy" src="${esc(logoUrl(p))}"><i class="pj-initial">${esc((n[0] || '?').toUpperCase())}</i></span><span class="pj-n">${esc(n)}</span><span class="pj-wait"${showWait ? ` role="img" aria-label="${esc(wait.text)}" title="${esc(wait.text)}"` : ' hidden'}></span>`;
    const PENCIL = `<button type="button" class="pj-ren" data-pp-rename="${esc(p)}" title="${esc(T('projects.rename'))}" aria-label="${esc(T('projects.renameAria', { name: n }))}"><svg viewBox="0 0 16 16" width="14" height="14" aria-hidden="true" fill="none" stroke="currentColor" stroke-width="1.4" stroke-linecap="round" stroke-linejoin="round"><path d="M10.5 2.5l3 3L5 14H2v-3z"/></svg></button>`;
    const head = cur
      ? `<button type="button" class="pj-head" data-pj-toggle aria-expanded="${String(open)}" aria-controls="pjMenu" aria-label="${esc(T(open ? 'nav.fold' : 'nav.unfold', { name: n }))}" title="${esc(p)}">${inner}</button><span class="pj-acts">${PENCIL}</span>`
      : `<a class="pj-head" data-pj-go="${esc(p)}" href="${esc(hrefFor(p))}" title="${esc(p)}">${inner}</a><span class="pj-acts">${PENCIL}<button type="button" class="pj-x" data-pp-remove="${esc(p)}" aria-label="${esc(T('nav.pp.removeAria', { name: n }))}">${esc(T('nav.pp.remove'))}</button></span>`;
    const menu = cur ? `<div class="pj-menu" id="pjMenu"${open ? '' : ' hidden'}><div class="steps">${STEPS.map((x) => item(x, { group: false })).join('')}</div><div class="proj">${PROJECT.map((x) => item(x, { group: true })).join('')}</div></div>` : '';
    return `<div class="pj${cur ? ' is-current' : ''}" role="listitem" data-path="${esc(p)}"${cur ? ' data-current' : ''}><div class="pj-row">${head}</div>${menu}</div>`;
  };
  // The add line: one button; it unfolds a path field completed by the server (GET /api/projects/dirs) and the folders
  // Claude Code used lately (GET /api/projects/suggestions), validated by POST /api/projects
  const addMarkup = () => `<div class="pj-add-line"><button type="button" class="nav-item pj-add-open" data-pp-add aria-expanded="false" aria-controls="ppAdd"><span class="label">${esc(T('nav.pp.add'))}</span></button>
<form class="pj-add" id="ppAdd" hidden novalidate>
  <label class="pp-label" for="ppPath">${esc(T('nav.pp.pathLabel'))}</label>
  <div class="pp-row"><input class="control pp-path" id="ppPath" name="path" list="ppDirs" placeholder="${esc(T('nav.pp.pathPlaceholder'))}" autocomplete="off" spellcheck="false" aria-describedby="ppErr"><button class="btn" type="submit">${esc(T('nav.pp.addSubmit'))}</button></div>
  <datalist id="ppDirs"></datalist>
  <p class="pp-err" id="ppErr" role="alert"></p>
  <div class="pp-sugg" id="ppSugg" hidden><div class="pp-label">${esc(T('nav.pp.recent'))}</div><div class="pp-sugg-list"></div></div>
</form></div>`;
  const P = { add: false, undo: null, info: '' };
  const waitFor = (p) => (p === S.project ? waitOf({ flow: S.data.flow && S.data.flow.totals ? S.data.flow.totals.mine : 0, review: toReviewCount(S.data.reviews) }) : waitOf(S.waits[p] || {}));
  const drawProjects = () => {
    const box = $('#sbProjects'); if (!box) return;
    const had = doc && doc.activeElement && S.el.contains && S.el.contains(doc.activeElement) ? (doc.activeElement.dataset || {}) : null;
    box.innerHTML = order(S.projects, S.project).map((p) => projectHtml(p, { cur: p === S.project, open: !S.folded, wait: waitFor(p) })).join('');
    for (const img of box.querySelectorAll ? box.querySelectorAll('.pj-logo img') : []) { const sp = img.parentNode; const got = () => { if (sp && sp.classList) sp.classList.add('has-logo'); }; img.onload = got; img.onerror = () => { img.hidden = true; }; if (img.complete && img.naturalWidth) got(); }
    links(); paint();
    if (had) { const back = had.pjToggle !== undefined ? $('[data-pj-toggle]') : had.pjGo ? $$('[data-pj-go]').find((a) => a.dataset.pjGo === had.pjGo) : had.nav ? $(`.pj[data-current] [data-nav="${had.nav}"]`) : null; if (back) back.focus(); }
    const note = $('#ppNote'); if (note) { note.hidden = !P.undo && !P.info; note.innerHTML = !P.undo && P.info ? esc(P.info) : P.undo ? `${esc(T('nav.pp.removed', { name: name(P.undo) }))} <button type="button" class="card-link" data-pp-undo>${esc(T('nav.pp.undo'))}</button>` : ''; }
    if (!(S.projects || []).length && !S.project && !P.add) showAdd(true, false);
  };
  // Only the dots move on a refresh (the rows under the pointer stay the same elements)
  const paintWaits = () => {
    for (const row of $$('.pj')) {
      const p = row.dataset.path; const w = waitFor(p); const el = row.querySelector('.pj-wait'); if (!el) continue;
      const on = w.n > 0 && !(p === S.project && !S.folded);
      el.hidden = !on; if (on) { el.setAttribute('role', 'img'); el.setAttribute('aria-label', w.text); el.title = w.text; } else { el.removeAttribute('aria-label'); el.removeAttribute('title'); }
    }
  };
  const fold = (on) => { S.folded = on; const m = $('#pjMenu'); const h = $('[data-pj-toggle]'); if (m) m.hidden = on; if (h) { h.setAttribute('aria-expanded', String(!on)); h.setAttribute('aria-label', T(on ? 'nav.unfold' : 'nav.fold', { name: name(S.project) })); } paintWaits(); };
  const showAdd = (on, focus = true) => {
    P.add = on; const f = $('#ppAdd'); const b = $('[data-pp-add]'); if (!f) return;
    f.hidden = !on; if (b) b.setAttribute('aria-expanded', String(on));
    if (on) { const e = $('#ppErr'); if (e) e.textContent = ''; const i = $('#ppPath'); if (i && focus) i.focus(); loadSuggestions(); }
    else { const i = $('#ppPath'); if (i) i.value = ''; if (focus && b) b.focus(); }
  };
  const post = (url, body) => fetch(url, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) }).then(async (r) => ({ ok: r.ok, status: r.status, body: await r.json().catch(() => ({})) })).catch((e) => ({ ok: false, body: { error: e.message } }));
  const listOf = (got) => (Array.isArray(got) ? got : (got && got.projects) || []).map((p) => (typeof p === 'string' ? p : p.path)).filter(Boolean);
  // Names (docs/multiproject.md): the page keeps the last list's names in escadrilleProjects; when one changes, the
  // button, the crumb and the tab title follow without a reload, and `escadrille:projectnames` tells the other scripts.
  const PRJ = () => root.escadrilleProjects || { setNames() {}, setLocal: () => '', clean: (v) => String(v ?? '').trim() };
  const applyNames = (apply) => {
    const before = S.project ? name(S.project) : null; apply();
    const after = S.project ? name(S.project) : null;
    drawProjects();
    if (before === after || !after) return;
    if (doc.title && doc.title.includes(before)) doc.title = doc.title.split(before).join(after);
    const cp = doc.getElementById && doc.getElementById('crumbProj'); if (cp) cp.textContent = after;
    if (root.dispatchEvent && typeof root.CustomEvent === 'function') root.dispatchEvent(new root.CustomEvent('escadrille:projectnames', { detail: { project: S.project, name: after } }));
  };
  const listNames = (got) => (Array.isArray(got) ? got : (got && got.projects) || []).filter((x) => x && typeof x === 'object');
  const editName = (p) => {
    const li = $('.pj').find((x) => x.dataset.path === p); if (!li || li.querySelector('.pj-edit')) return;
    const n = li.querySelector('.pj-row'); if (!n) return;
    const input = doc.createElement('input'); input.className = 'pj-edit'; input.type = 'text'; input.maxLength = 120; input.value = name(p);
    input.placeholder = String(p).split('/').filter(Boolean).pop() || p; input.autocomplete = 'off'; input.spellcheck = false;
    input.setAttribute('aria-label', T('projects.renameField', { name: name(p) })); input.dataset.path = p;
    li.setAttribute('data-editing', ''); n.appendChild(input); input.focus(); input.select();
  };
  const endEdit = (input, save) => {
    const li = input.closest('.pj'); const p = input.dataset.path; const v = input.value;
    if (!li || li.dataset.ending) return; li.dataset.ending = '1';
    const back = () => { if (li.isConnected) { input.remove(); li.removeAttribute('data-editing'); delete li.dataset.ending; } const b = $('[data-pp-rename]').find((x) => x.dataset.ppRename === p); if (b) b.focus(); };
    if (!save || PRJ().clean(v) === name(p)) { back(); return; }
    renameProject(p, v).then(back);
  };
  const renameProject = async (p, v) => {
    const PR = PRJ(); P.info = '';
    const r = await post('/api/projects/name', { path: p, name: v });
    if (r.ok) { applyNames(() => { PR.setLocal(p, ''); PR.setNames(listNames(r.body)); }); }
    else if ([404, 405, 501].includes(r.status) && !(r.body && r.body.error === 'unknown-project')) { applyNames(() => PR.setLocal(p, v)); P.info = T('projects.renameLocal'); }
    else P.info = T('projects.renameFail', { why: (r.body && r.body.error) || r.status || '?' });
    drawProjects();
  };
  const removeProject = async (p) => {
    const r = await post('/api/projects/remove', { path: p }); if (!r.ok) return;
    S.projects = listOf(r.body); PRJ().setNames(listNames(r.body)); P.undo = p; drawProjects(); const u = $('[data-pp-undo]'); if (u) u.focus();
  };
  const undoRemove = async () => {
    const p = P.undo; if (!p) return; const r = await post('/api/projects', { path: p });
    if (r.ok) S.projects = listOf(r.body); P.undo = null; drawProjects(); loadWaits();
  };
  const addProject = async (v) => {
    const e = $('#ppErr'); const r = await post('/api/projects', { path: v });
    if (!r.ok) { if (e) e.textContent = addError(r.body && r.body.error); const i = $('#ppPath'); if (i) i.focus(); return; }
    S.projects = listOf(r.body); showAdd(false, false); go(r.body.path);
  };
  const loadSuggestions = async () => {
    const box = $('#ppSugg'); if (!box) return;
    const got = await api('/api/projects/suggestions'); const list = (got && got.suggestions) || [];
    box.hidden = !list.length;
    const el = box.querySelector('.pp-sugg-list'); if (el) el.innerHTML = list.map((x) => `<button type="button" class="pp-s" data-pp-suggest="${esc(x.path)}" title="${esc(x.path)}"><span class="pp-n">${esc(x.name)}</span><span class="pp-p">${esc(short(x.path))}</span></button>`).join('');
  };
  let suggT = null;
  const complete = (v) => { clearTimeout(suggT); suggT = setTimeout(async () => { const got = await api('/api/projects/dirs?prefix=' + encodeURIComponent(v)); const dl = $('#ppDirs'); if (dl) dl.innerHTML = ((got && got.dirs) || []).map((d) => `<option value="${esc(d)}"></option>`).join(''); }, 120); };
  // ?pick=add opens the add line at load (a capture, like ?nav=open for the drawer)
  const loadProjects = async () => {
    const got = await api('/api/projects'); S.projects = listOf(got);
    applyNames(() => PRJ().setNames(listNames(got))); loadWaits();
    if (/[?&]pick=add(&|$)/.test((root.location && root.location.search) || '') && !S.picked) { S.picked = true; showAdd(true); }
  };
  // The folded projects' dots: the same two routes as the current project's counts, for each of them, never on a change
  let waitsBusy = false;
  const loadWaits = async () => {
    const others = order(S.projects, S.project).filter((p) => p !== S.project); if (!others.length || waitsBusy) return; waitsBusy = true;
    try {
      const got = await Promise.all(others.map((p) => Promise.all([api('/api/projectflow?project=' + encodeURIComponent(p)), api('/api/reviews?project=' + encodeURIComponent(p))])));
      others.forEach((p, i) => { const [f, r] = got[i]; S.waits[p] = { flow: f && f.totals ? f.totals.mine : 0, review: toReviewCount(r) }; });
      paintWaits();
    } finally { waitsBusy = false; }
  };
  // Changing the project changes ?project= and the localStorage, then reloads the view
  const remember = (p) => { try { root.localStorage.setItem('escadrille.project', p); } catch {} };
  const go = (p) => { if (!p) return; remember(p); root.location.href = hrefFor(p); };

  // The counts and the dots of the current project, from the API; a zero is absent, never « 0 »
  const count = (id, n) => { const el = $(`.pj[data-current] [data-nav="${id}"] .count`); if (!el) return; const v = Number(n) || 0; el.hidden = !v; el.textContent = v ? String(v) : ''; };
  const dot = (id, on) => { const el = $(`.pj[data-current] [data-nav="${id}"] .dot`); if (!el) return; el.hidden = !on; el.className = on ? 'dot on' : 'dot'; if (on) el.setAttribute('aria-label', T('nav.running')); else el.removeAttribute('aria-label'); };
  const conversationCount = (main) => {
    const msgs = main && Array.isArray(main.messages) ? main.messages : []; // newest first
    let n = 0; let afterDev = true;
    for (const m of msgs) {
      if (m.role === 'dev') afterDev = false;
      const d = m.data || {};
      if (m.role === 'claude' && d.proposal && d.proposal.status === 'proposed') n++;
      else if (m.role === 'claude' && afterDev && Array.isArray(d.questions) && d.questions.length) n++;
    }
    return n;
  };
  const paint = () => {
    const d = S.data;
    count('conversation', conversationCount(d.main));
    count('flow', d.flow && d.flow.totals ? d.flow.totals.mine : 0);
    count('review', toReviewCount(d.reviews));
    dot('burst', !!(d.bursts && (d.bursts.bursts || []).some((b) => b.status === 'running' || b.status === 'draining')));
    dot('pilot', !!(d.pilot && d.pilot.on));
    dot('team', !!(d.team && d.team.on));
    paintWaits();
  };
  const fill = () => {
    const d = S.data;
    paint();
    const t = $('#bottomText'); if (t) t.textContent = line(d);
    // the team's line, open: « Équipe · partage allumé · Dev · Relais joint · 2 collègues », a link to the screen
    const tm = $('#sbTeam'); if (tm) { const x = d.team; if (x && x.on) { tm.hidden = false; tm.innerHTML = `<a href="${esc(withProject('/#equipe', S.project))}">${esc(T('nav.teamLine', { member: x.member || '', line: (x.status && x.status.line) || '' }))}</a>`; } else { tm.hidden = true; tm.innerHTML = ''; } }
    const qn = $('#sbQuota'); if (qn) { const h = d.horizon; qn.textContent = h && typeof h.usedPct === 'number' ? (h.hoursLeft == null ? T('nav.quota', { pct: Math.round(h.usedPct) }) : h.hoursLeft < 1 ? T('nav.quotaResetMin', { pct: Math.round(h.usedPct), n: Math.max(1, Math.round(h.hoursLeft * 60)) }) : T('nav.quotaResetH', { pct: Math.round(h.usedPct), n: Math.round(h.hoursLeft) })) : T('nav.quotaNone'); }
    const g = $('#sbGrade'); if (g) { const x = d.game; if (x && !x.off && x.rank) { g.hidden = false; g.innerHTML = `<b>${esc(rankName(x))}</b> · <span class="num">${x.next ? `${esc(x.xp)} / ${esc(x.next.xp)}` : esc(x.xp)} XP</span> · <button type="button" class="card-link" data-gm-open>${esc(T('nav.progression'))}</button><span class="gm-gain" aria-live="polite"></span>`; } else { g.hidden = true; g.innerHTML = ''; } }
    if (root.escadrilleMac) root.escadrilleMac.load(); if (root.escadrillePhone) root.escadrillePhone.load();
  };
  let busy = false;
  // A change reloads what it moves (the thread, the flow, the pilot, what runs); the review queue, the bursts, the devices,
  // the quota, the progression, the team and the other projects' dots wait for the 30 s timer or a new project
  // (docs/perf.md: ten routes on every change of every tab, git included, froze the Mac on 2026-11-02).
  const CHANGE_ROUTES = ['main', 'flow', 'pilot', 'running'];
  const refresh = async (light = false) => {
    if (!S.el || busy) return; busy = true;
    try {
      if (S.project) {
        const all = { main: () => api('/api/main' + q() + '&limit=20'), flow: () => api('/api/projectflow' + q()), reviews: () => api('/api/reviews' + q()), bursts: () => api('/api/bursts' + q()), pilot: () => api('/api/pilot' + q()),
          running: () => api('/api/running' + q()), devices: () => api('/api/devices'), horizon: () => api('/api/project/horizon' + q()), game: () => api('/api/game' + q()), team: () => api('/api/team' + q()) };
        const names = light && S.data && S.data.flow ? CHANGE_ROUTES : Object.keys(all);
        const got = await Promise.all(names.map((k) => all[k]()));
        S.data = { ...(light ? S.data : {}), ...Object.fromEntries(names.map((k, i) => [k, got[i]])) };
      } else { const [running, devices] = await Promise.all([api('/api/running'), api('/api/devices')]); S.data = { running, devices }; }
      fill();
      if (root.EscadrilleLive) root.EscadrilleLive.refresh(); // the top bar's « N tournent · X $ » moves with the bar (public/livecount.js)
      if (!light && S.projects && S.projects.length) loadWaits();
    } finally { busy = false; }
  };
  // Live: one stream per project; the `change` event refreshes the counts (debounced), the dot says the connection
  const connect = () => {
    if (S.es) { S.es.close(); S.es = null; }
    if (typeof EventSource === 'undefined') return;
    const live = $('#live'); const dotEl = $('#liveDot'); const set = (text, on) => { if (live) live.textContent = text; if (dotEl) dotEl.className = on ? 'live-dot on' : 'live-dot'; };
    const es = new EventSource('/api/events' + q()); S.es = es; let t = null;
    es.onopen = () => set(T('nav.live'), true); es.addEventListener('hello', () => set(T('nav.live'), true));
    es.addEventListener('change', () => { clearTimeout(t); t = setTimeout(() => refresh(true), 400); });
    es.onerror = () => { set(T('nav.reconnecting'), false); };
  };

  // The drawer at 390: the same bar, open with Menu, closed by Fermer, Escape or a link
  const open = (on) => { if (!S.el) return; S.el.classList.toggle('open', on); for (const b of doc.querySelectorAll('.menu-toggle')) b.setAttribute('aria-expanded', String(on)); const bl = $('#bottomLine'); if (on && bl) bl.open = true; const UX = root.escadrilleUX; const m = doc.querySelector('.menu-toggle');
    if (on) { if (UX) UX.open(S.el, { trigger: m, close: () => open(false), trap: true }); const c = $('[data-close]'); if (c && c.offsetParent !== null) c.focus(); }
    else { if (UX) UX.close(S.el, { focus: false }); if (m && m.offsetParent !== null) m.focus(); } };
  const isOpen = () => !!(S.el && S.el.classList.contains('open'));

  // The rows the arrows walk through, in the order of the bar: the entry, each project's head, the open menu, the add line
  const NAV_ROWS = '[data-entry], .pj-head, .pj-menu:not([hidden]) .nav-item, [data-pp-add]';
  const navRows = () => $$(NAV_ROWS).filter((el) => !(el.closest && el.closest('[hidden]')));
  const bind = () => {
    if (S.bound || !doc) return; S.bound = true;
    doc.addEventListener('click', (e) => {
      const t = e.target.closest ? e.target : null; if (!t) return;
      if (t.closest('.menu-toggle')) { open(!isOpen()); return; }
      const lb = t.closest('[data-lang]'); if (lb && S.el && S.el.contains(lb) && root.escadrilleI18n) { root.escadrilleI18n.set(lb.dataset.lang); return; }
      if (S.el && t.closest('[data-close]') && S.el.contains(t)) { open(false); return; }
      if (!S.el || !S.el.contains(t)) return;
      if (t.closest('.pj-edit')) return;
      const rn = t.closest('[data-pp-rename]'); if (rn) { editName(rn.dataset.ppRename); return; }
      if (t.closest('[data-pj-toggle]')) { fold(!S.folded); return; }
      const g = t.closest('[data-pj-go]'); if (g) remember(g.dataset.pjGo);
      const x = t.closest('[data-pp-remove]'); if (x) { removeProject(x.dataset.ppRemove); return; }
      if (t.closest('[data-pp-undo]')) { undoRemove(); return; }
      if (t.closest('[data-pp-add]')) { showAdd(!P.add); return; }
      const sg = t.closest('[data-pp-suggest]'); if (sg) { addProject(sg.dataset.ppSuggest); return; }
      if (isOpen() && t.closest('a[href]')) open(false);
    });
    doc.addEventListener('keydown', (e) => {
      const t = e.target;
      if (t && t.classList && t.classList.contains('pj-edit')) {
        if (e.key === 'Enter' && !e.isComposing) { e.preventDefault(); e.stopPropagation(); endEdit(t, true); }
        else if (e.key === 'Escape') { e.preventDefault(); e.stopPropagation(); endEdit(t, false); }
        return;
      }
      if (P.add && e.key === 'Escape' && t && t.closest && t.closest('#ppAdd')) { e.preventDefault(); e.stopPropagation(); showAdd(false); return; }
      // ↑ ↓ Home End through the bar's rows, → ← unfold and fold the current project (← from its menu goes to its head)
      if (S.el && t && S.el.contains(t) && t.matches && t.matches(NAV_ROWS) && !e.metaKey && !e.ctrlKey && !e.altKey) {
        const rowsNow = navRows(); const i = rowsNow.indexOf(t);
        if (e.key === 'ArrowDown' || e.key === 'ArrowUp') { e.preventDefault(); const n = rowsNow[step(i, rowsNow.length, e.key === 'ArrowDown' ? 1 : -1)]; if (n) n.focus(); return; }
        if (e.key === 'Home' || e.key === 'End') { e.preventDefault(); const n = rowsNow[e.key === 'Home' ? 0 : rowsNow.length - 1]; if (n) n.focus(); return; }
        if (e.key === 'ArrowRight' && t.matches('[data-pj-toggle]') && S.folded) { e.preventDefault(); fold(false); return; }
        if (e.key === 'ArrowLeft' && t.matches('[data-pj-toggle]') && !S.folded) { e.preventDefault(); fold(true); return; }
        if (e.key === 'ArrowLeft' && t.closest('.pj-menu')) { e.preventDefault(); const h = $('[data-pj-toggle]'); if (h) h.focus(); return; }
      }
      // Escape in the bottom line closes the innermost open block (Ce qui tourne, Capacités, then the line) and gives the focus back to its summary
      const fold1 = e.key === 'Escape' && t && t.closest && t.closest('#bottomLine') ? t.closest('details[open]') : null;
      if (fold1) { e.preventDefault(); fold1.open = false; const s = fold1.querySelector(':scope > summary'); if (s) s.focus(); return; }
      if (e.key === 'Escape' && isOpen()) { e.preventDefault(); open(false); return; }
      if (e.metaKey || e.ctrlKey || e.altKey || !/^[1-4]$/.test(e.key) || !S.project) return;
      if (t && (/^(INPUT|TEXTAREA|SELECT)$/.test(t.tagName) || t.isContentEditable)) return;
      const st = STEPS[Number(e.key) - 1]; e.preventDefault(); root.location.href = withProject(st.href, S.project);
    });
    doc.addEventListener('toggle', (e) => { if (e.target && e.target.id === 'caps' && e.target.open) caps.load(e.target); }, true);
    doc.addEventListener('input', (e) => { if (e.target.id === 'ppPath') { const er = $('#ppErr'); if (er) er.textContent = ''; complete(e.target.value); } });
    doc.addEventListener('submit', (e) => { if (e.target.id !== 'ppAdd') return; e.preventDefault(); const i = $('#ppPath'); addProject(i ? i.value.trim() : ''); });
    if (root.addEventListener) root.addEventListener('hashchange', () => { alias(); links(); });
  };
  // /#limite lands on Rafale; /#phone opens the bottom line on the phone's block; ?nav=open opens the drawer (a capture at 390)
  const alias = () => {
    const h = root.location.hash;
    if (ALIASES[h] && root.location.replace) { root.location.replace(ALIASES[h]); return; }
    if (h === '#phone') { const bl = $('#bottomLine'); if (bl) bl.open = true; const ph = $('#phone'); if (ph) ph.open = true; }
    if (/[?&]nav=open(&|$)/.test(root.location.search || '') && !isOpen()) open(true);
  };

  const draw = () => {
    const was = $('#bottomLine'); const opened = !!(was && was.open);
    S.el.innerHTML = markup(); const host = $('#host'); if (host && root.location) host.textContent = root.location.host;
    if (opened) { const bl = $('#bottomLine'); if (bl) bl.open = true; }
    P.add = false;
  };
  // Another language: the bar is drawn again with its data, without a reload
  if (root.escadrilleI18n) root.escadrilleI18n.onChange(() => { if (!S.el) return; draw(); drawProjects(); fill(); connect(); });

  const render = (el, { project, current: cur, plan } = {}) => {
    if (!el) return;
    if (S.el !== el) { theme(); S.el = el; draw(); bind(); }
    const before = S.project;
    if (project !== undefined) S.project = project || null;
    if (cur !== undefined) S.current = cur;
    if (plan !== undefined) S.plan = plan || null;
    if (!S.project && root.location) {
      try { S.project = new URLSearchParams(root.location.search).get('project') || root.localStorage.getItem('escadrille.project') || null; } catch {}
      if (!S.project) api('/api/escadrilles').then((list) => { if (S.project || !Array.isArray(list) || !list.length) return; const last = [...list].sort((a, b) => Date.parse(b.at || b.created || 0) - Date.parse(a.at || a.created || 0))[0]; if (last && last.project) render(el, { project: last.project }); });
    }
    alias();
    if (S.projects === null) { S.projects = []; loadProjects(); }
    if (before !== S.project || !$('.pj')) drawProjects(); else links();
    if (before !== S.project || !S.es) { connect(); refresh(); if (S.timer && root.clearInterval) root.clearInterval(S.timer); S.timer = root.setInterval ? root.setInterval(() => { if (!doc.hidden) refresh(); }, 30000) : null; }
  };

  root.escadrilleSidebar = { render, refresh, current, line, markup, projectHtml, addMarkup, order, hrefFor, waitOf, step, short, addError, logoUrl, STEPS, PROJECT, ENTRY, conversationCount, open, MARK, project: () => S.project };
  // « À toi » (public/asks.js, .css): loaded here, not by a line in each page, because every app page has this bar and
  // the landing /site/ never does; a new screen gets the modal without anyone thinking of it.
  if (doc && doc.head && doc.createElement && !doc.getElementById('askCss')) {
    const l = doc.createElement('link'); l.rel = 'stylesheet'; l.href = '/asks.css'; l.id = 'askCss'; doc.head.appendChild(l);
    const s = doc.createElement('script'); s.src = '/asks.js'; s.defer = true; doc.head.appendChild(s);
  }
  // What runs (public/livecount.js): the counter of every top bar, loaded the same way; it draws as soon as it is read
  if (doc && doc.head && doc.createElement && !doc.getElementById('liveJs')) {
    const s = doc.createElement('script'); s.src = '/livecount.js'; s.id = 'liveJs'; s.onload = () => root.EscadrilleLive && root.EscadrilleLive.refresh(); doc.head.appendChild(s);
  }
})(typeof window !== 'undefined' ? window : globalThis);
