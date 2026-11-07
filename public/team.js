// Escadrille en équipe (docs/team.md): the « Équipe » screen (#equipe, group Projet) and the « Équipe » block of the
// project settings (Accès → Réglages, #acces-equipe). Everything comes from GET /api/team: the setting (never the
// token, only whether one is stored), the relay's status, the colleagues and their sessions, the collisions, the team's
// memory lines. The screen's one question: is anyone about to step on anyone? Its biggest block answers it: the
// collisions, or « Personne ne marche sur les pieds de personne ». One primary action: « Régler le partage » when it is
// off; nothing filled when it is on (talking to a colleague is the developer's gesture, not a button).
// Colour only on data: a collision in the warning pair, a member's pale tint on their initial, the relay's state.
(() => {
  const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  const T = (k, v) => window.T(k, v);
  const api = (p, body) => fetch(p, body ? { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) } : undefined).then(async (r) => ({ status: r.status, ...(await r.json().catch(() => ({}))) })).catch((e) => ({ status: 0, error: e.message }));
  const q = (p) => encodeURIComponent(p);
  const withProject = (href, project) => { if (!project) return href; const [p, h] = String(href).split('#'); return `${p}${p.includes('?') ? '&' : '?'}project=${q(project)}${h !== undefined ? '#' + h : ''}`; };
  const S = { project: null, data: null, loading: false, tokenMode: '' /* '', 'replace', 'clear' */, licMode: '' /* the same for the Team key */, test: null /* { busy, line, level } */ };
  let rerender = () => {};

  // ---------------------------------------------------------------- people, time, words
  // each person a stable initial on a pale tint of their own hue (the app-screens rule): the hue from the name
  const hue = (name) => { let h = 7; for (const c of String(name)) h = (h * 31 + c.codePointAt(0)) % 360; return h; };
  const initial = (name) => { const s = String(name || '?').trim(); return s ? [...s][0].toUpperCase() : '?'; };
  const avatar = (name) => `<span class="tm-av" style="--h:${hue(name)}" aria-hidden="true">${esc(initial(name))}</span>`;
  // « à l’instant », « il y a 3 min », « il y a 2 h »
  const ago = (iso) => { const t = Date.parse(iso || ''); if (!t) return ''; const s = Math.max(0, Math.round((Date.now() - t) / 1000)); if (s < 45) return T('team.agoNow'); if (s < 3600) return T('team.agoMin', { n: Math.max(1, Math.round(s / 60)) }); if (s < 86400) return T('team.agoH', { n: Math.round(s / 3600) }); return T('team.agoD', { n: Math.round(s / 86400) }); };
  const statusWord = (st) => (['running', 'waiting', 'paused', 'todo', 'later', 'done'].includes(st) ? T('team.st.' + st) : String(st || ''));
  const STATUS_PILL = { running: 'pos', waiting: 'wait', paused: '' };
  const files = (list, max = 12) => { const l = Array.isArray(list) ? list : []; if (!l.length) return `<span class="tm-dim">${esc(T('team.noFiles'))}</span>`; return `<span class="tm-files">${l.slice(0, max).map((f) => `<code>${esc(f)}</code>`).join('')}${l.length > max ? `<span class="tm-dim">${esc(T('team.moreFiles', { n: l.length - max }))}</span>` : ''}</span>`; };
  const KINDS = { file: 'team.kindFile', migrations: 'team.kindMigrations', area: 'team.kindArea' };
  const threadHref = (c) => withProject(`/plan/${q(c.ours.plan)}?node=${q(c.ours.id)}`, S.project);
  const sessionsOf = (m) => (Array.isArray(m.sessions) ? m.sessions : []);
  // the Escadrille Équipe licence (docs/vente/licence.md) in one line; lic = the license of GET /api/team
  const licLine = (lic) => { const l = lic || {}; if (l.state === 'valid') return T(l.kind === 'trial' ? 'team.lic.trial' : 'team.lic.valid', { team: l.team, seats: l.seats, expires: l.expires }); if (['expired', 'revoked', 'invalid'].includes(l.state)) return T('team.lic.' + l.state, { expires: l.expires }); return T('team.lic.none'); };
  const readOnly = (d) => !!(d && d.on && d.license && d.license.write === false);
  const stateLevel = (st) => (!st || st.state === 'ok' ? '' : st.state === 'offline' || st.state === 'starting' ? 't-warn' : st.state === 'off' ? '' : 't-neg');

  // ---------------------------------------------------------------- styles: the app's tokens only
  if (typeof document !== 'undefined' && document.head) {
    const css = document.createElement('style');
    css.textContent = `.tm-av { display: inline-flex; align-items: center; justify-content: center; width: 24px; height: 24px; border-radius: 50%; flex: none; font-size: 12px; font-weight: 600; color: hsl(var(--h) 45% 28%); background: hsl(var(--h) 60% 90%); }
[data-theme="dark"] .tm-av { color: hsl(var(--h) 70% 82%); background: hsl(var(--h) 35% 24%); }
@media (prefers-color-scheme: dark) { :root:not([data-theme="light"]) .tm-av { color: hsl(var(--h) 70% 82%); background: hsl(var(--h) 35% 24%); } }
.tm-lead { padding: 20px var(--card-pad); border-radius: var(--radius-card); background: var(--raised); margin-bottom: 32px; max-width: 980px; }
.tm-lead.warn { background: var(--pill-warning-bg); }
.tm-lead h2 { font-size: var(--fs-section); font-weight: 600; margin: 0 0 4px; }
.tm-lead.warn h2 { color: var(--pill-warning-ink); }
.tm-lead > p { margin: 0; color: var(--muted); }
.tm-lead .tm-calm { font-size: var(--fs-section); font-weight: 600; color: var(--text); }
.tm-cols { display: grid; gap: 12px; margin: 14px 0 0; padding: 0; list-style: none; }
.tm-col { display: grid; grid-template-columns: 24px minmax(0, 1fr) auto; gap: 12px; align-items: start; }
.tm-col .tm-what { line-height: 22px; } .tm-col .tm-what b { font-weight: 600; }
.tm-col .tm-why { color: var(--muted); line-height: 20px; margin-top: 2px; }
.tm-col .tm-files { margin-top: 6px; }
.tm-col .btn { white-space: nowrap; }
.tm-sec { margin-top: 32px; max-width: 980px; } .tm-sec:first-of-type { margin-top: 0; }
.tm-sec > h2 { font-size: var(--fs-section); font-weight: 600; margin-bottom: 10px; }
.tm-row > summary { grid-template-columns: 12px 24px auto minmax(0, 1fr) auto; }
.tm-row > summary .tm-name { font-weight: 600; }
.tm-row > summary .tm-ago { color: var(--muted); font-variant-numeric: tabular-nums; white-space: nowrap; }
.tm-row .acc-detail { grid-template-columns: minmax(0, 1fr); padding-left: calc(var(--card-pad) + 48px); }
.tm-ses { display: grid; gap: 4px; padding: 6px 0; } .tm-ses + .tm-ses { border-top: 1px solid var(--rule); }
.tm-ses .tm-ses-h { display: flex; gap: 10px; align-items: center; flex-wrap: wrap; } .tm-ses .tm-ses-h b { font-weight: 600; }
.tm-ses .tm-branch { color: var(--muted); overflow-wrap: anywhere; }
.tm-files { display: inline-flex; gap: 4px 6px; flex-wrap: wrap; align-items: center; }
.tm-files code, .tm-col code { font-family: var(--mono); font-size: 13px; background: var(--ground); padding: 1px 5px; border-radius: 4px; }
.tm-lead.warn code { background: var(--surface); }
.tm-dim { color: var(--muted); }
.tm-band { max-width: 980px; margin: 0 0 16px; padding: 8px var(--card-pad); border-radius: var(--radius-card); background: var(--pill-warning-bg); color: var(--pill-warning-ink); }
.tm-fold { margin-top: 24px; max-width: 980px; color: var(--muted); } .tm-fold > summary { cursor: pointer; } .tm-fold > summary:hover { color: var(--text); }
.tm-fold ul { margin: 8px 0 0; padding-left: 18px; color: var(--text); line-height: 22px; }
.tm-fold .tm-mem { list-style: none; padding: 0; } .tm-fold .tm-mem li { display: grid; grid-template-columns: 24px minmax(0, 1fr); gap: 10px; align-items: start; padding: 4px 0; } .tm-fold .tm-mem .tm-dim { font-size: var(--fs-small); }
.tm-empty { color: var(--muted); padding: 4px 0; }
.tm-never { margin: 2px 0 0; padding-left: 18px; color: var(--muted); } .tm-never li { line-height: 20px; }
.psettings .tm-test { display: flex; gap: 10px; align-items: center; flex-wrap: wrap; } .psettings .tm-test .btn { height: 28px; font-size: var(--fs-small); }
.psettings .tm-never-fold > summary { cursor: pointer; color: var(--muted); } .psettings .tm-never-fold > summary:hover { color: var(--text); }
@media (max-width: 860px) { .tm-col { grid-template-columns: 24px minmax(0, 1fr); } .tm-col .btn { grid-column: 2; justify-self: start; } .tm-row .acc-detail { padding-left: var(--card-pad); } }`;
    document.head.appendChild(css);
  }

  // ---------------------------------------------------------------- the data
  const load = async (project) => {
    S.project = project || null; if (!S.project) { S.data = null; rerender(); return; }
    S.loading = true; const p = S.project;
    const d = await api('/api/team?project=' + q(p)); if (S.project !== p) return;
    S.loading = false; S.data = d.error ? { error: d.error } : d; rerender();
  };
  const sync = async () => { if (!S.project) return; const d = await api('/api/team/sync', { project: S.project }); if (!d.error) S.data = d; rerender(); };

  // ---------------------------------------------------------------- the screen
  const head = (sub, cls = '') => `<div class="title-row"><div><h1>${esc(T('team.title'))}</h1><p class="sub ${cls}">${sub}</p></div></div>`;
  const never = () => `<ul class="tm-never">${[1, 2, 3, 4, 5].map((k) => `<li>${esc(T('team.never' + k))}</li>`).join('')}</ul>`;
  const neverFold = (cls = 'tm-fold') => `<details class="${cls}"><summary>${esc(T('team.neverTitle'))}</summary>${never()}</details>`;
  // the collisions: one line per pair, the colleague first, every file at the end, « Ouvrir le fil » to our session
  const collision = (c) => `<li class="tm-col">${avatar(c.member)}<div><div class="tm-what">${T('team.colLine', { member: `<b>${esc(c.member)}</b>`, file: `<code>${esc(c.file)}</code>`, theirs: esc(c.theirs.title || c.theirs.id) })}</div><div class="tm-why">${esc(T('team.colWhy', { kind: T(KINDS[c.kind] || KINDS.file), ours: c.ours.title || c.ours.id, status: statusWord(c.ours.status) }))}${c.theirs.branch ? ` · ${esc(c.theirs.branch)}` : ''}</div>${(c.files || []).length > 1 ? `<div class="tm-files-wrap">${files(c.files)}</div>` : ''}</div><a class="btn" href="${esc(threadHref(c))}">${esc(T('team.openThread'))}</a></li>`;
  const lead = (d) => {
    const cols = Array.isArray(d.collisions) ? d.collisions : []; const members = Array.isArray(d.members) ? d.members : [];
    const nSes = members.reduce((n, m) => n + sessionsOf(m).length, 0);
    if (cols.length) return `<section class="tm-lead warn" aria-labelledby="tm-lead-h"><h2 id="tm-lead-h">${esc(T('team.collisions', { n: cols.length }))}</h2><p>${esc(T('team.collisionsHow'))}</p><ul class="tm-cols">${cols.map(collision).join('')}</ul></section>`;
    return `<section class="tm-lead" aria-labelledby="tm-lead-h"><h2 id="tm-lead-h" class="tm-calm">${esc(T('team.calm'))}</h2><p>${esc(members.length ? T('team.calmHow', { members: T('team.nMembers', { n: members.length }), sessions: T('team.nSessions', { n: nSes }) }) : T('team.calmAlone'))}</p></section>`;
  };
  const session = (s) => `<div class="tm-ses"><div class="tm-ses-h"><b>${esc(s.title || s.id)}</b><span class="pill ${STATUS_PILL[s.status] || ''}">${esc(statusWord(s.status))}</span>${s.since ? `<span class="tm-dim">${esc(T('team.since', { ago: ago(s.since) }))}</span>` : ''}</div>${s.branch ? `<div class="tm-branch">${esc(s.branch)}</div>` : ''}<div>${files(s.files)}${(s.areas || []).length ? ` <span class="tm-dim">· ${esc(T('team.areas', { list: s.areas.join(', ') }))}</span>` : ''}</div></div>`;
  const member = (m) => { const ses = sessionsOf(m); const line = ses.length ? `${esc(T('team.nSessions', { n: ses.length }))} · ${ses.map((s) => esc(s.title || s.id)).join(', ')}` : esc(T('team.noSession'));
    return `<details class="acc-row tm-row" id="tm-${esc(String(m.member).replace(/\W+/g, '-'))}"><summary data-jk>${avatar(m.member)}<span class="tm-name">${esc(m.member)}</span><span class="acc-line">${line}</span><span class="tm-ago">${esc(ago(m.at))}</span></summary><dl class="acc-detail"><dd>${ses.length ? ses.map(session).join('') : `<span class="tm-dim">${esc(T('team.noSessionLong'))}</span>`}</dd></dl></details>`; };
  const memoryFold = (d) => { const lines = d.memory && Array.isArray(d.memory.lines) ? d.memory.lines : []; if (!lines.length) return '';
    return `<details class="tm-fold"><summary>${esc(T('team.memoryLine', { n: lines.length }))}${d.memory.file ? ` · <span title="${esc(d.memory.file)}">${esc(d.memory.file.split('/').slice(-2).join('/'))}</span>` : ''}</summary><ul class="tm-mem">${lines.slice(-20).reverse().map((l) => `<li>${avatar(l.member)}<span><span class="tm-dim">${esc(l.at)} · ${esc(l.member)}</span><br>${esc(l.line)}</span></li>`).join('')}</ul></details>`; };
  const view = () => {
    if (!S.project) return head(esc(T('team.noProject')));
    const d = S.data; if (!d) return head(esc(T('team.loading')));
    if (d.error) return head(esc(d.error), 't-neg');
    const settingsHref = withProject('/#acces-equipe', S.project);
    if (!d.on) return head(esc(T('team.offSub'))) + `<section class="tm-lead" aria-labelledby="tm-lead-h"><h2 id="tm-lead-h">${esc(T('team.offTitle'))}</h2><p>${esc(T('team.offHow'))}</p>${d.license && !d.license.write ? `<p class="tm-dim" data-team-lic>${esc(licLine(d.license))}</p>` : ''}<p style="margin-top:14px"><a class="btn primary" href="${esc(settingsHref)}">${esc(T('team.setUp'))}</a></p></section>${neverFold()}`;
    const st = d.status || {}; const members = Array.isArray(d.members) ? d.members : [];
    const sub = `<b>${esc(T('team.onWord'))}</b> · ${esc(d.member || '')}${st.line ? ` · <span class="${stateLevel(st)}">${esc(st.line)}</span>` : ''}${st.at ? ` · ${esc(ago(st.at))}` : ''} · <a href="${esc(settingsHref)}">${esc(T('team.settings'))}</a>`;
    return head(sub) + (readOnly(d) ? `<p class="tm-band" role="status" data-team-lic>${esc(licLine(d.license))}</p>` : '') + lead(d)
      + `<section class="tm-sec" aria-labelledby="tm-members-h"><h2 id="tm-members-h">${esc(T('team.members'))}</h2>${members.length ? `<div class="acc">${members.map(member).join('')}</div>` : `<p class="tm-empty">${esc(st.state === 'ok' ? T('team.nobody') : T('team.nobodyYet'))}</p>`}</section>`
      + memoryFold(d) + neverFold();
  };

  // ---------------------------------------------------------------- the settings block (index.html's form, one Enregistrer)
  // the token is never sent back: the field is empty, and when one is stored the block says so with Remplacer and Effacer
  const settingsBlock = () => {
    const d = S.data && !S.data.error ? S.data : null; const t = d || { relay: null, member: null, on: false, token: false };
    const tokenField = `<label>${esc(T('team.token'))}<input class="control" name="teamToken" type="password" autocomplete="off" spellcheck="false" placeholder="m-…" aria-describedby="teamTokenWhere"></label>`;
    const tokenRow = !t.token || S.tokenMode === 'replace' ? tokenField + (t.token ? `<button type="button" class="card-link" data-team-token="">${esc(T('team.keepToken'))}</button>` : '')
      : S.tokenMode === 'clear' ? `<p class="pset-key">${esc(T('team.tokenCleared'))} · <button type="button" class="card-link" data-team-token="">${esc(T('set.cancel'))}</button></p>`
      : `<p class="pset-key">${esc(T('team.tokenStored'))} · <button type="button" class="card-link" data-team-token="replace">${esc(T('set.replace'))}</button> · <button type="button" class="card-link" data-team-token="clear">${esc(T('set.erase'))}</button></p>`;
    const test = S.test ? `<span role="status" class="${S.test.level === 'bad' ? 't-neg' : S.test.level === 'warn' ? 't-warn' : 'note'}">${esc(S.test.line)}</span>` : '';
    // the Team key (machine-wide, never sent back): its line when one is stored, with Remplacer and Effacer, like the token
    const lic = (d && d.license) || { state: 'none' }; const licStored = lic.state !== 'none';
    const licField = `<label>${esc(T('team.lic.field'))}<input class="control" name="teamLicense" autocomplete="off" spellcheck="false" placeholder="ESC1.…" aria-describedby="teamLicWhere"></label>`;
    const licRow = !licStored || S.licMode === 'replace' ? licField + (licStored ? `<button type="button" class="card-link" data-team-lic-mode="">${esc(T('team.lic.keep'))}</button>` : '')
      : S.licMode === 'clear' ? `<p class="pset-key">${esc(T('team.lic.cleared'))} · <button type="button" class="card-link" data-team-lic-mode="">${esc(T('set.cancel'))}</button></p>`
      : `<p class="pset-key${lic.write ? '' : ' t-warn'}">${esc(licLine(lic))} · <button type="button" class="card-link" data-team-lic-mode="replace">${esc(T('set.replace'))}</button> · <button type="button" class="card-link" data-team-lic-mode="clear">${esc(T('set.erase'))}</button></p>`;
    return `<fieldset class="pset" data-block="team"><legend>${esc(T('team.title'))}</legend>
    <p class="note">${esc(T('team.scope1'))}<br>${esc(T('team.scope2'))}</p>
    <details class="tm-never-fold"><summary>${esc(T('team.neverTitle'))}</summary>${never()}</details>
    <label>${esc(T('team.relay'))}<input class="control" name="teamRelay" type="url" inputmode="url" autocomplete="off" spellcheck="false" value="${esc(t.relay || '')}" placeholder="https://relais.exemple.fr"></label>
    <label>${esc(T('team.member'))}<input class="control" name="teamMember" autocomplete="off" spellcheck="false" value="${esc(t.member || '')}" placeholder="${esc(T('team.memberPh'))}"></label>
    ${tokenRow}<p class="note" id="teamTokenWhere">${esc(T('team.tokenWhere'))}</p>
    ${licRow}<p class="note" id="teamLicWhere">${esc(T('team.lic.where'))}</p>
    <label class="acheck"><input type="checkbox" name="teamOn"${t.on ? ' checked' : ''}> ${esc(T('team.share'))}</label>
    <div class="tm-test"><button type="button" class="btn" data-team-test${S.test && S.test.busy ? ' disabled' : ''}>${esc(T(S.test && S.test.busy ? 'team.testing' : 'team.test'))}</button>${test}</div></fieldset>`;
  };
  // what changed in the form, as POST /api/team wants it; null when nothing of the team changed
  const changes = (form) => {
    const d = S.data && !S.data.error ? S.data : { relay: null, member: null, on: false, token: false };
    const v = (k) => { const el = form.querySelector(`[name=${k}]`); return el ? el.value.trim() : null; };
    const body = {};
    const relay = v('teamRelay'); if (relay !== null && relay !== (d.relay || '')) body.relay = relay || null;
    const member = v('teamMember'); if (member !== null && member !== (d.member || '')) body.member = member || null;
    const tok = v('teamToken'); if (S.tokenMode === 'clear') body.token = null; else if (tok) body.token = tok;
    const on = form.querySelector('[name=teamOn]'); if (on && on.checked !== !!d.on) body.on = on.checked;
    return Object.keys(body).length ? body : null;
  };
  // called by index.html's saveSettings before the rest: { ok } or { error }; nothing sent when nothing changed
  const save = async (form, project) => {
    // the Team key first (POST /api/license, machine-wide): switching on in the same save needs it
    const licEl = form.querySelector('[name=teamLicense]'); const licKey = licEl ? licEl.value.trim() : ''; let licChanged = false;
    if (licKey || S.licMode === 'clear') {
      const l = await api('/api/license', { key: licKey || null }); if (l.error) return { error: l.status === 403 ? T('team.guardOnly') : l.error };
      S.licMode = ''; licChanged = true; if (S.data && !S.data.error) S.data = { ...S.data, license: l };
    }
    const body = changes(form); if (!body) { if (licChanged) await load(project); return { ok: true, changed: licChanged }; }
    if (body.relay === null && !('on' in body)) body.on = false; // no relay, no sharing
    const r = await api('/api/team', { project, ...body });
    if (r.error) return { error: r.status === 403 ? T('team.guardOnly') : r.error };
    S.data = r; S.tokenMode = ''; return { ok: true, changed: true };
  };
  // « Tester »: the relay of the field answers GET /v1/health from this browser (the relay allows it, docs/team.md); when
  // the sharing is on, the server's own round trip too (the token checked, the colleagues counted)
  const test = async (form) => {
    const relay = (form.querySelector('[name=teamRelay]') || {}).value?.trim?.() || '';
    S.test = { busy: true, line: T('team.testing'), level: '' }; rerender();
    if (!relay) { S.test = { busy: false, line: T('team.testNoRelay'), level: 'warn' }; rerender(); return S.test; }
    let base; try { base = new URL(relay); } catch { S.test = { busy: false, line: T('team.testBadUrl'), level: 'bad' }; rerender(); return S.test; }
    let line, level = '';
    try {
      const r = await fetch(base.origin + base.pathname.replace(/\/+$/, '') + '/v1/health', { signal: AbortSignal.timeout(5000) });
      const j = await r.json().catch(() => null);
      if (r.ok && j && j.ok) line = T('team.testOk', { version: j.version || '?' }); else { line = T('team.testHttp', { status: r.status }); level = 'bad'; }
    } catch (e) { line = T('team.testOffline', { why: e && e.name === 'TimeoutError' ? T('team.testTimeout') : T('team.testNoAnswer') }); level = 'bad'; }
    if (S.data && S.data.on && !level) { const d = await api('/api/team/sync', { project: S.project }); if (!d.error) { S.data = d; const st = d.status || {}; line += ' · ' + (st.line || ''); if (st.state !== 'ok') level = st.state === 'offline' ? 'warn' : 'bad'; } }
    S.test = { busy: false, line, level }; rerender(); return S.test;
  };
  if (typeof document !== 'undefined') {
    document.addEventListener('click', (e) => {
      const t = e.target && e.target.closest ? e.target : null; if (!t) return;
      const tb = t.closest('[data-team-token]'); if (tb) { S.tokenMode = tb.dataset.teamToken; rerender(); const k = document.querySelector('[name=teamToken]'); if (k && S.tokenMode === 'replace') k.focus(); return; }
      const lm = t.closest('[data-team-lic-mode]'); if (lm) { S.licMode = lm.dataset.teamLicMode; rerender(); const k = document.querySelector('[name=teamLicense]'); if (k && S.licMode === 'replace') k.focus(); return; }
      const tt = t.closest('[data-team-test]'); if (tt) { const f = tt.closest('form'); if (f) test(f); }
    });
  }

  window.escadrilleTeam = { view, load, sync, settingsBlock, save, test, changes, licLine, ago, hue, initial, is: () => location.hash === '#equipe' /* i18n-ok */, onRender: (fn) => { rerender = fn; }, state: S };
})();
