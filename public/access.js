// The access view (docs/access.md, docs/phase9/direction.md §6): three sections on one screen. « Le projet » first
// (the path, the branch, the commits, the guidance files, the memory, the skills: GET /api/project, flat), then the
// five rows of GET /api/access, each folded to one line that opens on its detail, then « Réglages » (the project's
// settings form of index.html, flattened by the styles below: one Enregistrer, nothing else is set elsewhere).
// Read only here: no control of this file changes anything. Colour sits on the data (the pill of each row, an open
// domain, a command run outside the sandbox), never on the chrome.
(() => {
  const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  const T = (k, v) => window.T(k, v);
  const n = (k, key) => T(key, { n: k });
  const fmt = (x) => window.T.num(Number(x || 0));
  const day = (iso) => { const d = new Date(iso); return isNaN(d) ? '' : window.T.date(d); };
  const hm = (iso) => { const d = new Date(iso); return isNaN(d) ? '' : window.T.time(d); };
  const PILL = { green: 'pos', amber: 'warn', red: 'neg' };
  const pill = (level, word) => `<span class="pill ${PILL[level] || ''}">${esc(word)}</span>`;
  const code = (s) => `<code>${esc(s)}</code>`;
  const list = (items, empty = T('access.none')) => (items.length ? `<ul class="acc-list">${items.map((i) => `<li>${i}</li>`).join('')}</ul>` : `<span class="acc-none">${esc(empty)}</span>`);
  const codes = (items) => `<div class="acc-codes">${items.map(code).join('')}</div>`;
  const kv = (k, v) => `<dt>${esc(k)}</dt><dd>${v}</dd>`;
  const row = (id, name, line, level, word, body) => `<details class="acc-row" id="acc-${id}"><summary data-jk><span class="acc-name">${esc(name)}</span><span class="acc-line">${line}</span>${pill(level, word)}</summary><dl class="acc-detail">${body}</dl></details>`;

  // the sections' styles (app.css is frozen in this wave): a 16/600 title, 32 px between sections; the settings
  // form of index.html read as the last section, open, its summary line replaced by the title « Réglages »
  if (typeof document !== 'undefined' && document.head) {
    const css = document.createElement('style');
    const sheet = () => `.acc-sec { margin-top: 32px; } .acc-sec:first-of-type { margin-top: 0; }
.acc-sec > h2 { font-size: var(--fs-section); font-weight: 600; margin-bottom: 10px; }
.acc-facts { display: grid; margin: 0; max-width: 860px; }
.acc-facts > div { display: grid; grid-template-columns: 148px minmax(0, 1fr); gap: 12px; min-height: 32px; align-items: baseline; padding: 5px 0; }
.acc-facts > div + div { border-top: 1px solid var(--rule); }
.acc-facts dt { color: var(--muted); } .acc-facts dd { margin: 0; min-width: 0; overflow-wrap: anywhere; line-height: 22px; }
.acc-facts dd.dim { color: var(--muted); }
.acc-facts dd .path { font-family: var(--mono); font-size: 13px; }
.acc-facts dd .m { color: var(--muted); }
.lim-form { padding: 12px 0 4px; max-width: 640px; display: grid; gap: 12px; } .lim-form p { margin: 0; }
.lim-scope { display: flex; gap: 20px; } .lim-scope label { display: flex; align-items: center; gap: 6px; }
.lim-table { border-collapse: collapse; width: 100%; } .lim-table th, .lim-table td { text-align: left; padding: 4px 12px 4px 0; font-weight: 400; }
.lim-table thead th { color: var(--muted); font-size: var(--fs-small); font-weight: 500; } .lim-table tbody th { white-space: nowrap; }
.lim-table input { width: 72px; height: 32px; padding: 0 8px; font: inherit; font-variant-numeric: tabular-nums; border: 1px solid var(--control); border-radius: 8px; background: var(--surface); color: var(--text); }
.lim-share { display: flex; align-items: center; gap: 6px; color: var(--muted); } .lim-share input { width: 88px; height: 32px; padding: 0 8px; font: inherit; font-variant-numeric: tabular-nums; border: 1px solid var(--control); border-radius: 8px; background: var(--surface); color: var(--text); }
.lim-actions { display: flex; align-items: center; gap: 12px; } .sr { position: absolute; width: 1px; height: 1px; overflow: hidden; clip: rect(0 0 0 0); }
.psettings { margin-top: 32px; padding: 0; max-width: 860px; }
.psettings form { padding-top: 10px; max-width: 520px; }
.psettings label.check { display: flex; align-items: center; gap: 8px; color: var(--text); } .psettings label.check input { margin: 0; width: 16px; height: 16px; accent-color: var(--accent); }
.dom-explain { margin: 0 0 8px; max-width: 640px; }
.dom-list { list-style: none; margin: 0; padding: 0; max-width: 860px; }
.dom-list li { display: grid; grid-template-columns: minmax(0, 1fr) auto auto; gap: 16px; align-items: center; min-height: 44px; padding: 6px 0; }
.dom-list li + li { border-top: 1px solid var(--rule); }
.dom-list code { font-family: var(--mono); font-size: 13px; overflow-wrap: anywhere; }
.dom-seg { display: inline-flex; border: 1px solid var(--control); border-radius: 8px; overflow: hidden; }
.dom-seg label { position: relative; display: flex; } .dom-seg label + label { border-left: 1px solid var(--control); }
.dom-seg input { position: absolute; opacity: 0; inset: 0; margin: 0; cursor: pointer; }
.dom-seg span { padding: 5px 12px; font-size: var(--fs-small); color: var(--muted); line-height: 20px; white-space: nowrap; }
.dom-seg input:checked + span { background: var(--surface); color: var(--text); font-weight: 600; box-shadow: inset 0 -2px 0 var(--accent); }
.dom-seg input:focus-visible + span { outline: 2px solid var(--accent); outline-offset: -2px; }
.dom-ann { margin: 10px 0 0; }
.dom-add { display: flex; gap: 8px; margin-top: 14px; max-width: 520px; } .dom-add input { flex: 1; min-width: 0; height: 36px; }
.dom-note { margin: 6px 0 0; }
@media (max-width: 600px) { .dom-list li { grid-template-columns: minmax(0, 1fr) auto; } .dom-list .dom-seg { grid-column: 1 / -1; grid-row: 2; justify-self: start; } }
@media (max-width: 860px) { .acc-facts > div { grid-template-columns: minmax(0, 1fr); gap: 2px; padding: 8px 0; } }`;
    css.textContent = sheet(); document.head.appendChild(css);
    if (window.escadrilleI18n) window.escadrilleI18n.onChange(() => { css.textContent = sheet(); });
    // the plan settings are one folded line (« 5,00 $ · Opus 5.5 · sans réseau »): index.html keeps it open across its
    // renders (settingsOpen) until it is closed, by a click or by Escape (public/ux.js); phase 11, G, cause G
  }

  // « Le projet »: GET /api/project?path=, read once per project; the screen redraws when it lands (render() of index.html)
  const facts = new Map();
  const loadFacts = (path) => {
    if (!path || facts.has(path) || typeof fetch === 'undefined') return;
    facts.set(path, null);
    fetch('/api/project?path=' + encodeURIComponent(path)).then((r) => r.json()).catch((e) => ({ error: e.message })).then((f) => { facts.set(path, f); if (typeof render === 'function') render(); });
  };
  const projectSection = (path) => {
    const f = path ? facts.get(path) : null; const kvf = (k, v, dim) => `<div><dt>${esc(k)}</dt><dd class="${dim ? 'dim' : ''}">${v}</dd></div>`;
    let body;
    const D = T('access.folder');
    if (!path) body = kvf(D, esc(T('access.noProject')), true);
    else if (f === undefined || f === null) body = kvf(D, `<span class="path">${esc(path)}</span>`) + kvf('Git', esc(T('access.reading')), true);
    else if (f.error) body = kvf(D, `<span class="path">${esc(path)}</span>`) + kvf('Git', `<span title="${esc(f.error)}">${esc(T('access.unread'))}</span>`, true);
    else body = kvf(D, `<span class="path">${esc(f.path)}</span>`)
      + (f.git ? kvf(T('access.branch'), `${esc(f.branch || '–')} <span class="m">· ${esc(T('access.commits', { n: f.commits || 0 }))}${f.lastWhen ? ` · ${esc(T('access.last'))} <span title="${esc(f.lastCommit || '')}">${esc(f.lastWhen)}</span>` : ''}${f.changed ? ` · ${esc(T('access.changed', { n: f.changed }))}` : ''}</span>`) : kvf('Git', esc(T('access.noGit')), true))
      + kvf(T('access.guidance'), f.docs && f.docs.length ? f.docs.map(esc).join(', ') : esc(T('access.none')), !(f.docs && f.docs.length))
      + kvf(T('access.memory'), esc(f.memories ? T('access.notes', { n: f.memories }) : T('access.empty')), !f.memories)
      + kvf(T('access.skills'), f.skills && f.skills.length ? f.skills.map(esc).join(', ') : esc(T('access.none')), !(f.skills && f.skills.length))
      + (f.pkg ? kvf(T('access.deps'), fmt(f.pkg.deps)) : '');
    return `<section class="acc-sec" aria-labelledby="acc-proj-h"><h2 id="acc-proj-h">${esc(T('access.project'))}</h2><dl class="acc-facts">${body}</dl></section>`;
  };

  // « Limites » (docs/limits.md, GET/POST /api/limits): a soft and a hard threshold per limit, for this project or for the
  // whole Mac. Folded to one line (the thresholds that apply); open, one form per scope, one Enregistrer. A project may
  // only be stricter than the Mac: its placeholder is the Mac's value, the line under each row the value that applies.
  const lims = new Map(); let limScope = 'project'; let limNote = '';
  const loadLims = (path, force) => {
    if (typeof fetch === 'undefined' || (!force && lims.has(path || ''))) return;
    if (!force) lims.set(path || '', null);
    fetch('/api/limits' + (path ? '?project=' + encodeURIComponent(path) : '')).then((r) => r.json()).catch((e) => ({ error: e.message })).then((d) => { lims.set(path || '', d); if (typeof render === 'function') render(); });
  };
  const LIM_KEYS = ['fiveHour', 'weekly', 'model', 'burst', 'plan'];
  const limLabel = (k) => T(k === 'model' ? 'lim.anyModel' : k === 'plan' ? 'lim.plan' : 'lim.' + k);
  // « Part de la semaine » (phase 11 PS): the share of the weekly quota this project's sessions may take, one number;
  // 90 % of it holds new sessions, the share itself pauses them. A project only, never the Mac; empty removes it.
  let shareNote = '';
  const sPct = (x) => window.T.num(x, { maximumFractionDigits: x < 10 ? 1 : 0 }) + '\u202f%';
  const shareWhy = (r) => T(r && r.reason === 'uncalibrated' ? 'lim.shareUncalibrated' : r && r.reason === 'unmeasured' ? 'lim.shareNoReset' : 'lim.shareUnmeasured');
  const shareRow = (d, path) => {
    if (!path) return '';
    const sh = d.share || {}; const max = sh.max; const r = sh.row;
    const used = r && r.pct != null ? `<b>${esc(sPct(r.pct))}</b>` : esc(T('lim.shareUnmeasured'));
    const line = max ? T('lim.shareUsed', { a: used, b: esc(sPct(max)) }) : esc(T('lim.shareNone'));
    const level = !max ? '' : r && r.level === 'hard' ? 'red' : r && r.level === 'soft' ? 'amber' : r && r.pct != null ? 'green' : '';
    const word = !max ? T('access.none') : r && r.level === 'hard' ? T('lim.aboveHard') : r && r.level === 'soft' ? T('lim.aboveSoft') : sPct(max);
    const state = max ? `<p class="acc-muted num">${r && r.pct != null ? esc(T('lim.shareUsed', { a: sPct(r.pct), b: sPct(max) })) + ' · ' + esc(T('lim.shareUsd', { usd: '$' + window.T.num(r.usd || 0, { minimumFractionDigits: 2, maximumFractionDigits: 2 }) })) : esc(shareWhy(r))}</p><p class="acc-muted num">${esc(T('lim.shareSoftWarn', { pct: sPct(Math.round(max * (sh.soft || 0.9) * 10) / 10) }))}</p>` : '';
    return `<details class="acc-row" id="acc-share"${shareNote ? ' open' : ''}><summary data-jk><span class="acc-name">${esc(T('lim.shareName'))}</span><span class="acc-line">${line}</span>${pill(level, word)}</summary>
      <form class="lim-form" data-share-form data-project="${esc(path)}"><p class="acc-muted">${esc(T('lim.shareExplain'))}</p>${state}
      <label class="lim-share"><input type="number" min="1" max="100" step="0.5" inputmode="decimal" name="share" value="${max == null ? '' : esc(max)}" placeholder="${esc(T('lim.sharePh'))}" aria-label="${esc(T('lim.shareAria'))}"> %</label>
      <div class="lim-actions"><button type="submit" class="btn primary">${esc(T('lim.shareSave'))}</button>${shareNote ? ` <span role="status" class="${shareNote.startsWith('!') ? 't-neg' : 'acc-muted'}">${esc(shareNote.replace(/^!/, ''))}</span>` : ''}</div></form></details>`;
  };
  // « Rythme de relecture » (FREIN, Dev 7 Nov., lib/brake.mjs): the finished deliveries not reviewed against a threshold;
  // above it, neither the pilot nor « Avancer le backlog » launches. Folded: the count and the threshold. Open: one number.
  let brakeNote = '';
  const brakeRow = (d, path) => {
    const b = path && d.brake; if (!b) return '';
    const over = b.count > b.threshold;
    const line = esc(T('brake.line', { n: b.count, max: b.threshold }));
    return `<details class="acc-row" id="acc-brake"${brakeNote ? ' open' : ''}><summary data-jk><span class="acc-name">${esc(T('brake.name'))}</span><span class="acc-line">${line}</span>${pill(over ? 'amber' : 'green',T(over ? 'brake.held' : 'brake.free'))}</summary>
      <form class="lim-form" data-brake-form data-project="${esc(path)}"><p class="acc-muted">${esc(T('brake.explain'))}</p>
      <label class="lim-share"><input type="number" min="1" max="999" step="1" inputmode="numeric" name="brake" value="${b.max == null ? '' : esc(b.max)}" placeholder="${esc(b.default)}" aria-label="${esc(T('brake.aria'))}"></label>
      <div class="lim-actions"><button type="submit" class="btn primary">${esc(T('brake.save'))}</button>${brakeNote ? ` <span role="status" class="${brakeNote.startsWith('!') ? 't-neg' : 'acc-muted'}">${esc(brakeNote.replace(/^!/, ''))}</span>` : ''}</div></form></details>`;
  };
  // « Usage » (docs/usage-unit.md, GET/POST /api/unit): one gauge in euros paid. The included week at the subscription
  // price, then the credits at their billed price; the jump between them is the decision (overflow or wait for the reset).
  // Folded: the euros used of the week and what a point costs after. Open: the two prices (Mac settings), the API equivalent.
  let unitData = null; let unitNote = '';
  const loadUnit = (force) => { if (typeof fetch === 'undefined' || (!force && unitData)) return; if (!force) unitData = { loading: true }; fetch('/api/unit').then((r) => r.json()).catch((e) => ({ error: e.message })).then((d) => { unitData = d; if (typeof render === 'function') render(); }); };
  const eur = (x, d = 2) => (x == null ? '—' : window.T.num(x, { style: 'currency', currency: 'EUR', minimumFractionDigits: d, maximumFractionDigits: d }));
  const unitRow = () => {
    loadUnit(); const g = unitData; if (!g || g.loading || g.error) return '';
    const w = g.week || {}; const c = g.credits || {}; const s = g.setting || {};
    const pctTxt = w.pct == null ? T('unit.unread') : sPct(w.pct);
    const head = w.usedEur != null ? T('unit.usedOf', { a: `<b>${esc(eur(w.usedEur))}</b>`, b: esc(eur(w.includedEur)) }) : s.planEurMonth == null ? esc(T('unit.noPlan')) : `<b>${esc(pctTxt)}</b>`;
    const after = c.eurPerPct != null ? ' · ' + esc(T('unit.after', { eur: eur(c.eurPerPct), x: window.T.num(g.jump, { maximumFractionDigits: 1 }) })) : '';
    const level = w.saturated ? (c.using ? 'amber' : 'red') : w.pct != null && w.pct >= 80 ? 'amber' : w.pct != null ? 'green' : '';
    const word = w.saturated ? T(c.using ? 'unit.onCredits' : 'unit.full') : w.leftEur != null ? T('unit.left', { eur: eur(w.leftEur) }) : pctTxt;
    // the bar: the included week fills its track; the credits track after it, filled by what was spent of the monthly limit
    const fill = w.pct == null ? 0 : Math.min(100, w.pct); const cfill = c.spent != null && c.limit ? Math.min(100, (c.spent / c.limit) * 100) : 0;
    const bar = `<div class="unit-gauge"><div class="unit-bar" role="img" aria-label="${esc(T('unit.barAria', { pct: pctTxt }))}"><span class="unit-incl"><i style="width:${fill}%"></i></span><span class="unit-cred${c.enabled === false || c.disabledReason ? ' off' : ''}"><i style="width:${cfill}%"></i></span></div>
      <div class="unit-scale num"><span>${esc(T('unit.included'))} ${esc(eur(w.eurPerPct, 3))}${esc(T('unit.perPt'))}</span><span>${esc(T('unit.credits'))} ${c.eurPerPct != null ? esc(eur(c.eurPerPct)) + esc(T('unit.perPt')) : esc(T('unit.creditUnset'))}</span></div></div>`;
    const credLine = c.spent != null ? T(c.limit != null ? 'unit.spentOf' : 'unit.spent', { a: eur(c.spent), b: eur(c.limit) }) : T('unit.spentUnread');
    const state = c.disabledReason ? T('unit.disabled', { why: c.disabledReason }) : c.using ? T('unit.using') : '';
    const models = Object.entries(g.models || {}).map(([m, v]) => `${esc(m.replace(/^claude-/, ''))} <span class="num">${esc(window.T.usd(v.usdPerPct, 2))}${esc(T('unit.perPt'))} (${esc(window.T.usd(v.low, 2))}–${esc(window.T.usd(v.high, 2))}, n=${v.n})</span>`).join(' · ');
    return `<details class="acc-row" id="acc-unit"${unitNote ? ' open' : ''}><summary data-jk><span class="acc-name">${esc(T('unit.name'))}</span><span class="acc-line">${head}${after}</span>${pill(level, word)}${bar}</summary>
      <form class="lim-form" data-unit-form><p class="acc-muted">${esc(T('unit.explain'))}</p>
      <p class="acc-muted num">${esc(w.apiWeekUsd != null ? T('unit.api', { usd: window.T.usd(w.apiWeekUsd, 0), pt: window.T.usd(w.apiUsdPerPct, 2) }) : T('unit.apiNone'))}</p>
      <p class="acc-muted num">${esc(credLine)}${state ? ' · ' + esc(state) : ''}</p>${models ? `<p class="acc-muted">${esc(T('unit.models'))} ${models}</p>` : `<p class="acc-muted">${esc(T('unit.modelsNone'))}</p>`}
      <div class="unit-set"><label>${esc(T('unit.planLabel'))} <input type="number" min="1" step="1" inputmode="decimal" name="planEurMonth" value="${s.planEurMonth == null ? '' : esc(s.planEurMonth)}" placeholder="180"> €</label>
      <label>${esc(T('unit.creditLabel'))} <input type="number" min="0.01" max="10" step="0.01" inputmode="decimal" name="creditEurPerUsd" value="${s.creditEurPerUsd == null ? '' : esc(s.creditEurPerUsd)}" placeholder="—"> €</label></div>
      <div class="lim-actions"><button type="submit" class="btn primary">${esc(T('unit.save'))}</button>${unitNote ? ` <span role="status" class="${unitNote.startsWith('!') ? 't-neg' : 'acc-muted'}">${esc(unitNote.replace(/^!/, ''))}</span>` : ''}</div></form></details>`;
  };
  // « Domaines signés seul » (docs/apprendre-en-signant.md §5): declared once in the review, kept on the Mac for every
  // project, changed here; one folded line. GET/POST /api/signing.
  let signData = null, signNote = '';
  const loadSign = () => { if (typeof fetch === 'undefined' || signData) return; signData = { loading: true }; fetch('/api/signing').then((r) => r.json()).catch((e) => ({ error: e.message })).then((d) => { signData = d; if (typeof render === 'function') render(); }); };
  const signRow = () => { loadSign(); const d = signData; if (!d || d.loading || d.error || !d.all) return '';
    const line = d.domains ? (d.domains.length ? d.domains.map((x) => T('sign.domain.' + x)).join(' · ') : '—') : T('acc.signNone');
    return `<details class="acc-row" id="acc-sign"${signNote ? ' open' : ''}><summary data-jk><span class="acc-name">${esc(T('acc.sign'))}</span><span class="acc-line">${esc(line)}</span></summary>
      <form class="lim-form" data-sign-form><p class="acc-muted">${esc(T('acc.signHint'))}</p><div class="unit-set">${d.all.map((x) => `<label><input type="checkbox" name="d" value="${x}" ${(d.domains ?? d.recommended).includes(x) ? 'checked' : ''}> ${esc(T('sign.domain.' + x))}</label>`).join('')}</div>
      <div class="lim-actions"><button type="submit" class="btn primary">${esc(T('sign.declareSave'))}</button>${signNote ? ` <span role="status" class="acc-muted">${esc(signNote)}</span>` : ''}</div></form></details>`; };
  if (typeof document !== 'undefined') document.addEventListener('submit', async (e) => {
    const f = e.target.closest && e.target.closest('[data-sign-form]'); if (!f) return; e.preventDefault();
    const domains = [...f.querySelectorAll('input[name=d]:checked')].map((i) => i.value);
    const r = await fetch('/api/signing', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ domains }) }).then((x) => x.json()).catch((er) => ({ error: er.message }));
    if (!r.error) { signData = { ...signData, ...r }; signNote = T('sign.declared'); } if (typeof render === 'function') render();
  });
  if (typeof document !== 'undefined') document.addEventListener('submit', async (e) => {
    const f = e.target; if (!f || !f.matches || !f.matches('[data-unit-form]')) return; e.preventDefault();
    const v = (n) => { const x = f.elements[n].value.trim(); return x === '' ? null : Number(x); };
    const r = await fetch('/api/unit', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ planEurMonth: v('planEurMonth'), creditEurPerUsd: v('creditEurPerUsd') }) }).then((x) => x.json()).catch((er) => ({ error: er.message }));
    unitNote = r.error ? '!' + r.error : T('unit.saved'); if (!r.error) unitData = r; if (typeof render === 'function') render();
  });
  const thr = (t) => (t ? `${t.soft == null ? '–' : t.soft} / ${t.hard == null ? '–' : t.hard} %` : '–');
  const limitsSection = (path) => {
    const d = lims.get(path || ''); loadLims(path);
    if (!d) return `<section class="acc-sec" id="acc-limits" aria-labelledby="acc-lim-h"><h2 id="acc-lim-h">${esc(T('lim.titleAccess'))}</h2><p class="acc-none">${esc(T('access.reading'))}</p></section>`;
    if (d.error) return `<section class="acc-sec" id="acc-limits" aria-labelledby="acc-lim-h"><h2 id="acc-lim-h">${esc(T('lim.titleAccess'))}</h2><p class="t-neg">${esc(d.error)}</p></section>`;
    const scope = path ? limScope : 'mac'; const own = (scope === 'mac' ? d.mac : d.project) || {};
    const under = (k) => (scope === 'mac' ? d.defaults[k] : (d.mac && d.mac[k]) || d.defaults[k]);
    const line = LIM_KEYS.slice(0, 3).map((k) => `${esc(limLabel(k))} <span class="num">${esc(thr(d.effective[k]))}</span>`).join(' · ');
    const input = (k, f) => { const v = own[k] ? own[k][f] : null; const ph = under(k) ? under(k)[f] : null; return `<input type="number" min="1" max="100" step="1" inputmode="numeric" name="${k}.${f}" value="${v == null ? '' : esc(v)}" placeholder="${ph == null ? '' : esc(ph)}" aria-label="${esc(limLabel(k) + ' · ' + T('lim.' + f))}">`; };
    // a threshold with an end date says it (« jusqu'au lun. 9 nov., 20:00 »); its hour come, the server puts the previous one back
    const till = (k) => { const u = own[k] && own[k].until; if (!u) return ''; const t = new Date(u); return isNaN(t) ? '' : ' · ' + T('lim.until', { date: window.T.date(t, { weekday: 'short', day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' }) }); };
    const rows = LIM_KEYS.map((k) => `<tr><th scope="row">${esc(limLabel(k))}</th><td>${input(k, 'soft')}</td><td>${input(k, 'hard')}</td><td class="acc-muted num" data-lim-applies="${k}">${esc(T('lim.applies', { v: thr(d.effective[k]) }) + till(k))}</td></tr>`).join('');
    const scopes = path ? `<div class="lim-scope" role="radiogroup" aria-label="${esc(T('lim.scope'))}"><label><input type="radio" name="limScope" value="project" ${scope === 'project' ? 'checked' : ''}> ${esc(T('lim.thisProject'))}</label><label><input type="radio" name="limScope" value="mac" ${scope === 'mac' ? 'checked' : ''}> ${esc(T('lim.wholeMac'))}</label></div>` : '';
    return `<section class="acc-sec" id="acc-limits" aria-labelledby="acc-lim-h"><h2 id="acc-lim-h">${esc(T('lim.titleAccess'))}</h2><div class="acc">${unitRow()}${signRow()}
      <details class="acc-row" id="acc-lim"${limNote ? ' open' : ''}><summary data-jk><span class="acc-name">${esc(T('lim.thresholds'))}</span><span class="acc-line">${line}</span>${pill('green', T('lim.softHard'))}</summary>
      <form class="lim-form" data-lim-form data-project="${esc(path || '')}"><p class="acc-muted">${esc(T('lim.explain'))}</p>${scopes}
      <table class="lim-table"><thead><tr><th scope="col">${esc(T('lim.limit'))}</th><th scope="col">${esc(T('lim.soft'))}</th><th scope="col">${esc(T('lim.hard'))}</th><th scope="col"><span class="sr">${esc(T('lim.appliesK'))}</span></th></tr></thead><tbody>${rows}</tbody></table>
      <p class="acc-muted">${esc(T(scope === 'mac' ? 'lim.macNote' : 'lim.projectNote'))}</p>
      <div class="lim-actions"><button type="submit" class="btn primary">${esc(T('lim.save'))}</button>${limNote ? ` <span role="status" class="${limNote.startsWith('!') ? 't-neg' : 'acc-muted'}">${esc(limNote.replace(/^!/, ''))}</span>` : ''}</div></form></details>${shareRow(d, path)}${brakeRow(d, path)}</div></section>`;
  };
  if (typeof document !== 'undefined') {
    document.addEventListener('change', (e) => { if (e.target && e.target.name === 'limScope') { limScope = e.target.value; limNote = ''; if (typeof render === 'function') render(); const d = document.getElementById('acc-lim'); if (d) d.open = true; } });
    document.addEventListener('submit', async (e) => {
      const f = e.target; if (!f || !f.matches || !f.matches('[data-brake-form]')) return; e.preventDefault();
      const path = f.dataset.project; const v = f.elements.brake.value.trim(); const brake = v === '' ? null : Number(v);
      const r = await fetch('/api/limits', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ project: path, brake }) }).then((x) => x.json()).catch((er) => ({ error: er.message }));
      brakeNote = r.error ? '!' + r.error : T('brake.saved'); if (!r.error) lims.set(path || '', r); if (typeof render === 'function') render();
      const back = document.querySelector('#acc-brake input[name="brake"]'); if (back) back.focus();
    });
    document.addEventListener('submit', async (e) => {
      const f = e.target; if (!f || !f.matches || !f.matches('[data-share-form]')) return; e.preventDefault();
      const path = f.dataset.project; const v = f.elements.share.value.trim(); const share = v === '' ? null : Number(v);
      const r = await fetch('/api/limits', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ project: path, share }) }).then((x) => x.json()).catch((er) => ({ error: er.message }));
      shareNote = r.error ? '!' + r.error : T(share == null ? 'lim.shareRemoved' : 'lim.shareSaved'); if (!r.error) lims.set(path || '', r); if (typeof render === 'function') render();
      const back = document.querySelector('#acc-share input[name="share"]'); if (back) back.focus();
    });
    document.addEventListener('submit', async (e) => {
      const f = e.target; if (!f || !f.matches || !f.matches('[data-lim-form]')) return; e.preventDefault();
      const path = f.dataset.project || null; const val = (n) => { const x = f.elements[n]; return x && x.value.trim() !== '' ? Number(x.value) : null; };
      const scope = path ? limScope : 'mac'; const d = lims.get(path || '') || {}; const own = (scope === 'mac' ? d.mac : d.project) || {};
      // a timed threshold saved again unchanged keeps its end date (and its previous value, kept by the server)
      const out = {}; for (const k of LIM_KEYS) { const soft = val(k + '.soft'); const hard = val(k + '.hard'); const o = own[k]; out[k] = soft == null && hard == null ? null : o && o.until && o.soft === soft && o.hard === hard ? { soft, hard, until: o.until } : { soft, hard }; }
      const r = await fetch('/api/limits', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ scope, project: path, limits: out }) }).then((x) => x.json()).catch((er) => ({ error: er.message }));
      limNote = r.error ? '!' + r.error : T('lim.saved'); if (!r.error) lims.set(path || '', r); if (typeof render === 'function') render();
    });
  }

  // « Domaines » (docs/access.md): the project's one list, a line per host with who reaches it (Planification · Sessions ·
  // Les deux) and Retirer; one field adds a host (no choice: its default, lib/domains.mjs). A host a plan announces but
  // the list lacks is said in one line with « Autoriser pour le projet » (scope sessions). POST /api/project/domain.
  let domNote = '';
  const SCOPES = ['plan', 'sessions', 'both'];
  const domainsSection = (net, path) => {
    if (!path) return '';
    const L = net.list || [];
    const seg = (e) => `<div class="dom-seg" role="radiogroup" aria-label="${esc(T('dom.scopeAria', { host: e.host }))}">${SCOPES.map((k) => `<label><input type="radio" name="dom:${esc(e.host)}" value="${k}" data-dom-scope="${esc(e.host)}" ${e.scope === k ? 'checked' : ''}><span>${esc(T('dom.scope.' + k))}</span></label>`).join('')}</div>`;
    const rows = L.length ? `<ul class="dom-list">${L.map((e) => `<li><code>${esc(e.host)}</code>${seg(e)}<button type="button" class="card-link" data-dom-remove="${esc(e.host)}">${esc(T('dom.remove'))}</button></li>`).join('')}</ul>` : `<p class="acc-none">${esc(T('dom.none'))}</p>`;
    const ann = (net.announced || []).filter((p) => p.missing.length).map((p) => `<p class="dom-ann"><span class="t-warn">${esc(T('dom.announced', { title: p.title, list: p.missing.join(', ') }))}</span> · ${p.missing.map((h) => `<button type="button" class="card-link" data-dom-allow="${esc(h)}">${esc(T('dom.allow'))}${p.missing.length > 1 ? ' · ' + esc(h) : ''}</button>`).join(' ')}</p>`).join('');
    return `<section class="acc-sec" id="acces-domaines" aria-labelledby="acc-dom-h"><h2 id="acc-dom-h">${esc(T('dom.title'))}</h2>
      <p class="acc-muted dom-explain">${esc(T('dom.explain'))}</p>${rows}${ann}
      <form class="dom-add" data-dom-form data-project="${esc(path)}"><input class="control" name="host" autocomplete="off" spellcheck="false" placeholder="${esc(T('dom.ph'))}" aria-label="${esc(T('dom.addAria'))}"><button type="submit" class="btn primary">${esc(T('dom.add'))}</button></form>
      <p class="acc-muted dom-note" role="status">${esc(domNote.replace(/^!/, '') || T('dom.defaultNote'))}</p></section>`;
  };
  const domPost = async (body) => {
    const path = typeof project !== 'undefined' ? project : null; if (!path) return;
    const r = await fetch('/api/project/domain', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ project: path, ...body }) }).then((x) => x.json()).catch((er) => ({ error: er.message }));
    domNote = r.error ? '!' + r.error : '';
    if (typeof loadAccess === 'function') await loadAccess(); else if (typeof render === 'function') render();
    return r;
  };
  if (typeof document !== 'undefined') {
    document.addEventListener('change', (e) => { const t = e.target; if (t && t.dataset && t.dataset.domScope) domPost({ host: t.dataset.domScope, scope: t.value }); });
    document.addEventListener('click', (e) => {
      const rm = e.target.closest && e.target.closest('[data-dom-remove]'); if (rm) { domPost({ host: rm.dataset.domRemove, remove: true }); return; }
      const al = e.target.closest && e.target.closest('[data-dom-allow]'); if (al) domPost({ host: al.dataset.domAllow, scope: 'sessions', keep: true });
    });
    document.addEventListener('submit', async (e) => {
      const f = e.target; if (!f || !f.matches || !f.matches('[data-dom-form]')) return; e.preventDefault();
      const host = f.elements.host.value.trim(); if (!host) return;
      await domPost({ host }); const back = document.querySelector('.dom-add input[name="host"]'); if (back) back.focus();
    });
  }

  // the autonomy line of the server, its own label dropped (« Autonomie : » or « Autonomy: »)
  const auText = (au) => String(au.line || '').replace(/^[^:]*:\s*/, '');
  const view = (a) => {
    const s = a.sessions; const x = a.extensions; const o = s.outside;
    const asked = o.allowed + o.denied + o.pending;
    const domains = (s.network.list || []).map((e) => e.host);
    // Serveur
    const srv = a.server;
    const srvLine = [srv.lan ? `<b class="t-warn">${esc(T('access.lanOpen'))}</b>` : esc(T('access.macOnly')), n(srv.devices.length, 'access.devices'), esc(srv.push.active ? T('access.pushTo', { s: srv.push.service }) : T('access.pushOff'))].join(' · ');
    const srvBody = kv(T('access.listen'), code(`${srv.host}:${srv.port}`) + (srv.lan && srv.address ? ` · ${esc(T('access.reachable'))} ${code(srv.address)}` : ''))
      + kv(T('access.paired'), list(srv.devices.map((d) => `${esc(d.name)} <span class="acc-muted">${esc(T('access.since', { d: day(d.created) }))}${d.push ? esc(' ' + T('access.getsPush')) : ''}</span>`)))
      + kv(T('access.pushService'), `${esc(srv.push.service)} · ${esc(n(srv.push.tokens, 'access.tokens'))} · ${esc(T(srv.push.key ? 'access.keyStored' : 'access.noKey'))}`);
    // Sessions
    const netWord = domains.length ? `<b class="t-warn">${esc(n(domains.length, 'access.net'))}</b>` : esc(T('access.netClosed'));
    const au = s.autonomy; // L: the autonomy, one line; amber when not Surveillé, or the auto merge on, or K's burst on
    // ENV (docs/devenv.md): the dev environment the project declared, run by the server on a session's ENV: line; « à régler » until set
    const ev = s.devenv || { set: false, commands: [], health: [], accounts: [], tests: [] };
    const sesLine = [`${esc(T('access.sandboxLine'))} ${s.sandbox.enabled ? esc(T('access.on')) : `<b class="t-neg">${esc(T('access.off'))}</b>`}`, esc(T('access.unreadable', { n: s.unreadable.count })), netWord, ...(au && au.amber ? [`<b class="t-warn">${esc(auText(au).split(' · ')[0])}</b>`] : []), ...(au && au.burst ? [`<b class="t-warn">${esc(T('access.burstOn'))}</b>`] : []), ...(asked ? [`<b class="t-warn">${esc(n(asked, 'access.outsideToday'))}</b>`] : []), ...(a.project && !ev.set ? [`<b class="t-warn">${esc(T('access.envUnset'))}</b>`] : [])].join(' · ');
    const auRow = au ? kv(T('access.autonomy'), `<span class="${au.amber ? 't-warn' : ''}">${esc(auText(au))}</span>${au.burst ? `<p class="t-warn">${esc(T('access.burstAuto'))}</p>` : ''}`) : '';
    const none = () => `<span class="acc-none">${esc(T('access.none'))}</span>`;
    const envRow = a.project ? kv(T('access.envK'), ev.set ? `${esc(T('access.envLine', { cmds: ev.commands.join(', ') || T('access.none'), health: ev.health.map((u) => u.replace(/^https?:\/\//, '')).join(', ') || T('access.none'), accounts: ev.accounts.join(', ') || T('access.none'), tests: ev.tests.join(', ') || T('access.none') }))}<p class="acc-muted">${esc(ev.outside || '')}</p>` : `<span class="t-warn">${esc(T('access.envNone'))}</span>`) : '';
    const sesBody = auRow + envRow + kv(T('access.sandbox'), esc(`${T(s.sandbox.enabled ? 'access.on' : 'access.off')}${s.sandbox.failIfUnavailable ? T('access.failIfNone') : ''} · ${T('access.writes', { w: s.sandbox.writes })}${s.sandbox.localBinding ? ' ' + T('access.localPorts') : ''}`))
      + kv(T('access.outside'), asked ? `${esc(T('access.allowedN', { n: o.allowed }))}, ${esc(T('access.deniedN', { n: o.denied }))}${o.pending ? `, ${esc(T('access.pendingN', { n: o.pending }))}` : ''}${list(o.list.map((c) => `<span class="${c.answer === 'allowed' ? 't-warn' : ''}">${esc(T(c.answer === 'allowed' ? 'access.allowed' : c.answer === 'denied' ? 'access.denied' : 'access.pending'))}</span> ${esc(hm(c.at))} · ${esc(c.plan)} / ${esc(c.session)} · ${code(c.command)}`))}` : `<span class="acc-none">${esc(T('access.noAskToday'))}</span>`)
      + kv(T('access.unreadableK'), codes(s.unreadable.denyRead) + codes(s.unreadable.readRules))
      + kv(T('access.stripped'), `${T('access.strippedLine', { keys: '\u0001', keep: '\u0002' }).split('&').join('&amp;').replace('\u0001', code('KEY, TOKEN, SECRET, PASSWORD, CREDENTIAL, PRIVATE')).replace('\u0002', code('CLAUDE_* ANTHROPIC_*'))} ${s.env.stripped.length ? codes(s.env.stripped) : `<span class="acc-none">${esc(T('access.noneHere'))}</span>`}`)
      + kv(T('access.added'), `${codes(Object.entries(s.env.added || {}).map(([k, v]) => `${k}=${v}`))}<p class="acc-muted">${esc(T('access.addedNote'))}</p>`)
      + kv(T('access.network'), domains.length ? `<span class="t-warn">${domains.map(esc).join(', ')}</span> · <a href="#acces-domaines">${esc(T('dom.title'))}</a>` : `<span class="acc-none">${esc(T('access.closed'))}</span>`)
      + kv(T('access.openDirs'), list(s.addDirs.map((d) => `${code(d.dir)} <span class="acc-muted">${esc(d.from)}</span>`)))
      + kv(T('access.plannerTools'), codes(s.tools.planner))
      + kv(T('access.sessionTools'), `${codes(s.tools.sessions)}<p class="acc-muted">${esc(T('access.restAsks'))}</p>`)
      + kv(T('access.deniedCmds'), s.denied.length ? list(Object.entries(s.denied.reduce((m, d) => ((m[d.source] ||= []).push(d.rule), m), {})).map(([src, rules]) => `<span class="acc-muted">${esc(src)}</span>${codes(rules)}`)) : `<span class="acc-none">${esc(T('access.noRule'))}</span>`);
    // Connecteurs et extensions
    const onPlugins = x.plugins.filter((p) => p.enabled); const onMcp = x.mcp.filter((m) => m.enabled);
    // a connector: its name, what it may do, where its key lives, ready or not; amber when ready (a call may go out on a click)
    const conns = x.connectors.map((c) => (typeof c === 'string' ? { name: c } : c));
    const readyN = conns.filter((c) => c.ready).length;
    const extLine = [conns.length ? conns.map((c) => (c.ready ? `<b class="t-warn">${esc(T('access.nameReady', { name: c.name }))}</b>` : esc(T('access.nameNotReady', { name: c.name })))).join(' · ') : esc(T('access.noConnector')), esc(`${n(onPlugins.length, 'access.plugins')}${x.plugins.length > onPlugins.length ? ' ' + n(x.plugins.length - onPlugins.length, 'access.pluginsOff') : ''}`), esc(n(onMcp.length, 'access.mcp'))].join(' · ');
    const extBody = kv(T('access.connectors'), conns.length ? `<ul class="acc-list acc-conns">${conns.map((c) => `<li><span class="acc-dot ${c.ready ? 'warn' : ''}" aria-hidden="true"></span><b>${esc(c.name)}</b> <span class="${c.ready ? 't-warn' : 'acc-muted'}">${esc(T(c.ready ? 'access.ready' : 'access.notReady'))}</span>${c.scope ? ` · ${esc(c.scope)}` : ''}${c.where ? ` <span class="acc-muted">· ${esc(c.where)}</span>` : ''}</li>`).join('')}</ul>` : `<span class="acc-none">${esc(T('access.none'))}</span>`)
      + kv(T('access.pluginsK'), list(x.plugins.map((p) => `${code(p.id)} ${p.enabled ? `<span class="t-warn">${esc(T('access.pluginOn'))}</span>` : `<span class="acc-muted">${esc(T('access.pluginOff'))}</span>`} <span class="acc-muted">${esc(p.source)}</span>`)))
      + kv(T('access.mcpK'), list(x.mcp.map((m) => `${code(m.name)} ${esc(m.type)} · ${esc(m.host || m.command || '')}${m.secret ? esc(' ' + T('access.secret')) : ''} ${m.enabled ? '' : `<span class="acc-muted">${esc(T('access.pluginOff'))}</span>`} <span class="acc-muted">${esc(m.source)}</span>`)))
      + kv(T('access.files'), list(x.files.map(code), T('access.noFile')));
    // Ce qui sort
    // a host a connector reaches is said « sur clic seulement »: nothing leaves on its own
    const onClick = (h) => /sur clic seulement|on click only/i.test([h.why, h.by, h.when].join(' ')); // i18n-ok: the server's words in either language
    const freeOut = a.out.filter((h) => !onClick(h)); const clickOut = a.out.filter(onClick);
    const outLine = a.out.length ? [freeOut.length ? `<b class="t-warn">${freeOut.map((h) => esc(h.host)).join(', ')}</b>` : '', clickOut.length ? `<b class="t-warn">${clickOut.map((h) => esc(h.host)).join(', ')}</b> ${esc(T('access.onClick'))}` : ''].filter(Boolean).join(' · ') : esc(T('access.nothingOut'));
    const outBody = kv(T('access.hosts'), list(a.out.map((h) => `${code(h.host)} <span class="acc-muted">${[h.why, h.by, h.when].filter(Boolean).map(esc).join(' · ')}</span>`), T('access.none')));
    // Ce qui est fermé
    const closedBody = kv(T('access.closedK'), list(a.closed.map(esc)));
    const L = a.summary.level;
    // The one finding, read first: what is open now, in this order; its colour is its own block's level
    const [finding, level] = asked ? [n(asked, 'access.findAsked'), o.allowed ? 'amber' : 'green']
      : freeOut.length ? [T('access.reachableN', { hosts: freeOut.map((h) => h.host).join(', '), n: freeOut.length }), 'amber']
      : !s.sandbox.enabled ? [T('access.findNoSandbox'), 'red']
      : clickOut.length ? [T('access.findClick', { hosts: clickOut.map((h) => h.host).join(', ') }), 'amber']
      : onPlugins.length + onMcp.length ? [T('access.findLoads', { what: ((l) => (l.length > 1 ? T('access.and', { a: l[0], b: l[1] }) : l[0]))([onPlugins.length && n(onPlugins.length, 'access.plugins'), onMcp.length && n(onMcp.length, 'access.mcp')].filter(Boolean)) }), 'amber']
      : [T('access.findClean'), 'green'];
    const path = a.project || (typeof project !== 'undefined' ? project : null); loadFacts(path);
    return `<div class="title-row"><div><h1>${esc(T('access.title'))}</h1><p class="sub"><b class="${level === 'green' ? '' : 't-' + (level === 'red' ? 'neg' : 'warn')}">${esc(finding)}</b> · ${esc(T('access.readAt', { t: hm(a.at) }))}</p></div></div>
    ${projectSection(path)}
    ${domainsSection(s.network, path)}
    ${limitsSection(path)}
    <section class="acc-sec" aria-labelledby="acc-open-h"><h2 id="acc-open-h">${esc(T('access.open'))}</h2><div class="acc">
      ${row('server', T('access.server'), srvLine, L.server, T(srv.lan ? 'access.lan' : 'access.local'), srvBody)}
      ${row('sessions', T('access.sessions'), sesLine, L.sessions, T(!s.sandbox.enabled ? 'access.noSandbox' : L.sessions === 'amber' ? 'access.openings' : 'access.held'), sesBody)}
      ${row('extensions', T('access.connectors'), extLine, L.extensions, T(readyN || onPlugins.length + onMcp.length ? 'access.loaded' : 'access.none'), extBody)}
      ${row('out', T('access.out'), outLine, L.out, a.out.length ? n(a.out.length, 'access.hostsN') : T('access.nothing'), outBody)}
      ${row('closed', T('access.closedRow'), esc(a.closed.join(' · ')), 'green', T('access.closed'), closedBody)}
      ${window.escadrilleFeedback ? window.escadrilleFeedback.row((inner) => `<details class="acc-row" id="acc-retour"><summary data-jk><span class="acc-name">${esc(T('fb.name'))}</span><span class="acc-line">${esc(T('fb.line'))}</span>${pill('green', T('fb.local'))}</summary><div class="fb-box" id="fbBox">${inner}</div></details>`) : ''}
    </div></section>`;
  };
  window.escadrilleAccess = { view };
})();
