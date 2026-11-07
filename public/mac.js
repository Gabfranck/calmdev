// « Sur ce Mac », the same block in the sidebar of both pages (index.html and plan.html): what
// Escadrille runs on this Mac (sessions, dev servers, worktrees), each with Arrêter, a « Tout arrêter »,
// and, read only, the other claude processes, so no agent runs unseen. GET /api/running, refreshed by
// the page's SSE `change` (it calls escadrilleMac.load) and every 30 s. A server without the route
// hides the block. With data-project on #mac (the page's project), only that project's rows show, with
// a « Tout le Mac » line that lifts the filter; « Tout arrêter » still stops all of it, and says so.
(() => {
  const root = document.getElementById('mac'); if (!root) return;
  const esc = (s) => String(s ?? '').replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
  const T = (k, v) => (window.T ? window.T(k, v) : k);
  const since = (iso) => { const t = Date.parse(iso); if (!Number.isFinite(t)) return ''; const m = Math.max(0, Math.round((Date.now() - t) / 60000));
    return m < 1 ? T('time.now') : m < 60 ? T('time.forMin', { n: m }) : m < 48 * 60 ? (m % 60 && m < 600 ? T('time.forHM', { n: Math.floor(m / 60), m: String(m % 60).padStart(2, '0') }) : T('time.forH', { n: Math.floor(m / 60) })) : T('time.forD', { n: Math.floor(m / 1440) }); };
  const planShort = (id) => String(id || '').replace(/^\d{4}-\d{2}-\d{2}-/, '');
  // a devenv row (docs/devenv.md): the project's environment ENV: up started, named by its folder; Arrêter runs the declared down
  const what = (r) => T(r.kind === 'devserver' ? 'mac.devserver' : r.kind === 'worktree' ? 'mac.worktree' : r.kind === 'devenv' ? 'mac.devenv' : 'mac.session', { s: r.kind === 'devenv' ? String(r.cwd || '').split('/').filter(Boolean).pop() || r.session : r.session });
  const key = (r) => [r.kind, r.plan, r.session].join('\u0001');
  const modelName = (m) => { const s = String(m).toLowerCase(); const f = ['fable', 'opus', 'sonnet', 'haiku'].find((x) => s.includes(x)); return f ? f[0].toUpperCase() + f.slice(1) : String(m); };
  let data = null; let all = false; let arming = null; let armTimer = null; const busy = new Set();
  const render = () => { const sum = root.querySelector('summary'); const body = root.querySelector('.mac-body');
    if (!data) { sum.textContent = T('mac.noAnswer'); body.innerHTML = ''; return; }
    const scope = all ? '' : root.dataset.project || ''; const every = data.ours || []; const ours = scope ? every.filter((r) => r.project === scope) : every; const hidden = every.length - ours.length; const others = data.others || []; const n = (k) => ours.filter((r) => r.kind === k).length;
    const parts = [n('session') && T('mac.sessions', { n: n('session') }), n('devserver') && T('mac.devservers', { n: n('devserver') }), n('devenv') && T('mac.devenvs', { n: n('devenv') }), n('worktree') && T('mac.worktrees', { n: n('worktree') })].filter(Boolean);
    sum.textContent = T(data.host ? 'mac.summaryHost' : 'mac.summary', { what: parts.join(', ') || T(scope ? 'mac.nothingProject' : 'mac.nothingRunning'), host: data.host || '' });
    // a session: its name leads to it (the thread in its plan); under it, project · model · what it is doing or waits for
    const label = (r) => r.kind === 'session' ? `<a href="/plan/${encodeURIComponent(r.plan)}?node=${encodeURIComponent(r.session)}">${esc(what(r))}</a>` : esc(what(r));
    const state = (r) => r.status === 'waiting' ? T('mac.waits') : r.status === 'paused' ? T('mac.paused') : r.status === 'running' || r.status === 'thinking' ? T('mac.working') : '';
    // what it waits for leads the line under the name (the narrow sidebar cut it at the end), then model, project, age
    const meta = (r) => r.kind !== 'session' ? '' : [state(r), r.model ? modelName(r.model) : '', String(r.project || '').split('/').filter(Boolean).pop(), since(r.since)].filter(Boolean).join(' · ');
    const row = (r) => `<li data-key="${esc(key(r))}"><span class="k" title="${esc(r.cwd)}">${label(r)}${r.kind === 'session' ? '' : ` <span class="since">· ${esc(since(r.since))}</span>`}</span><button type="button" class="stop" data-stop ${busy.has(key(r)) ? 'disabled' : ''}>${esc(T(busy.has(key(r)) ? 'mac.stopping' : 'mac.stop'))}</button>${(r.kind === 'devserver' || r.kind === 'devenv') && r.url ? `<span class="m"><a href="${esc(r.url)}" target="_blank" rel="noopener">${esc(r.url.replace(/^https?:\/\//, ''))}</a></span>` : ''}${meta(r) ? `<span class="m" title="${esc(r.waiting || '')}">${esc(meta(r))}</span>` : ''}</li>`;
    const plans = [...new Set(ours.map((r) => r.plan))];
    const groups = plans.map((pl) => `<p class="mac-plan" title="${esc(pl)}">${esc(planShort(pl))}</p><ul class="mac-list">${ours.filter((r) => r.plan === pl).map(row).join('')}</ul>`).join('');
    // the other servers listening on the Mac (a second Escadrille on 3079, a project's dev server started by hand), read only
    const servers = data.servers || []; const folder = (p) => String(p || '').split('/').filter(Boolean).pop() || '';
    const server = (s) => `<li><span class="k"><a href="${esc(s.url || `http://localhost:${s.port}`)}" target="_blank" rel="noopener">:${esc(s.port)}</a>${since(s.since) ? ` <span class="since">· ${esc(since(s.since))}</span>` : ''}</span><span class="m" title="${esc(s.args || s.command || '')}">${esc(folder(s.project) || folder(s.cwd) || s.args || s.command || '')}</span></li>`;
    const other = (o) => `<li><span class="k">pid ${esc(o.pid)} · ${esc(since(o.since))}</span><span class="m" title="${esc(o.args || '')}">${esc(String(o.cwd || '').split('/').filter(Boolean).pop() || o.cwd)}</span></li>`;
    body.innerHTML = `${ours.length ? `${groups}<button type="button" class="btn mac-all" data-stop-all>${esc(arming ? T('mac.confirmAll', { n: every.length }) : hidden ? T('mac.stopAllMac', { n: every.length }) : T('mac.stopAll'))}</button>` : `<p class="m">${esc(T(scope && hidden ? 'mac.emptyProject' : 'mac.empty'))}</p>`}
      ${scope && hidden ? `<button type="button" class="mac-scope" data-scope>${esc(T('mac.wholeMac', { n: hidden }))}</button>` : !scope && root.dataset.project ? `<button type="button" class="mac-scope" data-scope>${esc(T('mac.thisProject'))}</button>` : ''}
      ${servers.length ? `<p class="mac-others">${esc(T('mac.servers', { n: servers.length }))}</p><ul class="mac-list ro">${servers.map(server).join('')}</ul>` : ''}
      <p class="mac-others">${esc(T('mac.others', { n: others.length }))}</p>${others.length ? `<ul class="mac-list ro">${others.map(other).join('')}</ul>` : ''}`; };
  const load = async () => { try { const r = await fetch('/api/running'); if (r.status === 404) { root.hidden = true; return; } data = await r.json(); root.hidden = false; } catch (e) { data = null; } render(); if (data && window.EscadrilleLive && window.EscadrilleLive.use) window.EscadrilleLive.use(data); }; // the top bar's count reads this same answer
  const post = (p, body) => fetch(p, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body || {}) }).then((r) => r.json()).catch((e) => ({ error: e.message }));
  root.addEventListener('click', async (e) => {
    if (e.target.closest('[data-scope]')) { all = !all; render(); return; }
    const st = e.target.closest('[data-stop]'); if (st) { const k = st.closest('li').dataset.key; const r = (data.ours || []).find((x) => key(x) === k); if (!r) return; busy.add(k); render(); await post('/api/running/stop', { kind: r.kind, plan: r.plan, session: r.session, project: r.project }); busy.delete(k); await load(); return; }
    if (e.target.closest('[data-stop-all]')) { if (!arming) { arming = true; render(); clearTimeout(armTimer); armTimer = setTimeout(() => { arming = null; render(); }, 4000); return; }
      arming = null; clearTimeout(armTimer); await post('/api/running/stop-all'); await load(); } });
  window.escadrilleMac = { load };
  if (window.escadrilleI18n) window.escadrilleI18n.onChange(render);
  load(); setInterval(() => { if (!document.hidden) load(); }, 30000); // a hidden tab asks nothing (docs/perf.md)
})();
