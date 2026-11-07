// The burst « Jusqu'à la limite » (docs/burst.md) as the « Rafale » screen (#rafale, alias #limite; docs/phase9/direction.md
// §6). One primary action: « Jusqu'à la limite » while no burst runs (the backlog in a checkable list, the cap, the
// margin read in the quota in one line), « Stop » while one runs (its tasks, its journal folded). The last burst and the
// auto mode fold to one line each. The old folded sheet of the home (sheet()) stays exported, unused since phase 9 B.
(() => {
  const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  const api = (p, body) => fetch(p, body ? { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) } : undefined).then(async (r) => ({ status: r.status, ...(await r.json().catch(() => ({}))) })).catch(() => ({ status: 0, error: T('burst.offline') })); // a network failure is said, never thrown
  const q = (p) => encodeURIComponent(p);
  const T = (k, v) => window.T(k, v);
  const usd = (x) => window.T.usd(Number(x || 0), 2);
  const hm = (iso) => window.T.time(iso);
  const dayHm = (iso) => window.T.date(iso, { weekday: 'long' }) + ' ' + hm(iso);
  const dayShort = (iso) => window.T.date(iso);
  const inH = (h) => (h < 1 ? T('burst.inMin', { n: Math.max(1, Math.round(h * 60)) }) : T('burst.inH', { n: Math.round(h) }));
  const STATUS = new Proxy({}, { get: (o, k) => (['todo', 'planning', 'running', 'done', 'failed'].includes(k) ? T('burst.st.' + k) : undefined) });
  const PILL = { done: 'pos', failed: 'neg', running: 'warn', planning: 'warn' };
  const BSTATUS = new Proxy({}, { get: (o, k) => (['running', 'draining', 'done', 'stopped', 'limit', 'ended'].includes(k) ? T('burst.bst.' + k) : undefined) });
  let S = { project: null, open: location.hash === '#limite', horizon: null, backlog: null, bursts: [], settings: null, picked: null, cap: null, note: '', current: null, loaded: false };
  let rerender = () => {};
  const active = () => S.bursts.find((b) => b.status === 'running' || b.status === 'draining') || null;

  // the app's tokens only: lines of 44 px on --raised, radius 8; the one hue on the data (a running task's pill)
  const css = document.createElement('style');
  css.textContent = `.burst { padding: 4px var(--card-pad, 12px) 0; font-size: var(--fs-small, 13px); }
.burst > button.btn { width: fit-content; }
.burst-sheet { display: grid; gap: 8px; margin: 8px calc(-1 * var(--card-pad, 12px)) 0; padding: 12px; border-radius: 8px; background: var(--active, #f2f2f2); }
.burst-sheet p { margin: 0; line-height: 18px; }
.burst-sheet .dim, .burst-view .dim { color: var(--muted); }
.burst-tasks { list-style: none; margin: 0; padding: 0; display: grid; gap: 2px; }
.burst-tasks label { display: flex; gap: 8px; align-items: baseline; line-height: 20px; }
.burst-tasks .done { color: var(--faint, #999); text-decoration: line-through; }
.burst-cap { display: flex; flex-wrap: wrap; gap: 8px; align-items: center; min-width: 0; } /* two buttons wrap on a phone: the row pushed the page sideways at 390 */
.burst-cap input { width: 72px; }
.burst-sheet details summary { cursor: pointer; color: var(--muted); }
.burst-auto { display: grid; gap: 6px; margin-top: 6px; }
.burst-auto input[type=number] { width: 56px; }
.burst-view { display: grid; grid-template-columns: minmax(0, 1fr); gap: 24px; max-width: 860px; } .burst-view section { min-width: 0; } /* a section never widens past the page: its track may shrink (390, the verifier) */
.burst-act { display: inline-flex; align-items: center; gap: 12px; } .burst-why { color: var(--muted); font-size: var(--fs-small); }
.burst-view h2 { font-size: var(--fs-section); font-weight: 600; margin-bottom: 8px; }
.burst-view .rows { display: grid; gap: 2px; }
.burst-view .row { display: grid; grid-template-columns: 16px minmax(0, 1fr) auto; gap: 12px; align-items: center; min-height: var(--row-height, 44px); padding: 6px 12px 6px 14px; border-radius: var(--radius-card, 8px); background: var(--raised); cursor: pointer; line-height: 20px; }
.burst-view .row input { width: 16px; height: 16px; margin: 0; accent-color: var(--accent); }
.burst-view .row.done { color: var(--faint); cursor: default; } .burst-view .row.done .t { text-decoration: line-through; }
.burst-view .row .t { min-width: 0; overflow-wrap: anywhere; }
.burst-view .row .t .links { color: var(--muted); font-size: var(--fs-small); } .burst-view .row .t .links a { color: var(--muted); } .burst-view .row .t .links a:hover { color: var(--text); }
.burst-view .row .c { color: var(--muted); font-size: var(--fs-small); font-variant-numeric: tabular-nums; white-space: nowrap; }
.burst-view .task { grid-template-columns: minmax(0, 1fr) auto auto; cursor: default; }
.burst-view .task .pill { justify-self: end; }
.burst-view .line { display: flex; flex-wrap: wrap; align-items: center; gap: 8px 16px; margin-top: 12px; color: var(--muted); font-size: var(--fs-small); }
.burst-view .line label { display: inline-flex; align-items: center; gap: 6px; color: var(--text); }
.burst-view .line input { width: 64px; height: 28px; padding: 0 6px; border: 1px solid var(--control); border-radius: var(--radius-control); background: var(--surface); color: var(--text); font: inherit; font-variant-numeric: tabular-nums; }
.burst-view .line input[type=time] { width: 112px; }
.burst-view .empty { padding: 0; color: var(--muted); }
.burst-view .acts { display: flex; flex-wrap: wrap; gap: 8px; margin-top: 12px; }
.burst-view .folds { display: grid; grid-template-columns: minmax(0, 1fr); gap: 8px; } .burst-view .fold, .burst-view .fold > summary { min-width: 0; } /* a folded line never widens past the page: its nowrap text is cut with an ellipsis (390, the verifier) */
.burst-view .burst-done { margin-top: 8px; } .burst-view .burst-done > div { padding-top: 6px; }
.burst-view .fold { background: var(--raised); border-radius: var(--radius-card, 8px); }
.burst-view .fold > summary { min-height: var(--row-height, 44px); padding: 0 var(--card-pad, 20px); display: flex; align-items: center; gap: 12px; color: var(--text); font-size: var(--fs-body); font-weight: 400; }
.burst-view .fold > summary .k { font-weight: 600; } .burst-view .fold > summary .m { color: var(--muted); min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.burst-view .fold > div { padding: 0 var(--card-pad, 20px) 16px; display: grid; gap: 8px; }
.burst-view .fold .rows .row { background: var(--surface); }
.burst-view .log { list-style: none; margin: 0; padding: 0; display: grid; gap: 2px; color: var(--muted); font-variant-numeric: tabular-nums; font-size: var(--fs-small); line-height: 20px; }
.burst-view .log b { font-weight: 500; color: var(--text); margin-left: 8px; }
.burst-view .burst-auto label { display: flex; flex-wrap: wrap; align-items: center; gap: 6px; }
.burst-view .burst-auto input[type=number] { width: 56px; height: 28px; padding: 0 6px; border: 1px solid var(--control); border-radius: var(--radius-control); background: var(--surface); color: var(--text); font: inherit; }
.burst-view .note { color: var(--negative); }
@media (max-width: 640px) { .burst-view section { overflow-x: clip; } .burst-view .task { grid-template-columns: minmax(0, 1fr) auto; } .burst-view .task .c { grid-column: 1; } }`;
  document.head.appendChild(css);

  const load = async (project) => {
    if (!project) return;
    if (project !== S.project) S = { ...S, project, picked: null, cap: null, note: '', loaded: false };
    const [horizon, backlog, bursts, settings] = await Promise.all([
      api('/api/project/horizon?project=' + q(project)), api('/api/project/backlog?project=' + q(project)),
      api('/api/bursts?project=' + q(project)), api('/api/project/settings?project=' + q(project)),
    ].map((p) => p.catch((e) => ({ error: e.message }))));
    S.horizon = horizon; S.backlog = backlog; S.bursts = bursts.bursts || []; S.settings = settings; S.loaded = true;
    if (!S.picked && backlog.tasks) { const open = backlog.tasks.filter((t) => !t.done); const num = open.filter((t) => t.pick); S.picked = new Set((num.length ? num : open).map((t) => t.n)); }
    S.current = S.bursts[0] || null;
    const nav = document.getElementById('navBurst');
    if (nav) { nav.hidden = !S.bursts.length; nav.href = '/?project=' + q(project) + '#rafale'; nav.setAttribute('aria-current', location.hash === '#rafale' ? 'page' : 'false'); } // i18n-ok
    rerender();
  };
  const capDefault = () => (S.horizon?.remainingUsd > 0 ? Math.max(1, Math.round(S.horizon.remainingUsd * 0.6)) : 10);

  // ---- the margin, read in the quota, one line
  const marginLine = (h) => (!h || h.usedPct == null ? T('burst.marginUnknown')
    : h.remainingUsd != null ? T('burst.marginUsd', { pct: Math.round(h.remainingPct), usd: window.T.usd(Math.round(h.remainingUsd), 0) }) : T('burst.marginPct', { pct: Math.round(h.remainingPct) }));
  const resetLine = (h) => (h?.resetsAt ? T('burst.reset', { when: dayHm(h.resetsAt), in: inH(h.hoursLeft) }) : '');
  // The automatic burst is no longer a setting (backlog, Dev 6 November): an old autoBurst still on shows one line to turn it
  // off; nothing turns it on from the screen
  const autoLine = () => { const a = S.settings?.autoBurst; if (!a || !a.on) return '';
    return `<p class="dim burst-oldauto">${esc(T('burst.oldAuto', { pct: a.minMarginPct }))} · <button type="button" class="card-link" data-burst-autooff>${esc(T('burst.oldAutoOff'))}</button></p>`; };
  const untilDefault = () => { const d = new Date(Date.now() + 4 * 36e5); return `${String(d.getHours()).padStart(2, '0')}:00`; };
  const untilIso = (hm) => { const [h, m] = String(hm || '').split(':').map(Number); if (!Number.isFinite(h)) return null; const d = new Date(); d.setHours(h, m || 0, 0, 0); return d.getTime() > Date.now() ? d.toISOString() : null; };
  const advanceFields = () => `<label>${esc(T('burst.until'))} <input type="time" id="burstUntil" value="${esc(S.until ?? untilDefault())}"></label><label>${esc(T('burst.atMost'))} <input type="number" id="burstCap" min="1" step="1" value="${S.cap ?? capDefault()}" aria-label="${esc(T('burst.capAria'))}"> $</label>`;
  // ---- the old folded sheet of the home (phase 7), kept for anything that still calls it
  const sheetBody = () => {
    const h = S.horizon; const b = S.backlog || {}; const run = active();
    const head = `<p><b>${esc(marginLine(h))}</b></p>${resetLine(h) ? `<p class="dim">${esc(resetLine(h))}</p>` : ''}`;
    if (run) { const done = run.tasks.filter((t) => t.status === 'done').length; return `${head}<p>${esc(T('burst.runLine', { status: BSTATUS[run.status], done, n: run.tasks.length, spent: usd(run.spentUsd), cap: usd(run.capUsd) }))}</p><a class="btn" href="#rafale">${esc(T('burst.see'))}</a>${autoLine()}`; }
    if (!b.exists) return `${head}<p>${esc(T('burst.noBacklog'))}</p><div class="burst-cap"><button type="button" class="btn" data-burst-create="roadmap">${esc(T('burst.fromRoadmap'))}</button><button type="button" class="btn ghost" data-burst-create="memory">${esc(T('burst.fromMemory'))}</button></div>${S.note ? `<p class="dim">${esc(S.note)}</p>` : ''}`;
    const items = b.tasks.map((t) => `<li><label class="${t.done ? 'done' : ''}"><input type="checkbox" data-burst-task="${t.n}" ${t.done ? 'disabled' : S.picked?.has(t.n) ? 'checked' : ''}>${esc(t.text)}</label></li>`).join('');
    return `${head}<ul class="burst-tasks" aria-label="${esc(T('burst.tasksAria'))}">${items}</ul>
<label class="burst-cap">${esc(T('burst.capLabel'))} <input type="number" id="burstCap" min="1" step="1" value="${S.cap ?? capDefault()}"> $</label>
<div><button type="button" class="btn primary" id="burstSend">${esc(T('burst.send'))}</button></div>${S.note ? `<p class="dim">${esc(S.note)}</p>` : ''}${autoLine()}`;
  };
  const sheet = () => (!S.project ? '' : `<div class="burst" data-region="burst"><button type="button" class="btn" id="burstToggle" aria-expanded="${S.open}">${esc(T('burst.toLimit'))}</button>${S.open ? `<div class="burst-sheet" id="burstSheet">${sheetBody()}</div>` : ''}</div>`);

  // ---- the screen
  const taskRow = (t, project) => `<div class="row task"><span class="t">${esc(t.text)}${t.note ? ` <span class="links">(${esc(t.note)})</span>` : ''}${t.escadrille || t.plan ? ` <span class="links">${t.escadrille ? `<a href="/e/${q(t.escadrille)}?project=${q(project)}">${esc(T('burst.thread'))}</a>` : ''}${t.escadrille && t.plan ? ' · ' : ''}${t.plan ? `<a href="/plan/${q(t.plan)}?project=${q(project)}">${esc(T('burst.plan'))}</a>` : ''}</span>` : ''}</span><span class="c">${usd(t.cost)}</span><span class="pill ${PILL[t.status] || ''}">${esc(STATUS[t.status] || t.status)}</span></div>`;
  const journal = (b) => `<details class="fold"><summary><span class="k">${esc(T('burst.journal'))}</span><span class="m">${esc(T('burst.lines', { n: b.log.length }))}</span></summary><div><ul class="log">${b.log.map((l) => `<li>${esc(hm(l.at))}<b>${esc(l.text)}</b></li>`).join('')}</ul></div></details>`;
  // the last burst, folded to one line: its state, its tasks done, its cost
  const lastFold = (b) => { if (!b) return ''; const done = b.tasks.filter((t) => t.status === 'done').length;
    return `<details class="fold"><summary><span class="k">${esc(T('burst.last'))}</span><span class="m">${esc(BSTATUS[b.status] || b.status)} · ${esc(T('burst.doneN', { done, n: b.tasks.length }))} · ${esc(T('burst.ofCap', { spent: usd(b.spentUsd), cap: usd(b.capUsd) }))} · ${esc(dayShort(b.until))}</span></summary><div><div class="rows">${b.tasks.map((t) => taskRow(t, b.project)).join('')}</div>${journal(b)}</div></details>`; };
  const autoFold = autoLine;
  const head = (sub, action = '') => `<div class="title-row"><div><h1>${esc(T('burst.title'))}</h1><p class="sub">${sub}</p></div>${action}</div>`;
  const view = () => {
    const h = S.horizon; const run = active(); const b = S.backlog || {}; const last = S.bursts[0] || null;
    if (!S.loaded) return head(esc(T('burst.loading')));
    const margin = [marginLine(h), resetLine(h)].filter(Boolean).map(esc).join(' · ');
    if (run) {
      const done = run.tasks.filter((t) => t.status === 'done').length;
      const sub = [`<b>${esc(T('burst.advancing', { t: hm(run.until), cap: usd(run.capUsd) }))}</b>`, BSTATUS[run.status], T('burst.doneN', { done, n: run.tasks.length }), T('burst.ofCap', { spent: usd(run.spentUsd), cap: usd(run.capUsd) }), marginLine(h)].map((x, i) => (i ? esc(x) : x)).join(' · ');
      return head(sub, `<button type="button" class="btn primary" id="burstStop">${esc(T('burst.stop'))}</button>`) + `<div class="burst-view"><section aria-label="${esc(T('burst.tasks'))}"><div class="rows">${run.tasks.map((t) => taskRow(t, run.project)).join('')}</div></section><div class="folds">${journal(run)}${autoFold()}</div></div>`;
    }
    if (!b.exists) return head(margin) + `<div class="burst-view"><section><h2>${esc(T('burst.backlog'))}</h2><p class="empty">${esc(T('burst.noBacklogHere', { file: '\u0001' })).replace('\u0001', '<code>docs/backlog.md</code>')}</p><div class="acts"><button type="button" class="btn" data-burst-create="roadmap">${esc(T('burst.fromRoadmap'))}</button><button type="button" class="btn" data-burst-create="memory">${esc(T('burst.fromMemoryCap'))}</button></div>${S.note ? `<p class="note" role="alert">${esc(S.note)}</p>` : ''}</section><div class="folds">${lastFold(last)}${autoFold()}</div></div>`;
    const todo = b.tasks.filter((t) => !t.done); const picked = todo.filter((t) => S.picked?.has(t.n)).length;
    // the tasks to do, then the tasks done folded to one line (phase 11, DP: thirty struck lines hid the ten to tick)
    const rowOf = (t) => `<label class="row ${t.done ? 'done' : ''}"><input type="checkbox" data-burst-task="${t.n}" ${t.done ? 'disabled' : S.picked?.has(t.n) ? 'checked' : ''}><span class="t">${esc(t.text)}</span></label>`;
    const doneTasks = b.tasks.filter((t) => t.done);
    const rows = todo.map(rowOf).join('') + (doneTasks.length ? `<details class="fold burst-done"><summary><span class="k">${esc(T('burst.doneFold', { n: doneTasks.length }))}</span></summary><div class="rows">${doneTasks.map(rowOf).join('')}</div></details>` : '');
    // grey with its reason beside it until a task is ticked (phase 11, G, cause F)
    const action = todo.length ? `<span class="burst-act"><span class="burst-why" id="burstWhy"${picked ? ' hidden' : ''}>${esc(T('burst.pickOne'))}</span><button type="button" class="btn primary" id="burstSend" ${picked ? '' : 'disabled'} aria-describedby="burstWhy" title="${esc(T('burst.sendTitle'))}">${esc(T('burst.toLimit'))}</button></span>` : '';
    return head(margin, action) + `<div class="burst-view"><section aria-label="${esc(T('burst.backlog'))}"><h2>${esc(todo.length ? T('burst.backlogPicked', { picked, n: todo.length }) : T('burst.backlogDone'))}</h2>${rows ? `<div class="rows">${rows}</div>` : `<p class="empty">${esc(T('burst.empty'))}</p>`}
${todo.length ? `<div class="line">${advanceFields()}<span>${esc(T('burst.advanceRules'))}</span></div>` : ''}${S.note ? `<p class="note" role="alert">${esc(S.note)}</p>` : ''}</section>
<div class="folds">${lastFold(last)}${autoFold()}</div></div>`;
  };

  // ---- the gestures
  document.addEventListener('click', async (e) => {
    const t = e.target.closest && e.target.closest('#burstToggle, #burstSend, #burstStop, [data-burst-create], [data-burst-autooff]'); if (!t) return;
    if (t.dataset.burstAutooff !== undefined) { const r = await api('/api/project/settings', { project: S.project, autoBurst: null }); S.note = r.error || ''; if (r.settings) S.settings = r.settings; rerender(); return; }
    if (t.id === 'burstToggle') { S.open = !S.open; if (S.open) await load(S.project); else rerender(); return; }
    // a word in every case (phase 11, G): the tasks written, or why not; the focus stays on the screen's first control
    if (t.dataset.burstCreate) { const r = await api('/api/project/backlog', { project: S.project, from: t.dataset.burstCreate }); S.note = r.error || T('burst.created', { n: Array.isArray(r.tasks) ? r.tasks.length : 0 }); S.picked = null; await load(S.project); const f = document.querySelector('[data-burst-task]:not([disabled]), [data-burst-create]'); if (f) f.focus(); return; }
    if (t.id === 'burstSend') {
      const capUsd = Number(document.getElementById('burstCap').value); const u = document.getElementById('burstUntil');
      const until = u ? untilIso(u.value) : undefined; if (u && !until) { S.note = T('burst.untilPast'); rerender(); return; }
      const r = await api('/api/burst', { project: S.project, tasks: [...(S.picked || [])], capUsd, ...(until ? { until } : {}) });
      if (r.error) { S.note = r.error; rerender(); return; }
      S.note = ''; await load(S.project); location.hash = '#rafale'; return; // i18n-ok
    }
    if (t.id === 'burstStop' && active()) { await api(`/api/burst/${q(active().id)}/stop`, {}); return load(S.project); }
  });
  document.addEventListener('change', async (e) => {
    const el = e.target;
    if (el.dataset && el.dataset.burstTask) { const n = Number(el.dataset.burstTask); if (el.checked) S.picked.add(n); else S.picked.delete(n); const b = document.getElementById('burstSend'); const h2 = document.querySelector('.burst-view h2'); const todo = (S.backlog?.tasks || []).filter((t) => !t.done).length; if (b) b.disabled = !S.picked.size; const w = document.getElementById('burstWhy'); if (w) w.hidden = !!S.picked.size; if (h2) h2.textContent = T('burst.backlogPicked', { picked: S.picked.size, n: todo }); return; }
    if (el.id === 'burstCap') { S.cap = Number(el.value); return; }
    if (el.id === 'burstUntil') { S.until = el.value; return; }
  });
  // A running burst refreshes itself every 5 s while its view or the sheet is open
  setInterval(() => { if (S.project && active() && (S.open || location.hash === '#rafale')) load(S.project); }, 5000); // i18n-ok

  if (window.escadrilleI18n) window.escadrilleI18n.onChange(() => { if (S.project) load(S.project); }); // the journal comes from the server
  window.escadrilleBurst = { sheet, view, load, is: () => location.hash === '#rafale' /* i18n-ok */, onRender: (fn) => { rerender = fn; } };
})();
