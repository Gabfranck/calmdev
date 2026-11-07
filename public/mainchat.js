// The Conversation of a project, the home of the app (docs/mainchat.md, docs/phase11/ux.md §8, the mock-up
// docs/phase11/accueil.html validated by Dev on 2026-11-02): `/` opens it (`/#conversation` redirects). In order: the
// title with the state sentence under it (`escadrille · 2 en cours · 1 t'attend · 24,10 $ aujourd'hui`) and the search
// at its right; the thread by day (the developer on the right, Claude on the left, the « Plan proposé » cards, one
// system line per planning launched, the hour always shown); the composer: Dicter and the Pilote switch on the left,
// on the right the one primary button that says what it does, « Planifier » (pilot off: a planning starts) or
// « Envoyer » (pilot on: the pilot answers); under it one folded line (the model, the templates, the import), plain
// words, no chevron. Beside the thread the status panel (GET /api/status): « Maintenant » as one line of figures whose
// sessions float in a card on hover or focus; « Claude » and « Coût » as 14 px lines; the guard folded; « À toi »
// (what waits for the developer, one line and one button each) at the foot. Three states: a project with messages,
// an empty project (the sentence, then the composer right under it), no project (choose a folder, nothing else).
// index.html calls view() from its render() and loads this file; it uses index.html's globals: esc, md, api, fmt,
// canvas, project, meta, settings, P, render, setupSpeech. Escape closes what a click opened here (a folded line, the
// guard, the sheet at 390) and gives the focus back; public/ux.js (phase 11 G) is used when it is there.
(() => {
  const link = document.createElement('link'); link.rel = 'stylesheet'; link.href = '/mainchat.css'; document.head.appendChild(link);
  // the home: no escadrille in the URL and no other anchor (Mémoire, Accès, Rafale, Pilote have theirs)
  const is = () => !escId && /^(|#|#conversation)$/.test(location.hash);
  if (location.hash === '#conversation') history.replaceState(history.state, '', location.pathname + location.search); // the old anchor lands here
  let st = null; // { project, messages (oldest first), more, total, error }
  let pilot = null; let pilotErr = ''; // Phase 8 A: GET /api/pilot, the switch (docs/pilot.md)
  let flow = null; let reviews = null; let escs = null; let perms = {}; // what waits: GET /api/projectflow, /api/reviews, /api/escadrilles, the permissions of GET /api/plan/:id
  let teamInfo = null; // GET /api/team (docs/team.md): the sharing switch, the relay's status, the collisions
  let query = ''; let results = null; let files = null; let filesOpen = false; let importing = null; let note = ''; let es = null; let timer = null;
  let offer = null; // a sentence that only names a setting (public/settingintent.js): the setting offered in one line, nothing planned
  const T = (k, v) => window.T(k, v);
  const day = (iso) => window.T.date(iso, { weekday: 'long', day: 'numeric', month: 'long' });
  const hm = (iso) => window.T.time(iso);
  const size = (n) => (n >= 1e6 ? T('size.mb', { n: Math.round(n / 1e5) / 10 }) : T('size.kb', { n: Math.max(1, Math.round(n / 1e3)) }));
  const LONG = 1400;
  const href = (h) => P.withProject(h, project);
  // md() of index.html, plus the quoted lines of a paste (« > ») as a blockquote
  const rich = (t) => { let out = ''; let buf = []; let q = null; const flush = () => { if (!buf.length) return; out += q ? `<blockquote>${md(buf.join('\n'))}</blockquote>` : md(buf.join('\n')); buf = []; };
    for (const l of String(t).split('\n')) { const isQ = /^>\s?/.test(l); if (q !== null && isQ !== q) flush(); q = isQ; buf.push(isQ ? l.replace(/^>\s?/, '') : l); } flush(); return out; };

  // ---- loading
  const load = async (older = false) => {
    const p = project; if (!p) { st = { project: null, messages: [], more: false, total: 0 }; return render(); }
    const before = older && st && st.messages[0] ? '&before=' + st.messages[0].seq : '';
    const r = await api(`/api/main?project=${encodeURIComponent(p)}&limit=100${before}`).catch((e) => ({ error: e.message }));
    if (p !== project) return;
    if (r.error) { st = { project: p, messages: older && st ? st.messages : [], error: r.error }; return render(); }
    const got = r.messages.slice().reverse();
    st = { project: p, messages: older && st && st.project === p ? [...got, ...st.messages] : got, more: r.more, total: r.total };
    const anchor = older && st.messages[got.length] ? 'mc-' + st.messages[got.length].seq : null;
    if (anchor) stick = false; render(); if (!anchor) bottom(); else { const el = document.getElementById(anchor); if (el) el.scrollIntoView({ block: 'start' }); }
    live(p); loadPilot(p); loadWaiting(p); loadStatus(p);
    if (!statusTimer) statusTimer = setInterval(() => { if (is() && project && !document.hidden) loadStatus(project); }, 30000);
  };
  const loadPilot = async (p) => { const r = await api('/api/pilot?project=' + encodeURIComponent(p)).catch(() => null); if (r && !r.error && p === project) { const was = JSON.stringify(pilot); pilot = r; if (JSON.stringify(r) !== was && is()) render(); } };
  const togglePilot = async (on) => { pilotErr = ''; const r = await api('/api/pilot', { project, on }).catch((e) => ({ error: e.message })); if (r.error) pilotErr = r.error; else pilot = r.pilot; render(); };
  // What waits for the developer, from three read-only sources; the permissions' detail from the plan of each node that asks one
  const loadWaiting = async (p) => {
    const q = '?project=' + encodeURIComponent(p);
    const [f, rv, e, tm] = await Promise.all([api('/api/projectflow' + q).catch(() => null), fetch('/api/reviews' + q).then((r) => (r.ok ? r.json() : null)).catch(() => null), api('/api/escadrilles' + q).catch(() => null), api('/api/team' + q).catch(() => null)]);
    if (p !== project) return;
    flow = f && !f.error ? f : null; escs = Array.isArray(e) ? e : null; teamInfo = tm && !tm.error ? tm : null;
    reviews = rv ? (rv.reviews || rv || []).filter((r) => (r.verdict && (r.verdict.verdict || r.verdict)) !== 'approve') : null;
    const asking = (flow ? flow.nodes : []).filter((n) => n.waitingFor === 'permission');
    const plans = [...new Set(asking.map((n) => n.plan))];
    const got = await Promise.all(plans.map((id) => api('/api/plan/' + encodeURIComponent(id)).catch(() => null)));
    if (p !== project) return;
    perms = {}; plans.forEach((id, i) => { const d = got[i]; if (!d || !Array.isArray(d.state)) return; for (const s of d.state) for (const x of s.pending || []) if (x.kind === 'permission') perms[id + '/' + (s.id || s.session)] = x; });
    if (is()) render();
  };
  // the thread follows its end (stick) until the developer scrolls up; every draw and every growth of the column (fonts
  // landing, a card unfolding) keeps it there, synchronously: two draws in one frame used to leave the thread at its start
  let stick = true;
  // an empty project (.mc-first: the first run's question or the starters) has no end to follow: it is read from its top,
  // never scrolled to its foot (the question's head was cut at 390 px, 7 November)
  const toEnd = (c) => { if (c && stick && !c.classList.contains('mc-first')) c.scrollTop = c.scrollHeight; };
  const bottom = () => { stick = true; toEnd(document.getElementById('mcScroll')); requestAnimationFrame(() => toEnd(document.getElementById('mcScroll'))); };
  const grown = typeof ResizeObserver === 'function' ? new ResizeObserver(() => toEnd(document.getElementById('mcScroll'))) : { observe() {}, disconnect() {} };
  document.addEventListener('scroll', (e) => { const c = e.target; if (!c || c.id !== 'mcScroll') return; stick = c.scrollHeight - c.scrollTop - c.clientHeight < 8; }, true);
  // two streams: the thread's (main=) and the project's plans (project=), the server keys one stream on one of them
  const live = (p) => { if (es && es.p === p) return; if (es) { es.close(); es.flow.close(); } es = new EventSource('/api/events?main=' + encodeURIComponent(p)); es.p = p; es.flow = new EventSource('/api/events?project=' + encodeURIComponent(p));
    let t = null; es.addEventListener('change', () => { if (!is()) return; clearTimeout(t); t = setTimeout(load, 300); }); let t2 = null; es.flow.addEventListener('change', () => { if (!is()) return; clearTimeout(t2); t2 = setTimeout(() => { loadWaiting(p); loadStatus(p); }, 400); }); };
  const search = async () => { if (!query.trim()) { results = null; return render(); } const r = await api(`/api/main?project=${encodeURIComponent(project)}&limit=200&q=${encodeURIComponent(query.trim())}`).catch(() => null); results = r && !r.error ? r : { messages: [], total: 0 }; render(); };
  // the redraw that follows the reading keeps the focus on the import's summary when it had it (Escape then folds it back)
  const loadFiles = async () => { const r = await api('/api/main/transcripts?project=' + encodeURIComponent(project)).catch((e) => ({ error: e.message })); files = r; const had = document.activeElement && document.activeElement.closest && document.activeElement.closest('#mcImport'); render(); if (had || document.activeElement === document.body) { const sm = document.querySelector('#mcImport[open] > summary'); if (sm) sm.focus(); } };

  // ---- « À toi »: only what the developer himself can do (public/todo.js, Dev 2026-11-02 04:10 and 04:45): one line per
  // task written by Escadrille (a verb and its object, never a session's own words), the why in half a grey line, one
  // button that makes the gesture; what a pilot (built-in or external) handles never appears here; three lines shown,
  // the rest counted towards the Flot
  const mergeNotes = new Map(); // "plan/session" → { files, error }: the last refused merge, said on its line until it passes
  // the pilot silent on a message of the developer, or cut after two restarts (GET /api/pilot: unanswered, stall.cut): one line, one
  // button that restarts it (POST /api/pilot/retry)
  const pilotLine = () => {
    const un = (pilot && pilot.unanswered) || []; const cut = !!(pilot && pilot.stall && pilot.stall.cut);
    if (!un.length && !cut) return null;
    const first = un[0] ? String(un[0].text || '').replace(/\s+/g, ' ').slice(0, 90) : '';
    return { badge: '!', text: cut ? T('main.todo.pilotCut') : T('main.todo.pilotSilent', { n: un.length }), why: [pilot.stall && pilot.stall.reason, first && T('main.todo.pilotQuoted', { t: first })].filter(Boolean).join(' · '), act: `<button type="button" class="btn" data-pilot-retry>${esc(T('main.pilotRetry'))}</button>` };
  };
  const pilotRetry = async (btn) => { btn.disabled = true; btn.textContent = T('main.pilotRetrying');
    const r = await api('/api/pilot/retry', { project }).catch((e) => ({ error: e.message }));
    if (r.error) { btn.disabled = false; btn.textContent = T('main.pilotRetry'); document.getElementById('state').textContent = r.error; return; } pilot = r.pilot; render(); };
  const planTitle = (id) => { const p = flow && flow.plans.find((x) => x.id === id); return p ? p.title : id; };
  const threadHref = (it) => href(`/plan/${encodeURIComponent(it.plan)}?node=${encodeURIComponent(it.s)}`);
  const minutes = (m) => (m < 5 ? T('main.lt5') : m < 60 ? T('main.aboutMin', { n: Math.round(m / 5) * 5 }) : T('main.aboutH', { n: Math.floor(m / 60) }));
  const todoLine = (it) => {
    const link = (h, label) => `<a class="btn" href="${esc(h)}">${esc(label)}</a>`;
    const plan = it.plan ? planTitle(it.plan) : '';
    switch (it.kind) {
      case 'design': return { badge: it.s, text: T('main.todo.design', { s: it.s }), why: `${T('main.todo.whyDesign')} · ${plan}`, act: link(threadHref(it), T('main.reply')) };
      case 'reply': return { badge: it.s, text: T('main.todo.reply', { s: it.s }), why: `${T('main.todo.whyReply')} · ${plan}`, act: link(threadHref(it), T('main.reply')) };
      case 'permission': { const p = it.perm; const why = p && p.network ? `${T('main.asksNet')} · ${p.network}` : p && p.tool ? `${T('main.asksTool')} ${p.tool}` : T('main.asksPerm');
        return { badge: it.s, text: T('main.todo.permission', { s: it.s }), why: `${why} · ${plan}`, act: p ? `<button type="button" class="btn" data-allow="${esc(it.plan)}/${esc(it.s)}/${esc(p.id)}">${esc(T('main.allow'))}</button>` : link(threadHref(it), T('main.open')) }; }
      case 'merge': { const c = mergeNotes.get(`${it.plan}/${it.s}`); // the refused merge stays said on its line (ATOI, 6 November)
        const note = c ? (c.files && c.files.length ? `${T('main.todo.mergeConflict', { files: c.files.join(', ') })}. ${T('main.todo.mergePath')}` : c.error) : '';
        return { badge: it.s, text: T('main.todo.merge', { s: it.s }), why: `${T('main.todo.whyMerge')} · ${plan}`, note, act: `<button type="button" class="btn" data-merge="${esc(it.plan)}/${esc(it.s)}">${esc(T('main.merge'))}</button>` }; }
      case 'launch': return { badge: '▶', text: T('flow.end.launch', { title: it.next.title }), why: `${T('flow.end.click')} · ${plan}`, act: link(href('/plan/' + encodeURIComponent(it.next.id)), T('main.open')) };
      case 'qa': return { badge: '✓', text: T('next.why.qaReady'), why: T('main.todo.whyQa', { n: it.plans || 0 }), act: `<button type="button" class="btn" data-start-qa>${esc(T('next.btn.startQa'))}</button>` };
      case 'guard': return { badge: it.s || '!', text: T('main.todo.guard', { s: it.s || '' }), why: T('main.todo.whyGuard'), act: link(href('/review/' + encodeURIComponent(it.id)), T('main.open')) };
      case 'review': return { badge: it.s || '…', text: T('main.todo.review', { s: it.s || '' }), why: `${T('main.todo.whyReview')} · ${minutes(it.minutes || 0)}`, act: link(href('/review/' + encodeURIComponent(it.id)), T('main.open')) };
      // Abandonner: the planning stops (POST /api/escadrille/:id/stop, status stopped) and leaves « À toi » at once
      case 'planning': return { badge: '?', text: T('main.todo.planning'), why: `${T('main.todo.whyPlanning')} · ${it.title}`, act: `<span class="mc-acts"><button type="button" class="btn ghost" data-abandon="${esc(it.id)}">${esc(T('main.abandon'))}</button>${link(href('/e/' + encodeURIComponent(it.id)), T('main.reply'))}</span>` };
      case 'proposal': return { badge: '▶', text: T('main.todo.proposal'), why: `${T('main.todo.whyProposal')} · ${it.title}`, act: `<button type="button" class="btn" data-goto="mc-${esc(String(it.seq))}">${esc(T('main.todo.see'))}</button>` };
      case 'install': return { badge: '⌘', text: T('main.todo.install'), why: T('main.todo.whyInstall'), act: `<button type="button" class="btn" data-install>${esc(T('main.todo.installBtn'))}</button>` };
      // the team (docs/team.md): a colleague's session touches what ours touches; the detail (every file) is in the session's thread
      case 'team': return { badge: it.s, text: T('main.todo.team', { member: it.member, file: it.file }), why: `${T('main.todo.whyTeam', { title: it.title })} · ${plan}`, act: link(threadHref(it), T('main.open')) };
      // the Linear sync (docs/connectors.md) could not update a ticket today: the key or the ticket, in Accès; one line a day at most
      case 'linear': return { badge: 'L', text: T('main.todo.linear'), why: `${T('main.todo.whyLinear')} · ${it.text}`, act: link(href('/#acces-extensions'), T('main.open')) };
      // a fix left to apply by hand (lib/leftfixes.mjs): the session's thread when a session left it, else the pilot's view
      case 'fix': return { badge: it.s || '⚑', text: T('main.todo.fix'), why: `${T('main.todo.whyFix')} · ${it.file}${plan ? ' · ' + plan : ''}`, act: link(it.s ? threadHref(it) : href('/#pilote'), T('main.open')) };
      default: return null;
    }
  };
  const pilotPresent = () => !!(pilot && (pilot.present || pilot.on));
  const waiting = () => {
    const nodes = flow ? flow.nodes : [];
    const proposals = ((st && st.messages) || []).filter((m) => m.role === 'claude' && m.data && m.data.proposal && m.data.proposal.status === 'proposed').map((m) => ({ seq: m.seq, title: m.data.proposal.title }));
    const install = !!(window.escadrilleApp && window.escadrilleApp.offered && window.escadrilleApp.offered());
    const list = window.escadrilleTodo ? window.escadrilleTodo.items({ nodes, ends: flow ? flow.ends || [] : [], qa: flow ? flow.qa || null : null, perms, escs: escs || [], reviews: reviews || [], proposals, pilot: pilotPresent(), install, team: teamInfo && teamInfo.on ? teamInfo.collisions || [] : [], linear: flow ? flow.linear || null : null, fixes: flow ? flow.fixes || [] : [], withKept: true }) : [];
    const pl = pilotLine();
    return (pl ? [pl] : []).concat(list.map((it) => { const l = todoLine(it); return l && { ...l, kept: !!it.kept }; }).filter(Boolean));
  };
  // the developer's lines and the pilot's (folded), from the same list: the title's « n t'attend » is the length of the
  // first, so the figure and the list never disagree (6 Nov.: « 0 t'attend » over nine waiting sessions)
  const counts = () => { if (!flow && !reviews && !escs) return null; const all = waiting(); return { mine: all.filter((x) => !x.kept).length, kept: all.filter((x) => x.kept).length }; };
  // the sharing is on: one grey line, always visible while it is (docs/team.md: the developer sees it at all times)
  const teamHtml = () => (teamInfo && teamInfo.on ? `<p class="await-none team-on">${esc(T('main.teamOn', { member: teamInfo.member || '', line: (teamInfo.status && teamInfo.status.line) || '' }))}</p>` : '');
  // the plannings with no answer for more than 12 h (stale, lib/waiting.mjs) leave the list for one folded line
  // « n anciennes » that shows them on a click; nothing is deleted, an answer brings one back
  let oldOpen = false;
  document.addEventListener('toggle', (e) => { if (e.target && e.target.classList && e.target.classList.contains('await-old')) oldOpen = e.target.open; }, true);
  const lineHtml = (it) => `<div class="line${it.note ? ' has-note' : ''}"><span class="badge${it.n ? ' n' : ''}">${esc(it.badge)}</span><span class="t"${it.why ? ` data-tip="${esc(it.why)}"` : ''}><span class="do">${esc(it.text)}</span>${it.why ? `<span class="why">${esc(it.why)}</span>` : ''}${it.note ? `<span class="await-note" role="status">${esc(it.note)}</span>` : ''}</span>${it.act}</div>`;
  const olderHtml = () => { const old = (escs || []).filter((x) => x.status === 'waiting' && x.stale); if (!old.length) return '';
    const lines = old.map((e) => lineHtml({ badge: '?', text: T('main.planningOld', { when: window.T.dateTime(e.at) }), why: e.title || e.id, act: `<a class="btn" href="${esc(href('/e/' + encodeURIComponent(e.id)))}">${esc(T('main.open'))}</a>` })).join('');
    return `<details class="await-old"${oldOpen ? ' open' : ''}><summary data-tip="${esc(T('main.olderTitle'))}">${esc(T('main.oldPlannings', { n: old.length }))}</summary><div class="await">${lines}</div></details>`; };
  const waitingHtml = () => {
    if (!flow && !reviews && !escs) return '';
    const all = waiting(); const items = all.filter((x) => !x.kept); const kept = all.filter((x) => x.kept); const older = olderHtml() + keptHtml(kept);
    if (!items.length) return `<p class="await-none">${esc(T('main.nothingWaits'))}</p>${older}${teamHtml()}`;
    const shown = items.slice(0, 3); const rest = items.length - shown.length;
    return `<div class="await" aria-label="${esc(T('main.awaitAria'))}">${shown.map(lineHtml).join('')}${rest ? `<a class="await-more" href="${esc(href('/flow'))}">${esc(T('main.andMore', { n: rest }))}</a>` : ''}</div>${older}${teamHtml()}`;
  };
  // what the pilot keeps: one folded line « n gardés pour le pilote », its lines on a click (the same toggle memory)
  let keptOpen = false;
  document.addEventListener('toggle', (e) => { if (e.target && e.target.classList && e.target.classList.contains('await-kept')) keptOpen = e.target.open; }, true);
  const keptHtml = (kept) => (!kept.length ? '' : `<details class="await-old await-kept"${keptOpen ? ' open' : ''}><summary data-tip="${esc(T('main.keptTitle'))}">${esc(T('main.keptPilot', { n: kept.length }))}</summary><div class="await">${kept.map(lineHtml).join('')}</div></details>`);
  // the merge of a finished branch, from « À toi » (the same route as the plan's button); a conflict is said in the state line
  const merge = async (key, btn) => { const [plan, sid] = key.split('/'); btn.disabled = true; btn.textContent = T('main.merging');
    const r = await api(`/api/plan/${encodeURIComponent(plan)}/session/${encodeURIComponent(sid)}/merge`, {}).catch((e) => ({ error: e.message }));
    if (r.conflict || r.error) { mergeNotes.set(key, { files: r.conflict ? r.files || [] : [], error: r.error || '' }); render(); return; } mergeNotes.delete(key); loadWaiting(project); };
  // FIAB 7: the QA grouped by project starts on the developer's click only (POST /api/qa/start)
  const startQa = async (btn) => { btn.disabled = true; btn.textContent = T('main.sending');
    const r = await api('/api/qa/start', { project }).catch((e) => ({ error: e.message }));
    if (r.error) { btn.disabled = false; btn.textContent = T('next.btn.startQa'); document.getElementById('state').textContent = r.error; return; } loadWaiting(project); };
  const allow = async (key, btn) => { const [plan, sid, id] = key.split('/'); btn.disabled = true; btn.textContent = T('main.sending');
    const r = await api(`/api/plan/${encodeURIComponent(plan)}/session/${encodeURIComponent(sid)}/answer`, { id, allow: true, always: false }).catch((e) => ({ error: e.message }));
    if (r.error) { btn.disabled = false; btn.textContent = T('main.allow'); document.getElementById('state').textContent = r.error; return; } loadWaiting(project); };

  // ---- the status beside the thread (ux.md §8, the mock-up; GET /api/status, lib/status.mjs): can I launch work right now?
  // Four blocks, a column of 14 px lines, no cells, no card: Maintenant (one line of figures; the sessions in a card that
  // floats over the panel on hover or focus, never pushing it: Dev, 2026-11-02 02:15), Claude (the limits, one line and
  // a 6 px bar each; « non mesuré » as one grey line, never a figure; no cost: Dev, 2026-11-02), Garde (one folded line), À toi (what waits for the developer, at the foot under a rule: Dev, 02:15). Under
  // 1100 px the panel is one line that opens the same blocks in a sheet (dialog). Polled every 30 s while the page
  // shows, and on the project's stream.
  let status = null; let statusTimer = null;
  const allowedHere = new Set(); // hosts allowed for the project from a card, hidden before the next status lands
  const loadStatus = async (p) => { const r = await api('/api/status?project=' + encodeURIComponent(p)).catch(() => null); if (!r || r.error || p !== project) return; const was = JSON.stringify(status); status = r; if (JSON.stringify(r) !== was && is()) render(); };
  const usd = (x, d) => (x == null || !Number.isFinite(x) ? '—' : window.T.usd(x, d));
  const pct = (x) => (x == null ? '—' : window.T.num(x, { maximumFractionDigits: x < 10 ? 1 : 0 }) + '\u202f%');
  const resetIn = (iso) => { if (!iso) return ''; const ms = Date.parse(iso) - Date.now(); if (!Number.isFinite(ms)) return ''; if (ms <= 0) return T('main.resetSoon'); const m = Math.round(ms / 6e4); if (m < 60) return T('main.resetMin', { n: m }); const h = Math.round(ms / 36e5); if (h < 48) return T('main.resetH', { n: h }); return T('main.resetD', { n: Math.round(h / 24) }); };
  const MODES = new Proxy({}, { get: (o, k) => (['surveille', 'guide', 'autonome'].includes(k) ? [T('mode.' + k), T('mode.' + k + 'Line')] : undefined) }); // i18n-ok: the mode ids
  const skel = '<i class="skel"></i>';
  const num = (v) => `<b class="num">${v}</b>`;
  // the figures of « Maintenant », one line: `2 en cours · 1 t'attend · 3 à venir` (also the state sentence under the title)
  // « t'attend » and « pour le pilote » are the lengths of « À toi » and of its folded line once the list is read
  const waitN = (n) => { const c = counts(); return c ? c.mine : n ? n.waiting : null; };
  const figures = (n) => { const c = counts(); const kept = c ? c.kept : n ? n.pilot : 0; const w = waitN(n);
    return `${num(n ? n.running : skel)} ${esc(T('main.running'))} · ${num(w == null ? skel : w)} ${esc(T('main.waiting'))} · ${num(n ? n.queued : skel)} ${esc(T('main.queued'))}${n && kept ? ` · ${num(kept)} ${esc(T('main.forPilot'))}` : ''}`; };
  const limName = (r) => (r.kind === 'model' ? T('lim.model', { name: r.label }) : r.kind === 'plan' ? T('lim.planOf', { name: r.label }) : T('lim.' + r.kind));
  const ACCOUNT = ['weekly', 'model', 'fiveHour']; // the account's limits (Claude) only: the caps Escadrille sets itself (a plan, a burst) stay on the Flot (Dev, 2026-11-02)
  const statusAside = (s = status) => {
    const open = `<aside class="status" aria-label="${esc(T('main.statusAria'))}">`;
    if (!s) return `${open}<section class="now"><h2>${esc(T('main.now'))}</h2><p class="figs">${figures(null)}</p></section>
      <section><h2>${esc(T('main.claude'))}</h2><p class="nm">${skel}</p></section></aside>`;
    // 1. Maintenant: the figures; on hover or focus, one row per session (letter, name, cost / cap, a 2 px bar at the
    // true share), the queued ones muted with what they wait for, five rows then « et n autres · Flot »
    const n = s.now; const later = (r) => r.status === 'todo' || r.status === 'later';
    const rowState = (r) => { if (later(r)) return `<span class="c">${esc(r.after && r.after.length ? T('main.laterAfter', { s: r.after.join(', ') }) : T('main.later'))}</span>`;
      const k = r.status === 'error' ? 'main.inError' : r.waitingFor === 'dev' ? 'main.waitsAnswer' : r.waitingFor === 'permission' ? 'main.asksPerm' : r.waitingFor === 'review' ? 'main.toReview' : r.waitingFor === 'pilot' || r.status === 'waiting' ? 'main.waiting' : null;
      return k ? `<span class="c wait">${esc(T(k))}</span>` : `<span class="c num">${usd(r.cost, 2)} / ${usd(r.budget, 0)}</span>`; };
    const track = (r) => (!later(r) && r.budget > 0 ? `<span class="track" aria-hidden="true"><i style="width:${Math.max(0, Math.min(100, Math.round(r.cost / r.budget * 100)))}%"></i></span>` : '');
    const rows = n.rows.map((r) => `<a class="row${later(r) ? ' later' : ''}" href="${esc(href(`/plan/${encodeURIComponent(r.plan)}?node=${encodeURIComponent(r.session)}`))}"><span class="badge">${esc(r.session)}</span><span class="n">${esc(r.name)}</span>${rowState(r)}${track(r)}</a>`).join('');
    const total = n.running + n.waiting + n.queued + (n.errors || 0);
    const now = `<section class="now"><h2>${esc(T('main.now'))}</h2>${total ? `<p class="figs" tabindex="0" aria-describedby="mcNowRows">${figures(n)}</p>${rows ? `<div class="rows" id="mcNowRows">${rows}${n.more ? `<a class="more" href="${esc(href('/flow'))}">${esc(T('main.moreFlow', { n: n.more }))}</a>` : ''}</div>` : ''}` : `<p class="nm">${esc(T('main.nothingRuns'))}</p>`}</section>`;
    // 2. Claude: every limit of the account that can stop the work (lib/limits.mjs), one line and one bar each, the
    // closest to its threshold at the head; the soft and hard thresholds drawn on the bar; a crossed threshold says what
    // it does above the lines. What is not measured is one grey line, with no bar and no figure.
    const c = s.claude; const L = s.limits || { rows: [], verdict: { level: 'ok' } };
    const limWhen = (r) => (r.kind === 'burst' ? (r.resetsAt ? T('lim.ends', { t: hm(r.resetsAt) }) : '') : r.kind === 'plan' ? T('main.ofCap', { a: usd(r.usd, 2), b: usd(r.capUsd, 0) }) : resetIn(r.resetsAt));
    const tick = (v, k) => (v == null ? '' : `<s class="th ${k}" style="left:${Math.min(100, v)}%" data-tip="${esc(T('lim.' + k + 'At', { pct: pct(v) }))}"></s>`);
    const limRow = (r) => {
      const lead = r.lead && r.margin != null ? `<div class="lead-note">${esc(r.margin > 0 ? T('lim.marginLeft', { n: window.T.num(r.margin, { maximumFractionDigits: 1 }) }) : T(r.level === 'hard' ? 'lim.aboveHard' : 'lim.aboveSoft'))}</div>` : '';
      return `<li class="lim ${esc(r.level)}"><div class="line"><b>${esc(limName(r))} <span class="num">${esc(pct(r.pct))}</span></b><span class="m">${esc(limWhen(r))}</span></div><div class="track" role="img" aria-label="${esc(limName(r) + ' ' + pct(r.pct))}"><i style="width:${Math.max(0, Math.min(100, r.pct))}%"></i>${tick(r.soft, 'soft')}${tick(r.hard, 'hard')}</div>${lead}</li>`;
    };
    // the project's share of the week (phase 11 PS): used / share, the bar at the scale of the share, its 90 % drawn;
    // not measured (no calibration, no reset read): one grey line, no figure
    const sh = L.rows.find((r) => r.kind === 'share');
    // The sentence says it in plain words; hover or keyboard focus says what counts and what does not (the floating tip
    // of ux.js: Esc closes it, nothing shifts)
    const shareSay = (k, a, b) => `<p class="lim-say" tabindex="0" data-tip="${esc(T('lim.shareTip'))}">${T(k, { a: `<b class="num">${esc(a)}</b>`, b: `<b class="num">${esc(b)}</b>` })}</p>`;
    const shareLi = !sh ? '' : sh.pct == null ? `<li class="lim unmeasured">${shareSay('lim.shareSayNone', '', pct(sh.maxPct))}</li>`
      : (() => { const of = T('lim.shareSay', { a: pct(sh.pct), b: pct(sh.maxPct) }); const w = (x) => Math.max(0, Math.min(100, x / sh.maxPct * 100));
        const lead = sh.level !== 'ok' ? `<div class="lead-note">${esc(T(sh.level === 'hard' ? 'lim.aboveHard' : 'lim.aboveSoft'))}</div>` : '';
        return `<li class="lim ${esc(sh.level)}">${shareSay('lim.shareSay', pct(sh.pct), pct(sh.maxPct))}<div class="track" role="img" aria-label="${esc(of)}"><i style="width:${w(sh.pct)}%"></i><s class="th soft" style="left:${w(sh.soft)}%" data-tip="${esc(T('lim.softAt', { pct: pct(sh.soft) }))}"></s><s class="th hard" style="left:100%" data-tip="${esc(T('lim.hardAt', { pct: pct(sh.hard) }))}"></s></div><div class="lead-note">${esc(resetIn(sh.resetsAt))}</div>${lead}</li>`; })();
    const v = L.verdict || { level: 'ok' };
    const alert = v.level !== 'ok' && v.line ? `<p class="lim-alert ${esc(v.level)}" role="status">${esc(v.line)} · ${esc(T(v.level === 'hard' ? 'lim.hardDoes' : 'lim.softDoes'))}</p>` : '';
    const at = c.measuredAt || (c.weekly && c.weekly.at); const when = at ? T(c.measuredAt ? 'main.measured' : 'main.measuredBy', { t: hm(at) }) : '';
    const measured = L.rows.filter((r) => r.pct != null && ACCOUNT.includes(r.kind)); const unmeasured = L.rows.filter((r) => r.pct == null && ACCOUNT.includes(r.kind) && r.kind !== 'fiveHour'); // Ultra has no 5 h window: never a line for it
    const none = !measured.length ? `<p class="nm">${esc(T('main.weeklyNone'))}</p>` : unmeasured.length ? `<p class="nm">${esc(T('main.notMeasured', { n: unmeasured.length, what: unmeasured.map(limName).join(', ') }))}</p>` : '';
    const acct = c.account && (c.account.plan || c.account.masked) ? [c.account.plan ? esc(c.account.plan) : '', c.account.masked ? `<span${c.account.email ? ` data-tip="${esc(c.account.email)}"` : ''}>${esc(c.account.masked)}</span>` : ''].filter(Boolean) : [];
    const claude = `<section><h2>${esc(T('main.claude'))}</h2>${alert}${measured.length || shareLi ? `<ol class="limits">${measured.map(limRow).join('')}${shareLi}</ol>` : ''}${none}
      <p class="nm">${[...acct, esc(c.measuring ? T('main.measuring') : c.stale && when ? T('main.stale', { when }) : when || T('main.noSession')), `<a href="${esc(href('/#acces-lim'))}">${esc(T('lim.setThresholds'))}</a>`].join(' · ')}</p></section>`;
    // 3. Garde, folded in one line (no cost on the home: Dev, 2026-11-02; the cost lives on the Flot and in Accès)
    const g = s.guard; const [mode, modeLine] = MODES[g.mode] || MODES.surveille;
    const burstLine = g.burst ? `${esc(T('main.burstOn'))} · <span class="num">${esc(T('main.ofCap', { a: usd(g.burst.spentUsd, 2), b: usd(g.burst.capUsd, 0) }))}</span> · <a href="${esc(href('/#rafale'))}">${esc(T('main.stop'))}</a>` : `${esc(T('main.burstOff'))} · <a href="${esc(href('/#rafale'))}">${esc(T('nav.burst'))}</a>`; // i18n-ok
    const guard = `<section><details class="guard"><summary><b>${mode}</b> · ${esc(g.network.length ? T('main.domains', { n: g.network.length }) : T('main.noNet'))}${g.burst ? ' · ' + esc(T('main.burstRunning')) : ''}</summary><div class="b"><div>${esc(modeLine)} · <a href="${esc(href('/#acces'))}">${esc(T('nav.access'))}</a></div><div>${esc(g.network.length ? T('main.planDomains', { list: g.network.join(', ') }) : T('main.noDomain'))}</div><div>${burstLine}</div><div>${esc(T(g.autoMerge ? 'main.autoMergeGreen' : 'main.autoMergeHand'))}</div></div></details></section>`;
    // 4. À toi: what waits for the developer, at the foot of the column under a rule (Dev, 2026-11-02 02:15), one line
    // and one button each; « Rien ne t'attend. » otherwise
    const wait = waitingHtml();
    const toYou = `<section class="side-wait"><h2>${esc(T('main.toYou'))}</h2>${wait || `<p class="nm">${skel}</p>`}</section>`;
    // 5. Retirés, folded by default (docs/flot.md, « Retirer un plan »)
    const retired = flow && flow.retired && flow.retired.length && window.escadrilleRetire ? `<section>${window.escadrilleRetire.sectionHtml(flow.retired)}</section>` : '';
    return `${open}${now}${claude}${guard}${retired}${toYou}</aside>`;
  };
  // the one line under 1100 px (`2 en cours · 1 t'attend · quota 31 % ›`), and the sheet it opens
  const statusLine = () => { const s = status; if (!s) return `<button type="button" class="status-line" id="mcStatusLine" aria-haspopup="dialog" aria-controls="mcStatus" disabled>${skel} ${esc(T('main.running'))} · ${skel} ${esc(T('main.waiting'))}</button>`;
    const lead = (s.limits && s.limits.rows || []).find((r) => r.pct != null && ACCOUNT.includes(r.kind)); // the rows come closest-first
    const quota = lead ? ` · ${esc(lead.kind === 'weekly' ? T('main.lineQuota') : limName(lead))} <b>${esc(pct(lead.pct))}</b>` : '';
    return `<button type="button" class="status-line" id="mcStatusLine" aria-haspopup="dialog" aria-controls="mcStatus"><b>${s.now.running}</b> ${esc(T('main.running'))} · <b>${waitN(s.now)}</b> ${esc(T('main.waiting'))}${quota}</button>
      <dialog class="status-sheet" id="mcStatus" aria-label="${esc(T('main.status'))}"><div class="status-sheet-head"><h2>${esc(T('main.status'))}</h2><button type="button" class="btn" data-close-status>${esc(T('main.close'))}</button></div>${statusAside()}</dialog>`; };
  const nowHtml = () => statusAside() + statusLine();

  // ---- the thread
  const sourceLabel = (m) => { const s = m.source || ''; if (s === 'page') return T('main.srcPage'); if (s.startsWith('claude-code:')) { const ep = m.data && m.data.entrypoint; return (ep === 'sdk-cli' ? 'claude -p' : 'Claude Code') + ' · ' + s.slice(12, 20); } if (s.startsWith('pilot:')) return T('nav.pilot'); return ''; };
  const mark = (html) => { const q = query.trim(); if (!q) return html; const re = new RegExp('(' + q.replace(/[.*+?^${}()|[\]\\]/g, '\\$&') + ')', 'gi'); return html.replace(/(^|>)([^<]+)/g, (all, a, t) => a + t.replace(re, '<mark>$1</mark>')); };
  // ---- the card « Plan proposé » (data.proposal): one action, « Lancer »; « Voir le flot · Modifier » on one line
  const modelShort = (id) => String(id || '').replace(/^claude-/, '').replace(/-(\d+)-(\d+)$/, ' $1.$2').replace(/^./, (c) => c.toUpperCase());
  const money = (x) => (x == null ? '–' : window.T.usd(x, 2));
  // A plan's live sessions and spent cost, from the flow: what the confirmation of « Retirer le plan » says
  const planLive = (id) => { const ns = (flow ? flow.nodes : []).filter((n) => n.plan === id); return { running: ns.filter((n) => n.status === 'running' || n.status === 'waiting').map((n) => n.session), cost: ns.reduce((a, n) => a + (n.cost || 0), 0) }; };
  const isRetiredId = (id) => !!(flow && (flow.retired || []).some((r) => r.id === id));
  const cardHtml = (m) => {
    const p = m.data && m.data.proposal; if (!p) return '';
    if (isRetiredId(p.planId)) return ''; // a retired plan leaves the home for « Retirés »
    const menu = `<details class="rt-menu"><summary aria-label="${esc(T('retire.menu'))}">⋯</summary><div class="rt-pop"><button type="button" class="card-link" data-retire="${esc(p.planId)}" data-title="${esc(p.title)}">${esc(T('retire.button'))}</button></div></details>`;
    const h = href(`/plan/${encodeURIComponent(p.planId)}`);
    const cost = p.estimate && (p.estimate.cost ?? p.estimate.budget); const net = p.network && p.network.length ? p.network.join(', ') : T('main.noDomainCard');
    // what the plan announces and the project's list does not open yet: one line, one button per host
    const open = new Set(status && status.guard ? status.guard.network : []);
    const missing = p.status === 'proposed' ? (p.missing || []).filter((h) => !open.has(h) && !allowedHere.has(h)) : [];
    const missLine = missing.length ? `<p class="mc-card-net"><span class="t-warn">${esc(T('main.missingDomains', { list: missing.join(', ') }))}</span> · ${missing.map((h) => `<button type="button" class="card-link" data-allow-host="${esc(h)}">${esc(T('main.allowProject'))}${missing.length > 1 ? ' · ' + esc(h) : ''}</button>`).join(' ')}</p>` : '';
    const rows = p.sessions.map((s) => `<li><b>${esc(s.id)}</b><span class="mc-card-name">${esc(s.name || '')}</span><span class="mc-card-num">${esc(modelShort(s.model))} · ${money(s.budget)}</span></li>`).join('');
    const act = p.status === 'proposed'
      ? `<button type="button" class="btn primary" data-accept="${m.seq}">${esc(T('main.launch'))}</button><span class="mc-card-more"><a href="${esc(h)}">${esc(T('main.seeFlow'))}</a> · <button type="button" class="card-link" data-edit="${m.seq}">${esc(T('main.edit'))}</button></span>`
      : `<span class="mc-card-state">${esc(T(p.status === 'launched' ? 'main.launched' : 'main.replaced'))}</span><span class="mc-card-more"><a href="${esc(h)}">${esc(T('main.seeFlow'))}</a></span>`;
    const fold = p.sessions.length > 5; // five rows show whole; beyond, four then « + n sessions »
    return `<section class="mc-card ${esc(p.status)}" aria-label="${esc(T('main.cardAria', { title: p.title }))}"><div class="rt-head"><h3>${esc(p.title)}</h3>${menu}</div><ul class="${fold ? 'folded' : ''}">${rows}</ul>${fold ? `<button type="button" class="card-link mc-card-fold" data-unfold>${esc(T('main.moreSessions', { n: p.sessions.length - 4 }))}</button>` : ''}
      <p class="mc-card-sum">≈ ${money(cost)}${p.estimate && p.estimate.cost == null ? ' ' + esc(T('main.budgets')) : ''} · ${esc(T('main.sessionsN', { n: p.sessions.length }))}${p.waves > 1 ? esc(T('main.waves', { n: p.waves })) : ''} · ${esc(net)}</p>${missLine}
      <div class="mc-card-act">${act}</div></section>`;
  };
  const accept = async (seq, btn) => { btn.disabled = true; btn.textContent = T('main.launching'); const r = await api('/api/main/accept', { project, seq: Number(seq) }).catch((e) => ({ error: e.message })); if (r.error) { btn.disabled = false; btn.textContent = T('main.launch'); document.getElementById('state').textContent = r.error; return; } load(); };
  // a card already says « Voir le flot »: no second link to the plan
  const links = (m) => { const l = (m.data && Array.isArray(m.data.links) ? m.data.links : []).filter((x) => !(m.data.proposal && x.kind === 'plan')); return l.length ? `<p class="mc-links">${l.map((x) => `<a href="${esc(x.href)}">${esc(x.label)}</a>`).join('')}</p>` : ''; };
  const msgHtml = (m, waiting) => {
    if (m.role === 'system') return `<p class="mc-sys" id="mc-${m.seq}">${esc(m.text)}${m.link ? ` · <a href="${esc(m.link.href)}">${esc(m.link.label)}</a>` : ''} <time datetime="${esc(m.at)}">${hm(m.at)}</time></p>`;
    const long = m.text.length > LONG;
    return `<article class="mc-msg ${m.role === 'dev' ? 'dev' : 'claude'}" id="mc-${m.seq}" data-jk tabindex="-1" aria-label="${esc(m.role === 'dev' ? T('main.you') : 'Claude')}, ${hm(m.at)}">
      <div class="mc-text ${long ? 'clamped' : ''}">${mark(rich(m.text))}</div>
      ${long ? `<button type="button" class="card-link mc-more" data-more="${m.seq}">${esc(T('main.readAll', { n: Math.round(m.text.length / 1000) }))}</button>` : ''}
      ${cardHtml(m)}${links(m)}
      <p class="mc-meta"><time datetime="${esc(m.at)}" data-tip="${esc(window.T.dateTime(m.at))}">${hm(m.at)}</time>${waiting ? ` · <span class="mc-wait">${esc(T('main.waitsPilot'))}</span>` : ''}</p></article>`;
  };
  // The plannings of the project, as system lines in the thread (GET /api/escadrilles): « Planification lancée » at its
  // creation, « Plan écrit » when its plan exists; only within the loaded window of messages
  const planningLines = (list) => { if (!escs || !escs.length) return [];
    const from = st.more && list[0] ? list[0].at : null; const out = [];
    for (const e of escs) { if (e.project !== project) continue; const t = e.title || e.id;
      if (!from || e.created >= from) out.push({ seq: 'e-' + e.id, role: 'system', at: e.created, text: T('main.planningStarted', { t }), link: { label: T('main.open'), href: href('/e/' + encodeURIComponent(e.id)) } });
      if (e.plan_id && (!from || e.at >= from) && e.at !== e.created) out.push({ seq: 'p-' + e.id, role: 'system', at: e.at, text: T('main.planWritten', { t }), link: { label: T('main.openPlan'), href: href('/plan/' + encodeURIComponent(e.plan_id)) } }); }
    return out; };
  const threadHtml = (list, { pending = true, plannings = false } = {}) => {
    const lastClaude = list.reduce((k, m, i) => (m.role === 'claude' ? i : k), -1);
    let out = ''; let d = null; let src = null;
    // Claude's answers that follow one another, same source, same day, read as one block
    const runs = []; list.forEach((m, i) => { const prev = runs[runs.length - 1];
      if (prev && m.role === 'claude' && prev.role === 'claude' && prev.source === m.source && day(prev.at) === day(m.at) && !(prev.data && (prev.data.links || prev.data.proposal)) && !(m.data && (m.data.links || m.data.proposal))) { prev.text += '\n\n' + m.text; prev.at = m.at; return; }
      runs.push({ ...m, i }); });
    if (plannings) { runs.push(...planningLines(list)); runs.sort((a, b) => (a.at < b.at ? -1 : a.at > b.at ? 1 : 0)); }
    runs.forEach((m) => {
      const dd = day(m.at); if (dd !== d) { out += `<h2 class="mc-day">${esc(dd.charAt(0).toUpperCase() + dd.slice(1))}</h2>`; d = dd; src = null; }
      if (m.role === 'system') { out += msgHtml(m); return; }
      const s = sourceLabel(m); if (s !== src) { if (s) out += `<p class="mc-src">${esc(s)}</p>`; src = s; }
      out += msgHtml(m, pending && m.role === 'dev' && m.i > lastClaude && m.source === 'page');
    });
    return out;
  };

  // ---- the folded line under the composer: the model, a template, the import
  const models = () => (meta && Array.isArray(meta.models) ? meta.models : []);
  const modelId = () => { const ids = models().map((m) => m.id); const want = localStorage.getItem('escadrille.model') || (settings && settings.model) || ids[0]; return ids.includes(want) ? want : ids[0]; };
  const modelName = (id) => { const m = models().find((x) => x.id === id); return m ? m.name : id || T('main.model'); };
  const modelHtml = () => { const cur = modelId(); const list = models(); if (!list.length) return '';
    return `<details class="mc-under" id="mcModel"><summary data-tip="${esc(T('main.modelTitle'))}">${esc(modelName(cur))}</summary><div class="mc-under-body"><label class="field"><span>${esc(T('main.modelLabel'))}</span><select class="control" id="mcModelSel">${list.map((m) => `<option value="${esc(m.id)}" ${m.id === cur ? 'selected' : ''}>${esc(m.name)}</option>`).join('')}</select></label></div></details>`; };
  const fileRow = (f) => { const kind = T(f.entrypoint === 'cli' ? 'main.kindConv' : f.entrypoint === 'sdk-cli' ? 'main.kindPlanning' : 'main.kindSession');
    const when = f.firstAt || f.at; const busy = importing === f.path;
    return `<li class="mc-file"><div class="mc-file-main"><span class="mc-file-first" data-tip="${esc(f.first || '')}">${esc(f.first || T('main.noMessage'))}</span>
      <span class="mc-file-sub">${esc(window.T.dateTime(when))} · ${size(f.size)} · ${kind} · <span data-tip="${esc(f.path)}">${esc(f.name.slice(0, 8))}</span></span></div>
      <span class="mc-file-state">${f.imported ? esc(T('main.msgs', { n: f.imported })) : '–'}</span>
      <button type="button" class="btn" data-import="${esc(f.path)}" ${busy ? 'disabled' : ''}>${esc(T(busy ? 'main.importing' : f.imported ? 'main.update' : 'main.import'))}</button></li>`; };
  const importHtml = () => {
    const n = files && files.files ? files.files.length : null; const todo = n !== null ? files.files.filter((f) => !f.imported).length : null;
    const sum = n === null ? T('main.importSum') : T('main.importSumN', { n }) + (todo ? T('main.toImport', { n: todo }) : T('main.allImported'));
    const body = !files ? `<p class="mc-note">${esc(T('main.readingDir'))}</p>` : files.error ? `<p class="mc-note">${esc(files.error)}</p>` : !files.files.length ? `<p class="mc-note">${esc(T('main.noConv', { dir: '\u0001' })).replace('\u0001', `<code>${esc(files.dir)}</code>`)}</p>`
      : `<p class="mc-note">${esc(T('main.importNote'))}${note ? ' <b role="status">' + esc(note) + '</b>' : ''}</p><ol class="mc-files">${files.files.map(fileRow).join('')}</ol>`;
    return `<details class="mc-under mc-import" id="mcImport" ${filesOpen ? 'open' : ''}><summary data-jk>${esc(sum)}</summary><div class="mc-under-body">${body}</div></details>`;
  };
  // ---- the composer: Dicter and the Pilote switch on the left (the switch says its state: off, « Planifier lance une
  // planification »; on, « lit la Conversation », « lit… », « plafond du jour »), on the right the one primary button
  // that says what it does, « Planifier » (pilot off) or « Envoyer » (pilot on) (ux.md §8: nothing else tells)
  const pilotOn = () => !!(pilot && pilot.on);
  const primaryLabel = () => T(pilotOn() ? 'main.send' : 'main.plan');
  // while the first run's question waits (index.html), « Garder ce choix » is the screen's one primary action
  const whoAsks = () => !!(window.escadrilleWho && window.escadrilleWho());
  const pilotState = () => (pilotErr ? pilotErr : !pilotOn() ? T('main.pilotOffState') : pilot.busy ? T('pilot.reading') : pilot.spentToday >= pilot.daily ? T('pilot.dayCap') : T('main.pilotOnState'));
  const pilotSwitch = () => `<label class="mc-pilot" data-tip="${esc(pilot ? T('pilot.switchTitle', { spent: money(pilot.spentToday), daily: money(pilot.daily), budget: money(pilot.budget) }) : T('pilot.switchIdle'))}"><input type="checkbox" role="switch" id="mcPilot"${pilotOn() ? ' checked' : ''}><span class="mc-switch" aria-hidden="true"></span>${esc(T('pilot.title'))} <span class="mc-pilot-state" role="status">${esc(pilotState())}</span></label>`;
  const offerHtml = () => { if (!offer) return ''; const name = P.name(project) || '';
    const q = offer.key === 'autonomy' ? T('main.offer.mode', { name, mode: T('mode.' + offer.mode) }) : T(offer.on ? 'main.offer.burstOn' : 'main.offer.burstOff', { name });
    const b = offer.key === 'autonomy' ? T('main.offer.modeBtn', { mode: T('mode.' + offer.mode) }) : T(offer.on ? 'main.offer.burstOnBtn' : 'main.offer.burstOffBtn');
    return `<div class="mc-offer" role="status"><span class="t">${esc(q)}</span><button type="button" class="btn" data-offer>${esc(b)}</button><button type="button" class="linkish" data-offer-plan>${esc(T('main.offer.plan'))}</button></div>`; };
  const composer = (placeholder) => `<div class="composer">${offerHtml()}<div class="box"><textarea id="text" name="text" rows="3" data-sg data-sg-project="${esc(project || '')}" placeholder="${esc(placeholder)}" aria-label="${esc(T('main.msgAria'))}"></textarea><div class="interim" id="interim" aria-live="polite"></div><div class="bar"><button type="button" class="btn mic" id="mic" aria-pressed="false" aria-label="${esc(T('main.dictate'))}"><svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.5" aria-hidden="true"><rect x="5.5" y="1.5" width="5" height="8" rx="2.5"/><path d="M3 7.5a5 5 0 0 0 10 0M8 12.5v2M5.5 14.5h5"/></svg><span id="micLabel">${esc(T('main.dictate'))}</span></button>${pilotSwitch()}<span class="state" id="state"></span><button type="submit" class="btn${whoAsks() ? '' : ' primary'}" id="send">${esc(primaryLabel())}</button></div></div>
    <div class="under">${modelHtml()}${importHtml()}<span class="keys"><kbd>${esc(T('main.enter'))}</kbd> ${esc(T('main.sends'))}</span></div></div>`;

  // ---- an empty project: four starting points in the room of the thread (Dev, 2026-11-02), for a developer new to AI as
  // for a senior one: a title, a line of why, and a click that fills the composer with a ready request (nothing leaves
  // before Envoyer / Planifier). The plan templates (plans/templates) cover none of these four.
  const STARTS = ['rules', 'map', 'tests', 'autonomy']; // i18n-ok: the ids of main.start.*
  const startHtml = () => `<div class="mc-start" aria-label="${esc(T('main.startAria'))}">${STARTS.map((k) => `<button type="button" class="mc-start-item" data-start="${k}"><b>${esc(T('main.start.' + k))}</b><span>${esc(T('main.start.' + k + 'How'))}</span></button>`).join('')}</div>`;
  const start = (k) => { const ta = document.getElementById('text'); if (!ta || !STARTS.includes(k)) return; ta.value = T('main.start.' + k + 'Ask'); ta.focus(); ta.setSelectionRange(ta.value.length, ta.value.length); ta.dispatchEvent(new Event('input')); };

  // ---- the three states
  // No project: the projects of Escadrille (GET /api/projects, the registry of lib/projects.mjs, the same list as the
  // sidebar's picker), never every folder Claude Code knows; « Ajouter un projet… » takes a folder, validated by
  // POST /api/projects before the page opens it. Without any project yet, the folder field is the screen.
  const pickHtml = (list) => { const none = !list.length;
    return `<form class="mc-pick" id="mcPick" novalidate>${none ? '<input type="hidden" name="project" value="__other">' : `<select class="control" name="project" aria-label="${esc(T('main.projectAria'))}"><option value="" selected disabled>${esc(T('nav.pickFolder'))}</option>${list.map((p) => `<option value="${esc(p.path)}" title="${esc(p.path)}">${esc(p.name || String(p.path).split('/').filter(Boolean).pop())}</option>`).join('')}<option value="__other">${esc(T('nav.pp.add'))}</option></select>`}<input class="control" name="path" placeholder="${esc(T('nav.pp.pathPlaceholder'))}" aria-label="${esc(T('nav.pp.pathLabel'))}" aria-describedby="mcPickErr" autocomplete="off" spellcheck="false"${none ? '' : ' hidden'}><button type="submit" class="btn primary">${esc(T(none ? 'nav.pp.addSubmit' : 'main.open'))}</button><p class="mc-pick-err" id="mcPickErr" role="alert"></p></form>`; };
  const noProject = () => { const list = meta && Array.isArray(meta.projects) ? meta.projects : [];
    return `<div class="title-row"><div><h1>calmdev</h1><p class="sub">${esc(T(list.length ? 'main.pickProject' : 'main.addFirst'))}</p>${meta && meta.claude && meta.claude.found === false ? `<p class="sub mc-noclaude" role="status">${esc(T('main.noClaude'))} <code>${esc(meta.claude.command)}</code></p>` : ''}</div></div>
      ${pickHtml(list)}`; };
  const view = () => {
    if (!project) return noProject();
    const name = P.name(project) || T('main.thisProject');
    if (!st || st.project !== project) { flow = null; reviews = null; escs = null; status = null; load(); return `<div class="title-row"><div><h1>Conversation</h1><p class="sub">${esc(T('main.loading', { name }))}</p></div></div>`; }
    const empty = !st.messages.length && !(escs && escs.some((e) => e.project === project));
    // the state sentence under the title: `escadrille · 2 en cours · 1 t'attend · 24,10 $ aujourd'hui` (the mock-up);
    // an empty project says `escadrille · rien encore`; the search (240 px, `/`) at the right of the title
    const s = status; const sub = st.error ? esc(st.error) : empty ? esc(T('main.nothingYet', { name })) : `${esc(name)} · ${num(s ? s.now.running : skel)} ${esc(T('main.running'))} · ${num(s ? waitN(s.now) : skel)} ${esc(T('main.waiting'))}`;
    const search = empty || st.error ? '' : `<input class="control mc-search" id="mcSearch" type="search" placeholder="${esc(T('main.search'))}" aria-label="${esc(T('main.search'))}" value="${esc(query)}">`;
    const head = `<div class="title-row"><div><h1>Conversation</h1><p class="sub">${sub}</p></div>${search}</div>`;
    let body;
    if (results) body = results.messages.length ? `<p class="mc-count" role="status">${esc(T('main.results', { n: results.total }) + (results.total > results.messages.length ? T('main.latest', { n: results.messages.length }) : ''))}</p><div class="mc-thread" data-ui>${threadHtml(results.messages.slice().reverse(), { pending: false })}</div>` : `<p class="mc-count" role="status">${esc(T('main.noMatch'))}</p>`;
    // the first run's question (index.html, docs/first-run.md) stands in for the starters until it is answered: with the
    // starters under it the column is taller than the screen and its head is cut (captures of 6 November, 1440 and 390 px);
    // .mc-first centres safely all the same (mainchat.css)
    else if (empty) { const who = window.escadrilleWho ? window.escadrilleWho() : ''; body = `<div class="mc-empty">${who || `<p>${esc(T('main.empty'))}</p>${startHtml()}`}</div>`; }
    else body = `${st.more ? `<p class="mc-older"><button type="button" class="card-link" id="mcOlder">${esc(T('main.older'))}</button></p>` : ''}<div class="mc-thread" data-ui>${threadHtml(st.messages, { plannings: true })}</div>`;
    const stamp = document.getElementById('stamp'); if (stamp) { const last = st.messages[st.messages.length - 1]; stamp.textContent = last ? T('main.lastMsg', { t: hm(last.at) }) : ''; }
    // an empty project: the sentence, then the composer right under it and the composer at the foot of the column as on an active project (Dev, 2026-11-02)
    return `${head}<div class="mc-cols"><div class="mc-main${empty ? ' mc-first' : ''}"><div class="mc-scroll${empty ? ' mc-first' : ''}" id="mcScroll"><div class="mc-body" id="mcBody">${body}</div><div id="mainEnd"></div></div><form id="mainForm" class="mc-form">${composer(T(empty ? 'main.phIdea' : 'main.phAsk'))}</form></div>${nowHtml()}</div>`;
  };
  // the home fixes the page's height so the thread scrolls in its column (mainchat.css); the other views keep the page scroll
  const homeClass = () => { if (document.documentElement && document.documentElement.classList) document.documentElement.classList.toggle('mc-home', is() && !!project); };
  // every render rebuilds the column: the thread comes back where it was, at its end when it was there (or on a first
  // draw); done in a microtask, right after index.html has set the HTML, before any frame. On an empty project the
  // composer takes the focus once, on a keyboard screen only (a phone would open its keyboard over the page).
  // A draft survives every redraw (the status comes every 30 s and the stream redraws the column): the text, the caret
  // and the focus of the field come back as they were.
  let focused = false;
  const view0 = view; const viewHome = () => { homeClass(); const c = document.getElementById('mcScroll'); const top = c ? c.scrollTop : 0;
    const ta0 = document.getElementById('text'); const draft = ta0 && ta0.value ? { v: ta0.value, s: ta0.selectionStart, e: ta0.selectionEnd, f: document.activeElement === ta0 } : null;
    queueMicrotask(() => { const n = document.getElementById('mcScroll'); if (!n || n === c) return; grown.disconnect(); const b = document.getElementById('mcBody'); if (b) grown.observe(b); if (stick) toEnd(n); else n.scrollTop = top;
      const ta = document.getElementById('text'); if (!ta) return;
      if (draft && ta !== ta0) { ta.value = draft.v; if (draft.f) { ta.focus(); try { ta.setSelectionRange(draft.s, draft.e); } catch {} } ta.dispatchEvent(new Event('input')); return; }
      if (!focused && n.classList.contains('mc-first') && window.innerWidth > 860 && document.activeElement === document.body) { focused = true; ta.focus(); } });
    return view0(); };

  // ---- sending: pilot on → the pilot answers; pilot off → a planning starts with the text as the idea
  // a sentence that only names a setting is offered as that setting, never planned (forced: « Planifier quand même »)
  const send = async (forced) => {
    const ta = document.getElementById('text'); const text = ta.value.trim(); if (!text) return;
    const intent = !forced && !(pilot && pilot.on) && window.escadrilleSettingIntent ? window.escadrilleSettingIntent.detect(text, settings) : null;
    if (intent) { offer = intent; render(); return; }
    offer = null;
    const btn = document.getElementById('send'); btn.disabled = true; const state = document.getElementById('state');
    if (pilot && pilot.on) {
      const r = await api('/api/main', { project, text }).catch((e) => ({ error: e.message }));
      if (r.error) { state.textContent = r.error; btn.disabled = false; return; }
      ta.value = ''; query = ''; results = null; st.messages.push(r.message); st.total++; render(); bottom(); document.getElementById('state').textContent = T('main.pilotReads'); return;
    }
    const model = modelId(); state.textContent = T('main.planningStarts');
    const r = await api('/api/escadrille', { project, model, idea: text }).catch((e) => ({ error: e.message }));
    if (r.error) { state.textContent = r.error; btn.disabled = false; return; }
    if (model) localStorage.setItem('escadrille.model', model); ta.value = ''; query = ''; results = null;
    escs = [{ id: r.id, title: r.title || text.split('\n')[0].slice(0, 64), project, status: 'thinking', plan_id: null, created: new Date().toISOString(), at: new Date().toISOString() }, ...(escs || [])];
    render(); bottom(); loadWaiting(project);
  };
  const applyOffer = async (b) => {
    if (!offer) return; b.disabled = true; const o = offer;
    const r = await api('/api/project/settings', { project, ...o.body }).catch((e) => ({ error: e.message }));
    const state = document.getElementById('state');
    if (r.error) { b.disabled = false; if (state) state.textContent = r.error; return; }
    if (r.settings) settings = r.settings; offer = null; const ta = document.getElementById('text'); if (ta) ta.value = '';
    render(); const s2 = document.getElementById('state'); if (s2) s2.textContent = o.key === 'autonomy' ? T('main.offer.modeDone', { mode: T('mode.' + o.mode) }) : T(o.on ? 'main.offer.burstOnDone' : 'main.offer.burstOffDone');
  };
  const abandon = async (id, b) => {
    b.disabled = true;
    const r = await api(`/api/escadrille/${encodeURIComponent(id)}/stop`, {}).catch((e) => ({ error: e.message }));
    if (r.error) { b.disabled = false; return; }
    escs = (escs || []).map((e) => (e.id === id ? { ...e, status: 'stopped' } : e)); render(); loadWaiting(project);
  };
  const doImport = async (p) => {
    importing = p; render();
    const r = await api('/api/main/import', { project, path: p }).catch((e) => ({ error: e.message }));
    importing = null; note = r.error ? r.error : `${T('main.added', { n: r.added || 0 })}${r.updated ? T('main.updated', { n: r.updated }) : ''}${r.masked ? T('main.masked', { n: r.masked }) : ''}.`;
    await loadFiles(); await load();
  };
  // no project: the chosen folder becomes the current project, the page reloads on it (as the sidebar's picker does)
  const open = (p) => { try { localStorage.setItem('escadrille.project', p); } catch {} location.href = '/?project=' + encodeURIComponent(p); };
  const pick = async (form) => {
    const sel = form.querySelector('[name=project]'); if (sel.value !== '__other') { if (sel.value) open(sel.value); return; }
    const input = form.querySelector('[name=path]'); const err = form.querySelector('#mcPickErr');
    const r = await fetch('/api/projects', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ path: input.value.trim() }) }).then(async (x) => ({ ok: x.ok, body: await x.json().catch(() => ({})) })).catch((e) => ({ ok: false, body: { error: e.message } }));
    if (r.ok) { open(r.body.path); return; }
    const code = r.body && r.body.error; if (err) err.textContent = ['not-absolute', 'not-found', 'not-a-folder'].includes(code) ? T('nav.pp.err.' + code) : T('nav.pp.err.other', { why: code || '?' }); input.focus();
  };

  // capture: these run before index.html's own handlers, which would write to an escadrille
  document.addEventListener('submit', (e) => { if (e.target.id === 'mcPick') { e.preventDefault(); e.stopImmediatePropagation(); pick(e.target); return; } if (e.target.id !== 'mainForm') return; e.preventDefault(); e.stopImmediatePropagation(); send(); }, true);
  // Escape, the contract (ux.md §1): it closes what a click opened, the last first, and gives the focus back. Here: the
  // dictation stops; the search empties; a folded line of the home (the model, a template, the import, the guard, the
  // old plannings) closes and its summary takes the focus. The sheet at 390 is a dialog: Escape is native, the focus
  // comes back to the line on close (below). public/ux.js, when present, does the same for every screen: both are idempotent.
  const escapeHome = (e) => {
    const mic = document.getElementById('mic'); if (mic && mic.getAttribute('aria-pressed') === 'true') { mic.click(); return true; }
    const s = document.getElementById('mcSearch'); if (s && e.target === s) { if (!s.value) return false; query = ''; results = null; stick = true; render(); return true; }
    // the fold that holds the focus; else the last open fold of the home (a redraw after the click left the focus on body)
    const open = [...document.querySelectorAll('#canvas details[open]')]; const d = (e.target && e.target.closest && e.target.closest('#canvas details[open]')) || open[open.length - 1];
    if (d) { d.open = false; const sm = d.querySelector(':scope > summary'); if (sm) sm.focus(); return true; }
    return false;
  };
  document.addEventListener('keydown', (e) => { if (!is()) return;
    if (e.target.id === 'text' && e.key === 'Enter' && !e.shiftKey && !e.isComposing) { e.preventDefault(); e.stopImmediatePropagation(); send(); return; }
    if (e.metaKey || e.ctrlKey || e.altKey) return;
    if (e.key === 'Escape') { if (escapeHome(e)) e.preventDefault(); return; }
    const s = document.getElementById('mcSearch'); if (!s) return;
    if (e.key === '/' && !/^(INPUT|TEXTAREA|SELECT)$/.test(e.target.tagName)) { e.preventDefault(); s.focus(); s.select(); } }, true);
  // the sheet at 390: the focus comes back to the line that opened it, whatever closed it (Escape, Fermer)
  document.addEventListener('close', (e) => { if (!e.target || e.target.id !== 'mcStatus') return; if (window.escadrilleUX) window.escadrilleUX.close(e.target); const l = document.getElementById('mcStatusLine'); if (l) l.focus(); }, true);
  document.addEventListener('input', (e) => { if (e.target.id !== 'mcSearch') return; query = e.target.value; clearTimeout(timer); timer = setTimeout(async () => { stick = true; await search(); const s = document.getElementById('mcSearch'); s.focus(); s.setSelectionRange(s.value.length, s.value.length); }, 220); });
  document.addEventListener('change', (e) => { if (!is()) return;
    if (e.target.id === 'mcPilot') togglePilot(e.target.checked);
    else if (e.target.id === 'mcModelSel') { localStorage.setItem('escadrille.model', e.target.value); const s = document.querySelector('#mcModel > summary'); if (s) s.textContent = modelName(e.target.value); }
    else if (e.target.name === 'project' && e.target.closest('#mcPick')) { const f = e.target.form.querySelector('[name=path]'); f.hidden = e.target.value !== '__other'; if (!f.hidden) f.focus(); } });
  document.addEventListener('toggle', async (e) => { if (e.target.id === 'mcImport') { filesOpen = e.target.open; if (filesOpen && !files) loadFiles(); }
  }, true);
  document.addEventListener('click', (e) => { const t = e.target.closest('button'); if (!t || !is()) return;
    if (t.id === 'mcOlder') { load(true); return; }
    // a host the plan announces, added to the project's one list for the sessions (lib/domains.mjs)
    if (t.dataset.allowHost) { t.disabled = true; api('/api/project/domain', { project, host: t.dataset.allowHost, scope: 'sessions', keep: true }).catch((er) => ({ error: er.message })).then((r) => { if (r && r.error) { t.disabled = false; document.getElementById('state').textContent = r.error; return; } allowedHere.add(t.dataset.allowHost); render(); }); return; }
    if (t.dataset.retire && window.escadrilleRetire) { const id = t.dataset.retire; const d = t.closest('details'); if (d) d.open = false; window.escadrilleRetire.ask({ id, title: t.dataset.title || id, ...planLive(id) }, () => loadWaiting(project).then(render)); return; }
    if (t.dataset.reopen && window.escadrilleRetire) { window.escadrilleRetire.reopen(t.dataset.reopen, () => loadWaiting(project).then(render)).catch(() => {}); return; }
    if (t.id === 'mcStatusLine') { const d = document.getElementById('mcStatus'); if (d && !d.open) { d.showModal(); if (window.escadrilleUX) window.escadrilleUX.open(d, { trigger: t, close: () => d.close(), trap: true }); } return; }
    if (t.dataset.closeStatus !== undefined) { const d = t.closest('dialog'); if (d) d.close(); return; }
    if (t.dataset.more) { const a = document.getElementById('mc-' + t.dataset.more); a.querySelector('.mc-text').classList.remove('clamped'); t.remove(); return; }
    if (t.dataset.unfold !== undefined) { t.previousElementSibling.classList.remove('folded'); t.remove(); return; }
    if (t.dataset.start) { start(t.dataset.start); return; }
    if (t.dataset.goto) { const el = document.getElementById(t.dataset.goto); if (el) { stick = false; el.scrollIntoView({ block: 'center' }); const b = el.querySelector('[data-accept]'); if (b) b.focus(); } return; }
    if (t.dataset.accept) { accept(t.dataset.accept, t); return; }
    if (t.dataset.allow) { allow(t.dataset.allow, t); return; }
    if (t.dataset.merge) { merge(t.dataset.merge, t); return; }
    if (t.dataset.startQa !== undefined) { startQa(t); return; }
    if (t.dataset.pilotRetry !== undefined) { pilotRetry(t); return; }
    if (t.dataset.abandon) { abandon(t.dataset.abandon, t); return; }
    if (t.dataset.offer !== undefined) { applyOffer(t); return; }
    if (t.dataset.offerPlan !== undefined) { offer = null; send(true); return; }
    if (t.dataset.edit) { const ta = document.getElementById('text'); if (ta) { ta.value = T('main.editPlan') + ' '; ta.focus(); ta.setSelectionRange(ta.value.length, ta.value.length); } return; }
    if (t.dataset.import) doImport(t.dataset.import); });
  window.addEventListener('hashchange', () => { if (location.hash === '#conversation') history.replaceState(history.state, '', location.pathname + location.search); if (is() && st && st.project === project) { stick = true; render(); } });
  window.addEventListener('hashchange', homeClass);
  if (window.escadrilleI18n) window.escadrilleI18n.onChange(() => { st = null; status = null; files = null; }); // read again in the new language
  // `set` gives a test (test/mainchat.test.mjs, no browser) the state the loaders would have fetched
  const set = (o) => { if ('st' in o) st = o.st; if ('status' in o) status = o.status; if ('pilot' in o) pilot = o.pilot; if ('flow' in o) flow = o.flow; if ('reviews' in o) reviews = o.reviews; if ('escs' in o) escs = o.escs; if ('perms' in o) perms = o.perms; };
  window.escadrilleMain = { is, view: viewHome, pickHtml, title: () => (project ? T('main.title', { name: P.name(project) || '' }) : 'calmdev'), waiting, statusAside, statusLine, primaryLabel, pilotState, set };
  if (is() && typeof meta !== 'undefined' && meta) render(); // index.html's first render may have run before this file
})();
