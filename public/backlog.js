// The backlog page (public/backlog.html, docs/backlog-page.md): GET /api/project/backlog/doc draws the file's sections
// and lines; every gesture is one POST that names the line and its text, and the answer is the file read again.
(function (root) {
  const doc = root.document; const T = (k, v) => (root.T ? root.T(k, v) : k);
  const $ = (id) => doc.getElementById(id);
  const esc = (s) => String(s ?? '').replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
  const params = new URLSearchParams(root.location.search);
  let project = params.get('project') || root.localStorage?.getItem('escadrille.project') || null;
  let state = null; let picking = null;
  const fail = (m) => { $('error').textContent = m; $('error').hidden = !m; };
  const say = (m) => { $('note').textContent = m; $('note').hidden = !m; };
  const api = async (p, body) => {
    const r = await fetch(p, body ? { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ project, ...body }) } : undefined);
    const j = await r.json().catch(() => ({})); if (!r.ok) throw new Error(j.error || r.status); return j;
  };
  const row = (it) => `<li class="${it.done ? 'done' : ''}" data-line="${it.line}">
    <input type="checkbox" ${it.done ? 'checked' : ''} aria-label="${esc(T('bl.check'))}" data-do="toggle">
    <div><div class="t" data-do="expand">${esc(it.text)}</div>${it.attached ? `<a class="att" href="/plan/${encodeURIComponent(it.attached.plan)}">${esc(T('bl.attached', { s: it.attached.session, p: (state.plans.find((p) => p.id === it.attached.plan) || {}).title || it.attached.plan }))}</a>` : ''}</div>
    ${it.done ? '' : `<div class="tools"><button class="btn ghost" data-do="up" aria-label="${esc(T('bl.up'))}" title="${esc(T('bl.up'))}">↑</button><button class="btn ghost" data-do="down" aria-label="${esc(T('bl.down'))}" title="${esc(T('bl.down'))}">↓</button>${it.attached ? '' : `<button class="btn ghost" data-do="plan">${esc(T('bl.toPlan'))}</button>`}</div>`}
  </li>`;
  const block = (items) => {
    const open = items.filter((x) => !x.done); const done = items.filter((x) => x.done);
    return `${open.length ? `<ul>${open.map(row).join('')}</ul>` : ''}${done.length ? `<details class="folded"><summary>${esc(T('bl.done', { n: done.length }))}</summary><ul>${done.map(row).join('')}</ul></details>` : ''}`;
  };
  const draw = () => {
    const s = state; const base = String(project || '').split('/').filter(Boolean).pop() || '';
    $('where').textContent = s.file || '';
    if (!s.exists) { $('sub').textContent = base; $('list').innerHTML = `<p class="src">${esc(T('bl.none'))}</p>`; return; }
    $('sub').textContent = `${base} · ${T('bl.open', { n: s.items.filter((x) => !x.done).length })}`;
    const groups = [{ sec: null, items: s.items.filter((x) => x.section < 0) }, ...s.sections.map((sec, i) => ({ sec, items: s.items.filter((x) => x.section === i) }))];
    $('list').innerHTML = groups.filter((g) => g.items.length || (g.sec && g.sec.level === 2)).map((g) => {
      const h = g.sec ? (g.sec.level === 2 ? `<h2>${esc(g.sec.text)}</h2>` : `<h3>${esc(g.sec.text)}</h3>`) + (g.sec.link ? `<p class="src">${esc(g.sec.link)}</p>` : '') : '';
      return `<section class="${g.sec && g.sec.level === 3 ? 'sub' : ''}">${h}${block(g.items)}</section>`;
    }).join('');
  };
  const load = async () => {
    try { state = await api('/api/project/backlog/doc?project=' + encodeURIComponent(project || '')); draw(); } catch (e) { return fail(e.message); }
    const pick = params.get('pick'); const it = pick != null && state.items.find((x) => x.line === Number(pick)); // ?pick=<line>: the choice of plan opened (a link from elsewhere)
    if (it && !it.done && !it.attached && !$('pick').open) openPick(it);
  };
  const itemOf = (el) => { const li = el.closest('li'); return li && state.items.find((x) => x.line === Number(li.dataset.line)); };
  const edit = async (body) => { fail(''); try { state = await api('/api/project/backlog/edit', body); draw(); } catch (e) { fail(e.message); load(); } };

  $('list').addEventListener('click', (ev) => {
    const el = ev.target.closest('[data-do]'); if (!el) return; const it = itemOf(el); if (!it) return; const d = el.dataset.do;
    if (d === 'expand') el.closest('li').classList.toggle('open');
    else if (d === 'toggle') edit({ op: 'toggle', line: it.line, md: it.md });
    else if (d === 'up' || d === 'down') edit({ op: 'move', line: it.line, md: it.md, dir: d });
    else if (d === 'plan') openPick(it);
  });
  $('form').addEventListener('submit', (ev) => { ev.preventDefault(); const v = $('idea').value.trim(); if (!v) return; edit({ op: 'add', text: v }).then(() => { $('idea').value = ''; }); });

  // « Ajouter à un plan »: the plans in progress, the closest one chosen, one click to add
  const openPick = async (it) => {
    fail(''); say(''); picking = it;
    let r; try { r = await api(`/api/project/backlog/nearest?project=${encodeURIComponent(project || '')}&line=${it.line}`); } catch (e) { return fail(e.message); }
    $('pickLine').textContent = it.text;
    $('plans').innerHTML = r.plans.length ? r.plans.map((p, i) => `<label><input type="radio" name="plan" value="${esc(p.id)}" ${i === 0 ? 'checked' : ''}><span><b>${esc(p.title)}</b><small>${i === 0 && p.score > 0 ? `<span class="best">${esc(T('bl.nearest'))}</span> · ` : ''}${esc(p.why)}</small></span></label>`).join('') : `<p class="src">${esc(T('bl.noPlan'))}</p>`;
    $('pickGo').disabled = !r.plans.length;
    $('pick').showModal();
  };
  $('pick').addEventListener('close', async () => {
    if ($('pick').returnValue !== 'go' || !picking) return;
    const plan = ($('plans').querySelector('input:checked') || {}).value; if (!plan) return;
    try { const r = await api('/api/project/backlog/attach', { line: picking.line, md: picking.md, plan }); state = r; draw(); say(T('bl.made', { s: r.session, w: r.wave })); } catch (e) { fail(e.message); load(); }
  });

  if (project) load();
  else fetch('/api/escadrilles').then((r) => r.json()).then((escs) => { project = root.escadrilleProjects ? root.escadrilleProjects.current({ search: '', stored: null, escadrilles: Array.isArray(escs) ? escs : [] }) : null; load(); }).catch(load);
})(window);
