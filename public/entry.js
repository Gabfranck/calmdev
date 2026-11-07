// L'entrée « Escadrille » (docs/entry.md): one thread for every project. The developer writes; the server recognises the
// project (lib/entry.mjs), passes the request to its main conversation and the answers come back here with the project's pill.
//   escadrilleEntry.mount(root, { call })   call(path, body?) → JSON; the page passes fetch, the board a fixture
// Every visible text goes through the dictionaries (entry.*).
(function (root) {
  const T = (k, v) => (root.T ? root.T(k, v) : k);
  const esc = (s) => String(s ?? '').replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
  const paras = (t) => String(t || '').trim().split(/\n{2,}/).map((p) => `<p>${esc(p).replace(/\n/g, '<br>')}</p>`).join('');
  const time = (iso) => { const d = new Date(iso); return Number.isFinite(d.getTime()) ? (root.T && root.T.time ? root.T.time(d) : d.toTimeString().slice(0, 5)) : ''; };
  const initial = (name) => esc(String(name || '?').replace(/^[^\p{L}\p{N}]+/u, '').slice(0, 1).toUpperCase() || '?');
  const projectHref = (p) => '/?project=' + encodeURIComponent(p);

  // The project's pill: a <details> whose menu is « pas ce projet », the other projects, the current one inert
  const pick = (m, projects, label) => `<details class="en-pick" data-seq="${m.seq}"><summary aria-label="${esc(T('entry.pickAria', { name: label }))}"><span class="en-ini" aria-hidden="true">${initial(label)}</span>${esc(label)}</summary>
    <div class="en-menu" role="menu"><p>${esc(T(m.project ? 'entry.notThis' : 'entry.notGeneral'))}</p>${projects.map((p) => `<button type="button" role="menuitem" data-choose="${esc(p.project)}" data-seq="${m.seq}" ${p.project === m.project ? 'aria-current="true" disabled' : ''}><span class="en-ini" aria-hidden="true">${initial(p.name)}</span>${esc(p.name)}</button>`).join('')}</div></details>`;

  const request = (m, projects) => {
    const dev = `<div class="en-dev">${esc(m.text)}</div><div class="en-dev-time">${esc(time(m.at))}</div>`;
    if (m.status === 'routing') return `${dev}<div class="en-routing" aria-live="polite">${esc(T('entry.routing'))}</div>`;
    if (m.status === 'ask') {
      const [a, b] = m.choices;
      const others = projects.filter((p) => !m.choices.some((c) => c.project === p.project));
      return `${dev}<section class="en-ask" aria-labelledby="ask-${m.seq}"><h2 id="ask-${m.seq}">${esc(T('entry.ask'))}</h2><p class="en-why">${esc(T('entry.askWhy'))}</p>
        <div class="en-btns">${a ? `<button type="button" class="btn primary" data-choose="${esc(a.project)}" data-seq="${m.seq}" data-first="1">${esc(a.name)}</button>` : ''}${b ? `<button type="button" class="btn" data-choose="${esc(b.project)}" data-seq="${m.seq}">${esc(b.name)}</button>` : ''}
        ${others.length ? `<details class="en-pick" data-seq="${m.seq}"><summary>${esc(T('entry.other'))}</summary><div class="en-menu" role="menu">${others.map((p) => `<button type="button" role="menuitem" data-choose="${esc(p.project)}" data-seq="${m.seq}"><span class="en-ini" aria-hidden="true">${initial(p.name)}</span>${esc(p.name)}</button>`).join('')}</div></details>` : ''}</div></section>`;
    }
    const label = m.project ? m.name : T('entry.general');
    const meta = `<div class="en-meta">${pick(m, projects, label)}<span>${esc(T('entry.how.' + (m.how || 'general')))}</span>${m.project ? `<a class="en-open" href="${esc(projectHref(m.project))}">${esc(T('entry.open', { name: m.name }))}</a>` : ''}</div>`;
    const replies = m.status === 'general'
      ? (m.answer ? `<div class="en-reply">${paras(m.answer)}</div>` : '')
      : (m.replies || []).map((r) => (r.role === 'claude' ? `<div class="en-reply">${paras(r.text)}</div>` : `<p class="en-sys">${esc(r.text)}</p>`)).join('');
    const wait = m.waiting ? `<p class="en-wait${m.pilotOff ? ' off' : ''}" aria-live="polite">${esc(T(m.pilotOff ? 'entry.pilotOff' : 'entry.waiting', { name: m.name }))}</p>` : '';
    return `${dev}${meta}${replies}${wait}`;
  };

  // The thread, oldest first, the newest at the foot next to the composer
  const html = (data) => {
    const msgs = [...(data.messages || [])].reverse();
    if (!msgs.length) return `<p class="en-empty">${esc(T('entry.empty'))}</p>`;
    return (data.more ? `<button type="button" class="btn en-more" data-more="1">${esc(T('entry.more'))}</button>` : '')
      + msgs.map((m) => `<article class="en-req" data-seq="${m.seq}">${request(m, data.projects || [])}</article>`).join('');
  };

  const mount = (el, { call, poll = true } = {}) => {
    const thread = el.querySelector('.en-thread'); const form = el.querySelector('form'); const box = form.querySelector('textarea');
    const btn = form.querySelector('button[type="submit"]'); const err = el.querySelector('.en-err');
    let data = { messages: [], projects: [], more: false }; let older = []; let timer = null; let focusedAsk = null;
    const draw = () => {
      const open = [...thread.querySelectorAll('details[open]')].map((d) => d.dataset.seq);
      const all = { ...data, messages: [...data.messages, ...older], more: older.length ? older.more : data.more };
      thread.innerHTML = html(all);
      for (const s of open) thread.querySelector(`details[data-seq="${s}"]`)?.setAttribute('open', '');
      const ask = thread.querySelector('.en-req:last-child [data-first]');
      if (ask && focusedAsk !== ask.dataset.seq && document.activeElement !== box) { ask.focus(); focusedAsk = ask.dataset.seq; }
      else if (ask) focusedAsk = ask.dataset.seq;
    };
    const busy = () => data.messages.some((m) => m.status === 'routing' || (m.waiting && !m.pilotOff));
    const load = async () => {
      try { data = await call('/api/entry'); err.textContent = ''; draw(); } catch (e) { err.textContent = T('entry.loadError', { e: e.message }); }
      if (poll) { clearTimeout(timer); timer = setTimeout(load, busy() ? 4000 : 30000); }
    };
    const send = async () => {
      const text = box.value.trim(); if (!text || btn.disabled) return;
      btn.disabled = true; btn.textContent = T('entry.sending');
      data.messages = [{ seq: -1, text, status: 'routing', at: new Date().toISOString() }, ...data.messages]; draw();
      try { await call('/api/entry', { text }); box.value = ''; err.textContent = ''; } catch (e) { err.textContent = T('entry.error', { e: e.message }); }
      btn.disabled = false; btn.textContent = T('entry.send'); load(); box.focus();
    };
    form.addEventListener('submit', (e) => { e.preventDefault(); send(); });
    box.addEventListener('keydown', (e) => { if (e.key === 'Enter' && !e.shiftKey && !e.isComposing) { e.preventDefault(); send(); } });
    thread.addEventListener('click', async (e) => {
      const c = e.target.closest('[data-choose]');
      if (c && !c.disabled) { c.closest('details')?.removeAttribute('open'); try { await call('/api/entry/choose', { seq: Number(c.dataset.seq), project: c.dataset.choose }); } catch (x) { err.textContent = T('entry.error', { e: x.message }); } return load(); }
      if (e.target.closest('[data-more]')) {
        const last = [...data.messages, ...older].pop(); if (!last) return;
        const page = await call('/api/entry?before=' + last.seq); older = [...older, ...page.messages]; older.more = page.more; draw();
      }
    });
    // Échap closes an open menu and gives the focus back to its pill; a click elsewhere closes it
    el.addEventListener('keydown', (e) => { if (e.key !== 'Escape') return; const d = e.target.closest('details[open]'); if (d) { d.removeAttribute('open'); d.querySelector('summary').focus(); } });
    document.addEventListener('click', (e) => { for (const d of thread.querySelectorAll('details[open]')) if (!d.contains(e.target)) d.removeAttribute('open'); });
    document.addEventListener('visibilitychange', () => { if (!document.hidden) load(); });
    load();
    return { load, draw: (d) => { data = d; draw(); } };
  };

  root.escadrilleEntry = { html, mount };
})(typeof window !== 'undefined' ? window : globalThis);
