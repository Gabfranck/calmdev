// « À toi » (2026-11-02, session MOD): the requests a session is waiting on, over every screen of the app. The evening of
// 2 November two sessions of the Studio waited an hour on a permission nobody saw; this layer removes the step of finding
// the blocked session in its plan. Loaded by public/sidebar.js (so every page with the bar has it, and /site/ never does).
//   GET /api/asks?project=<path> → { asks: [{ plan, session, sessionName, project, pendingId, tool, command,
//     explain: { line, scope: 'local'|'network'|'outside', known }, network, suggest, at, why }], remote: [{ name, url, count }] }
//   answer: POST /api/plan/<plan>/session/<session>/answer { id: pendingId, allow, always, reason } (as public/plan.html)
// One request at a time, the oldest first, a counter for the rest. It opens without stealing the keyboard: with the focus
// in a field where the developer writes, it waits as a pill at the foot of the screen. Escape folds it into that pill and
// gives the focus back. a and r answer, as on the plan; the suggestion pre-selects a button and never presses it.
// A surcharge: the plan's card and the home's « À toi » list stay; answering anywhere removes it here at the next change.
// Reloaded on every `change` of the shared stream (public/events.js, never a second EventSource) and every 30 s.
(function (root) {
  const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  const T = (k, v) => (root.T ? root.T(k, v) : k);
  const base = (p) => String(p || '').split('/').filter(Boolean).pop() || '';

  // ---- the pure part (test/asks-ui.test.mjs) ----
  const keyOf = (a) => `${a.plan}/${a.session}/${a.pendingId}`;
  // the oldest first; the same request listed twice counts once; a request without a date goes last, in its order
  const queue = (list) => {
    const seen = new Set(); const out = [];
    (Array.isArray(list) ? list : []).forEach((a, i) => { if (!a || a.pendingId === undefined || a.pendingId === null) return; const k = keyOf(a); if (seen.has(k)) return; seen.add(k); out.push({ a, i, t: Date.parse(a.at) }); });
    return out.sort((x, y) => (Number.isNaN(x.t) ? Infinity : x.t) - (Number.isNaN(y.t) ? Infinity : y.t) || x.i - y.i).map((x) => x.a);
  };
  // the requests after the one shown
  const after = (n) => Math.max(0, (Number(n) || 0) - 1);
  // a field where the developer writes: the modal must not take the keyboard from it
  const TEXT_TYPES = /^(text|search|email|url|tel|password|number|date|time|datetime-local|month|week)$/i;
  const typing = (el) => !!el && (!!el.isContentEditable || el.tagName === 'TEXTAREA' || (el.tagName === 'INPUT' && TEXT_TYPES.test(el.type || 'text')) || el.tagName === 'SELECT');
  // what the screen shows: nothing, the pill, or the modal.
  //   count     requests waiting here
  //   open      the modal is open now (it stays open)
  //   typing    the focus is in a field where the developer writes (outside the modal)
  //   folded    the keys the developer folded with Escape: the pill until a new request arrives
  //   keys      the keys of the requests now
  const mode = ({ count = 0, open = false, typing: t = false, folded = null, keys = [] } = {}) => {
    if (!count) return 'none';
    if (open) return 'open';
    if (folded && keys.every((k) => folded.has(k))) return 'pill';
    return t ? 'pill' : 'open';
  };
  // the button the server suggests (never pressed): Refuser only when the suggestion says no
  const suggested = (a) => (a && a.suggest && a.suggest.allow === false ? 'deny' : 'allow');
  // the hosts of a network request, whatever shape the server gives
  const hostsOf = (a) => {
    const n = a && a.network; const list = Array.isArray(n) ? n : n && typeof n === 'object' ? n.hosts || n.domains || [] : typeof n === 'string' ? [n] : [];
    return list.map((h) => (typeof h === 'string' ? h : h && (h.host || h.domain))).filter(Boolean);
  };
  const scopeOf = (a) => { const s = a && a.explain && a.explain.scope; return s === 'network' || s === 'outside' ? s : 'local'; };

  // ---- the page ----
  const doc = root.document;
  const S = { asks: [], remote: [], shown: null, open: false, folded: null, prev: null, busy: false, error: '', es: null, project: undefined, timer: null, loading: false, again: false };
  const projectNow = () => {
    const sb = root.escadrilleSidebar; if (sb && sb.project) { const p = sb.project(); if (p) return p; }
    try { return new URLSearchParams(root.location.search).get('project') || root.localStorage.getItem('escadrille.project') || null; } catch { return null; }
  };
  const $ = (id) => doc.getElementById(id);

  const skeleton = () => {
    if ($('askVeil')) return;
    const veil = doc.createElement('div'); veil.className = 'ask-veil'; veil.id = 'askVeil'; veil.hidden = true;
    veil.innerHTML = `<div class="ask-dialog" id="askDialog" role="dialog" aria-modal="true" aria-labelledby="askLine" aria-describedby="askCmdLabel"><p class="ask-count" id="askCount" aria-live="polite"></p><div class="ask-body" id="askBody"></div></div>`;
    const dock = doc.createElement('div'); dock.className = 'ask-dock'; dock.id = 'askDock';
    dock.innerHTML = `<button type="button" class="ask-pill" id="askPill" data-ask-pill hidden></button><div class="ask-remote" id="askRemote" hidden></div>`;
    doc.body.append(veil, dock);
    veil.addEventListener('mousedown', (e) => { if (e.target === veil) { e.preventDefault(); fold(); } });
    veil.addEventListener('keydown', onKey);
    // « Autoriser pour le projet »: the host joins the project's list for the sessions (reached at their next start);
    // the ask itself still waits for Autoriser or Refuser
    veil.addEventListener('click', (e) => { const b = e.target.closest('[data-ask-allow-host]'); if (!b) return; e.stopPropagation(); b.disabled = true;
      fetch('/api/project/domain', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ project: b.dataset.project, host: b.dataset.askAllowHost, scope: 'sessions', keep: true }) }).then((r) => r.json()).catch((er) => ({ error: er.message }))
        .then((r) => { b.textContent = r && r.error ? r.error : '✓ ' + b.dataset.askAllowHost; }); }, true);
    veil.addEventListener('click', onClick);
    veil.addEventListener('submit', onSubmit);
    dock.addEventListener('click', (e) => { if (e.target.closest('[data-ask-pill]')) openModal(doc.activeElement, true); });
  };

  const whenAgo = (at) => { const d = Date.parse(at); if (Number.isNaN(d)) return ''; const t = root.T; return t && t.ago ? t.ago(new Date(d)) : ''; };
  // one request: who and where (quiet), the sentence, the scope, the whole command, the suggestion, two buttons, « Plus »
  const body = (a) => {
    const scope = scopeOf(a); const hosts = hostsOf(a); const known = !(a.explain && a.explain.known === false);
    const line = known && a.explain && a.explain.line ? a.explain.line : T('asks.unknown');
    const sug = suggested(a); const reason = a.suggest && a.suggest.reason ? String(a.suggest.reason) : '';
    const ago = whenAgo(a.at);
    const btn = (kind, key) => `<button type="button" class="btn ask-btn${sug === kind ? ' primary' : ''}" data-ask-answer="${kind}" aria-keyshortcuts="${key}">${esc(T(kind === 'allow' ? 'plan.allow' : 'plan.deny'))}<kbd class="ask-key" aria-hidden="true">${key}</kbd></button>`;
    return `<p class="ask-who"><span class="badge">${esc(a.session)}</span> <span class="ask-name">${esc(a.sessionName || '')}</span><span class="ask-proj">${esc(base(a.project))}${ago ? ' · ' + esc(ago) : ''}</span></p>
<h2 class="ask-line${known ? '' : ' ask-unknown'}" id="askLine">${esc(line)}</h2>
<p class="ask-scope"><span class="pill${scope === 'local' ? '' : ' warn'}">${esc(T('asks.scope.' + scope))}</span>${scope === 'network' && hosts.length ? `<span class="ask-hosts">${esc(hosts.join(', '))}</span>${a.project ? hosts.map((h) => ` <button type="button" class="card-link" data-ask-allow-host="${esc(h)}" data-project="${esc(a.project)}">${esc(T('dom.allow'))}${hosts.length > 1 ? ' · ' + esc(h) : ''}</button>`).join('') : ''}` : ''}</p>
<p class="ask-sr" id="askCmdLabel">${esc(T('asks.cmdLabel', { tool: a.tool || '' }))}</p>
<pre class="ask-cmd" tabindex="0" aria-labelledby="askCmdLabel"><code>${esc(a.command || '')}</code></pre>
${reason ? `<p class="ask-sugline" title="${esc(reason)}">${esc(reason)}</p>` : ''}
<p class="ask-err" id="askErr" role="alert"${S.error ? '' : ' hidden'}>${esc(S.error)}</p>
<div class="ask-actions">${sug === 'deny' ? btn('deny', 'r') + btn('allow', 'a') : btn('allow', 'a') + btn('deny', 'r')}</div>
<details class="ask-more"><summary>${esc(T('asks.more'))}</summary><div class="ask-more-body">
<button type="button" class="btn" data-ask-answer="always">${esc(T('asks.always'))}</button>
<form class="ask-why" data-ask-deny novalidate><input class="control" id="askReason" type="text" autocomplete="off" placeholder="${esc(T('plan.denyPh'))}" aria-label="${esc(T('plan.denyAria'))}"><button type="submit" class="btn">${esc(T('asks.denyWhy'))}</button></form>
</div></details>`;
  };

  const focusSuggested = () => { const dlg = $('askDialog'); const a = S.shown; if (!dlg || !a) return; const b = dlg.querySelector(`[data-ask-answer="${suggested(a)}"]`); if (b) b.focus(); };
  const drawDialog = () => {
    const dlg = $('askDialog'); if (!dlg) return; const list = S.asks; const a = list[0];
    if (!a) return;
    // the counter lives outside the replaced body, so the live region is the same node and its change is read
    const c = $('askCount'); const rest = after(list.length); const txt = rest ? T('asks.after', { n: rest }) : ''; if (c && c.textContent !== txt) c.textContent = txt;
    if (S.shown && keyOf(S.shown) === keyOf(a)) return false;
    S.shown = a; S.error = ''; $('askBody').innerHTML = body(a); dlg.scrollTop = 0;
    if (root.escadrilleUX && root.escadrilleUX.tip) root.escadrilleUX.tip(dlg);
    return true;
  };
  const drawDock = () => {
    const pill = $('askPill'); const rem = $('askRemote'); if (!pill || !rem) return;
    const n = S.asks.length; pill.hidden = !n || S.open; pill.textContent = n ? T('asks.pill', { n }) : '';
    const r = (S.remote || []).filter((x) => x && x.url && Number(x.count) > 0);
    rem.hidden = !r.length;
    rem.innerHTML = r.map((x) => `<p class="ask-remote-line">${esc(T('asks.remote', { name: x.name || '', n: Number(x.count) }))} · <a href="${esc(x.url)}">${esc(T('asks.open'))}</a></p>`).join('');
    // above a composer docked at the foot of the screen (the home, the plan's thread): never over the field being typed in
    const dock = $('askDock'); let lift = 0;
    for (const c of doc.querySelectorAll('.composer')) { const b = c.getBoundingClientRect(); if (b.height && b.bottom >= root.innerHeight - 4 && b.top < root.innerHeight) lift = Math.max(lift, root.innerHeight - b.top); }
    if (dock) dock.style.bottom = Math.round(16 + lift) + 'px';
  };

  const openModal = (prev, fromPill) => {
    if (!S.asks.length) return; const veil = $('askVeil'); if (!veil) return;
    if (!S.open) { S.prev = prev && prev !== doc.body ? prev : null; S.open = true; S.folded = null; drawDialog(); veil.hidden = false; drawDock();
      if (root.escadrilleUX) root.escadrilleUX.open(veil, { trigger: fromPill ? null : S.prev, close: () => fold(true), trap: true, restore: () => S.prev && S.prev.isConnected ? S.prev : null }); }
    focusSuggested();
  };
  // Escape, the veil, or the last answer: the modal leaves; folded keeps the pill until a new request arrives
  const close = ({ folded = false, focus = true } = {}) => {
    if (!S.open) return; S.open = false; const veil = $('askVeil'); if (veil) veil.hidden = true;
    if (folded) S.folded = new Set(S.asks.map(keyOf));
    if (root.escadrilleUX) root.escadrilleUX.close(veil, { focus: false });
    drawDock();
    if (focus) { const p = S.prev; S.prev = null; if (p && p.isConnected && p.focus) p.focus(); else if (folded) { const pill = $('askPill'); if (pill && !pill.hidden) pill.focus(); } }
  };
  const fold = (fromUX) => close({ folded: true, focus: !fromUX });

  const apply = (got) => {
    S.asks = queue(got && got.asks); S.remote = (got && Array.isArray(got.remote)) ? got.remote : [];
    const keys = S.asks.map(keyOf);
    if (S.folded && !keys.every((k) => S.folded.has(k))) S.folded = null;
    const active = doc.activeElement; const inside = !!(active && active.closest && active.closest('#askVeil'));
    const m = mode({ count: S.asks.length, open: S.open, typing: !inside && typing(active), folded: S.folded, keys });
    if (m === 'none') { S.shown = null; close(); }
    else if (m === 'open') { if (!S.open) openModal(active); else if (drawDialog()) focusSuggested(); }
    drawDock();
  };
  const load = async () => {
    if (S.loading) { S.again = true; return; } S.loading = true;
    try {
      const p = projectNow(); if (p !== S.project) { S.project = p; connect(); }
      const r = await fetch('/api/asks' + (p ? '?project=' + encodeURIComponent(p) : '')).catch(() => null);
      const got = r && r.ok ? await r.json().catch(() => null) : null;
      if (got) apply(got);
    } finally { S.loading = false; if (S.again) { S.again = false; load(); } }
  };
  const connect = () => {
    if (S.es) { S.es.close(); S.es = null; } if (typeof root.EventSource === 'undefined') return;
    const es = new root.EventSource('/api/events' + (S.project ? '?project=' + encodeURIComponent(S.project) : '')); S.es = es;
    es.addEventListener('change', () => load()); es.addEventListener('pending', () => load());
  };

  const answer = async (kind, reason = '') => {
    const a = S.shown; if (!a || S.busy) return; const dlg = $('askDialog');
    S.busy = true; S.error = ''; const err = $('askErr'); if (err) { err.hidden = true; err.textContent = ''; }
    const buttons = dlg ? [...dlg.querySelectorAll('button')] : []; for (const b of buttons) b.disabled = true; if (dlg) dlg.setAttribute('aria-busy', 'true');
    let r;
    try {
      const res = await fetch(`/api/plan/${encodeURIComponent(a.plan)}/session/${encodeURIComponent(a.session)}/answer`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ id: a.pendingId, allow: kind !== 'deny', always: kind === 'always', reason }) });
      const j = await res.json().catch(() => ({})); r = res.ok && !j.error ? j : { error: j.error || T('asks.err', { status: res.status }) };
    } catch (e) { r = { error: T('asks.errNet') }; }
    S.busy = false; if (dlg) dlg.removeAttribute('aria-busy');
    if (r.error) { for (const b of buttons) b.disabled = false; S.error = String(r.error); const e2 = $('askErr'); if (e2) { e2.textContent = S.error; e2.hidden = false; } return; }
    // the next one at once, in the same dialog (no flicker); the list is reloaded behind it
    S.asks = S.asks.filter((x) => keyOf(x) !== keyOf(a));
    if (!S.asks.length) { S.shown = null; close(); } else { drawDialog(); focusSuggested(); drawDock(); }
    load();
  };

  function onClick(e) { const b = e.target.closest && e.target.closest('[data-ask-answer]'); if (!b || b.disabled) return; const kind = b.dataset.askAnswer; const rs = $('askReason'); answer(kind, kind === 'deny' && rs ? rs.value.trim() : ''); }
  function onSubmit(e) { if (!e.target.matches('[data-ask-deny]')) return; e.preventDefault(); const rs = $('askReason'); answer('deny', rs ? rs.value.trim() : ''); }
  // inside the modal: a and r answer (never in the reason field); the page's own keys (1-4, ?, the plan's a/r) stay out
  function onKey(e) {
    if (e.key === 'Escape' || e.key === 'Tab') return; // ux.js: the layer's Escape and the trap
    const t = e.target; const inField = typing(t);
    if (!inField && !e.metaKey && !e.ctrlKey && !e.altKey && (e.key === 'a' || e.key === 'r')) { const b = $('askDialog').querySelector(`[data-ask-answer][aria-keyshortcuts="${e.key}"]`); if (b && !b.disabled) { e.preventDefault(); b.click(); } }
    e.stopPropagation();
  }

  const start = () => {
    if (!doc || !doc.body || S.timer) return; skeleton(); load();
    S.timer = root.setInterval(() => { if (!doc.hidden) load(); }, 30000);
    if (root.addEventListener) root.addEventListener('resize', drawDock);
    if (root.escadrilleI18n) root.escadrilleI18n.onChange(() => { const was = S.shown; S.shown = null; if (S.open && was) { drawDialog(); focusSuggested(); } drawDock(); });
  };

  root.escadrilleAsks = { queue, after, typing, mode, suggested, hostsOf, scopeOf, keyOf, load, apply, state: S };
  if (doc && doc.addEventListener) { if (doc.readyState === 'loading') doc.addEventListener('DOMContentLoaded', start); else start(); }
})(typeof window !== 'undefined' ? window : globalThis);
