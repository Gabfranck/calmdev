// Phase 8 D, the pilot's log (docs/pilotlog.md), phase 9 P3 (docs/phase9/direction.md §6): /#pilote, titled « Pilote »,
// the switch in the title row (the same as the Conversation's), what the pilot did, one row per action grouped by day,
// the why on a click. No tab of its own: one folded line under the Conversation's thread leads here. This file wraps
// window.escadrilleMain (public/mainchat.js, left untouched) so index.html's render() shows either screen; index.html
// only loads it, after mainchat.js. It uses index.html's globals: esc, api, fmt, project, P, render.
(() => {
  const link = document.createElement('link'); link.rel = 'stylesheet'; link.href = '/pilotlog.css'; document.head.appendChild(link);
  const main = window.escadrilleMain; if (!main) return;
  const is = () => !escId && location.hash === '#pilote';
  const T = (k, v) => (window.T ? window.T(k, v) : k);
  const VERB = new Proxy({}, { get: (o, k) => (['answer', 'propose', 'launch', 'message', 'memory', 'capture', 'refuse', 'merge', 'note'].includes(k) ? T('pilot.verb.' + k) : undefined) });
  let st = null; // { project, actions (newest first), more, total, error }
  let pilot = null; let pilotErr = ''; // GET /api/pilot: { on, busy, spentToday, daily, budget }
  let open = new Set(); let es = null;
  const day = (iso) => { const s = window.T.date(iso, { weekday: 'long', day: 'numeric', month: 'long' }); return s.charAt(0).toUpperCase() + s.slice(1); };
  const hm = (iso) => window.T.time(iso);
  const fold = (s) => String(s).normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase();
  const money = (x) => (x == null ? '–' : window.T.usd(Number(x), 2));
  const url = (before) => `/api/pilot/log?project=${encodeURIComponent(project)}&limit=100${before ? '&before=' + before : ''}`;

  const load = async (older = false) => {
    const p = project; if (!p) { st = { project: null, actions: [], more: false, total: 0 }; return refresh(); }
    const last = older && st && st.actions[st.actions.length - 1];
    const [r, pv] = await Promise.all([api(url(last ? last.seq : null)).catch((e) => ({ error: e.message })), is() ? api('/api/pilot?project=' + encodeURIComponent(p)).catch(() => null) : Promise.resolve(pilot)]);
    if (r.error) st = { project: p, actions: older && st ? st.actions : [], error: r.error };
    else st = { project: p, actions: older && st && st.project === p ? [...st.actions, ...r.actions] : r.actions, more: r.more, total: r.total };
    if (pv && !pv.error) pilot = pv;
    live(p); refresh();
  };
  // the switch: POST /api/pilot { project, on }; the Conversation's switch (mainchat.js) only listens on its own screen
  if (window.escadrilleI18n) window.escadrilleI18n.onChange(() => { st = null; });
  const toggle = async (on) => { pilotErr = ''; const r = await api('/api/pilot', { project, on }).catch((e) => ({ error: e.message })); if (r.error) pilotErr = r.error; else pilot = r.pilot; render(); };
  // on this screen, render the whole canvas; on the Conversation, only update the folded line
  const refresh = () => { if (is()) return render(); const f = document.getElementById('plFold'); if (f) f.outerHTML = foldHtml(); };
  const live = (p) => { if (es && es.p === p) return; if (es) es.close(); es = new EventSource('/api/events?main=' + encodeURIComponent(p)); es.p = p; es.addEventListener('change', () => { if (is() || main.is()) load(); }); };

  // ---- the folded line under the Conversation's thread
  const foldHtml = () => { const n = st && st.project === project && !st.error ? st.total : null;
    return `<p class="pl-fold" id="plFold"><a href="${esc(P.withProject('/', project))}#pilote" data-jk>${n === null ? esc(T('pilot.foldLink')) : esc(T('pilot.foldN', { n })).replace(fmt(n), `<span class="pl-n">${fmt(n)}</span>`)}</a></p>`; };
  const withFold = (html) => { if (!st || st.project !== project) load();
    for (const at of ['<div id="mainEnd">', '<form id="mainForm"']) { const i = html.indexOf(at); if (i >= 0) return html.slice(0, i) + foldHtml() + html.slice(i); }
    return html + foldHtml(); };

  // ---- the screen
  // the verb in ink, then the line; a text that starts with its own verb never says it twice
  const lineHtml = (a) => { const t = a.text || ''; const v = VERB[a.kind] || '';
    if (fold(t).startsWith(fold(v))) return `<b>${esc(t.slice(0, v.length))}</b>${esc(t.slice(v.length))}`;
    return `<b>${esc(v)}</b> ${esc(t)}`; };
  const chip = (a) => !a.href ? '<span class="pl-chip none" aria-hidden="true"></span>'
    : `<a class="pl-chip" href="${esc(a.href)}" title="${esc(a.sessionId ? T('pilot.chipSession', { s: a.sessionId }) : T('pilot.chipPlan'))}">${esc(a.sessionId || T('pilot.plan'))}</a>`;
  const rowHtml = (a) => { const has = !!a.detail; const o = has && open.has(a.seq);
    return `<li class="pl-row${o ? ' open' : ''}" id="pl-${a.seq}">
      <time class="pl-time" datetime="${esc(a.at)}" title="${esc(window.T.dateTime(a.at))}">${hm(a.at)}</time>
      ${has ? `<button type="button" class="pl-line" data-why="${a.seq}" aria-expanded="${o}" aria-controls="plw-${a.seq}">${lineHtml(a)}</button>` : `<span class="pl-line">${lineHtml(a)}</span>`}
      ${chip(a)}
      ${o ? `<p class="pl-why" id="plw-${a.seq}">${esc(a.detail)}</p>` : ''}</li>`; };
  const listHtml = () => { let out = ''; let d = null;
    for (const a of st.actions) { const dd = day(a.at); if (dd !== d) { if (d) out += '</ol>'; out += `<h2 class="pl-day">${esc(dd)}</h2><ol class="pl-list">`; d = dd; } out += rowHtml(a); }
    return out + (d ? '</ol>' : ''); };
  // the switch in the title row, the same control as the Conversation's (mainchat.css .mc-pilot), its own id
  const switchHtml = () => { const on = !!(pilot && pilot.on);
    const state = pilotErr ? esc(pilotErr) : !on ? '' : pilot.busy ? T('pilot.reading') : pilot.spentToday >= pilot.daily ? T('pilot.dayCap') : '';
    return `<label class="mc-pilot" title="${esc(pilot ? T('pilot.switchTitle', { spent: money(pilot.spentToday), daily: money(pilot.daily), budget: money(pilot.budget) }) : T('pilot.switchIdle'))}"><input type="checkbox" role="switch" id="plPilot" ${on ? 'checked' : ''} ${pilot ? '' : 'disabled'}><span class="mc-switch" aria-hidden="true"></span>${esc(T('pilot.title'))}${state ? ` <span class="mc-pilot-state" role="status">${state}</span>` : ''}</label>`; };
  // the pilot's model, one folded line (POST /api/pilot { pilotModel }): its name and the mean cost of a wake over 24 h
  let modelOpen = false;
  const modelHtml = () => { if (!pilot || !pilot.model) return '';
    const w = pilot.wake24h || { wakes: 0, avg: null };
    const cost = w.wakes ? T('pilot.modelCost', { usd: money(w.avg), n: w.wakes }) : T('pilot.modelNoWake');
    const names = (typeof MODEL_NAMES !== 'undefined' && MODEL_NAMES) || {}; const ids = Object.keys(names).length ? Object.keys(names) : [pilot.model];
    const pick = modelOpen ? `<label class="pl-model-pick">${esc(T('pilot.modelPick'))} <select id="plModel">${ids.map((id) => `<option value="${esc(id)}"${id === pilot.model ? ' selected' : ''}>${esc(names[id] || id)}</option>`).join('')}</select></label>` : '';
    return `<div class="pl-model" id="plModelLine"><button type="button" class="pl-model-fold" id="plModelFold" aria-expanded="${modelOpen}">${esc(T('pilot.modelLine', { model: pilot.modelName || pilot.model }))} · <span class="pl-n">${esc(cost)}</span></button>${pick}</div>`; };
  const setModel = async (id) => { pilotErr = ''; const r = await api('/api/pilot', { project, pilotModel: id }).catch((e) => ({ error: e.message })); if (r.error) pilotErr = r.error; else { pilot = r.pilot; modelOpen = false; } render(); };
  const head = (sub) => `<div class="title-row"><div><h1>${esc(T('pilot.title'))}</h1><p class="sub">${sub}</p></div>${switchHtml()}</div>${modelHtml()}`;
  const view = () => {
    const name = P.name(project) || T('pilot.thisProject');
    document.getElementById('crumb').textContent = T('pilot.title');
    if (!st || st.project !== project) { load(); return head(esc(T('pilot.loading', { name }))) + `<div class="pl-log" aria-busy="true">${'<div class="pl-skel"></div>'.repeat(6)}</div>`; }
    if (st.error) return head(esc(name)) + `<p class="pl-empty" role="alert">${esc(T('pilot.logError', { e: st.error }))} <button type="button" class="card-link" id="plRetry">${esc(T('pilot.retry'))}</button></p>`;
    const on = !!(pilot && pilot.on);
    // empty: one sentence under the title, no empty block (direction.md §6)
    if (!st.actions.length) return head(esc(on ? T('pilot.onEmpty', { name }) : T('pilot.offEmpty')));
    const sub = esc(T(on ? 'pilot.sub' : 'pilot.subOff', { name, n: st.total }));
    return head(sub) + `<div class="pl-log" data-ui>${listHtml()}</div>${st.more ? `<p class="pl-older"><button type="button" class="card-link" id="plOlder">${esc(T('pilot.older'))}</button></p>` : ''}`;
  };

  document.addEventListener('click', (e) => { if (!is()) return; const t = e.target.closest('button'); if (!t) return;
    if (t.id === 'plOlder') return load(true);
    if (t.id === 'plRetry') { st = null; return render(); }
    if (t.id === 'plModelFold') { modelOpen = !modelOpen; render(); const b = document.getElementById(modelOpen ? 'plModel' : 'plModelFold'); if (b) b.focus(); return; }
    if (t.dataset.why) { const s = Number(t.dataset.why); open.has(s) ? open.delete(s) : open.add(s); render(); const b = document.querySelector(`[data-why="${s}"]`); if (b) b.focus(); } });
  document.addEventListener('change', (e) => { if (is() && e.target.id === 'plPilot') toggle(e.target.checked); if (is() && e.target.id === 'plModel') setModel(e.target.value); });

  window.escadrilleMain = {
    is: () => is() || main.is(),
    view: () => (is() ? view() : withFold(main.view())),
    title: () => (is() ? T('pilot.pageTitle', { name: P.name(project) || '' }) : main.title()),
    waiting: main.waiting,
  };
  if (is() && typeof meta !== 'undefined' && meta) render(); // index.html's first render may have run before this file
})();
