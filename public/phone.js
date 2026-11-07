// « Appareils » (the phone and the postes, docs/studio.md), one folded line in the sidebar of both pages (index.html and plan.html), above « Sur ce Mac »:
// how many phones are paired; unfolded, the LAN address, « Nouveau code » (the 6 digits, large, and the time
// left), and the paired devices with « Oublier ». GET /api/devices, refreshed by the page's SSE `change`
// (escadrillePhone.load) and every 30 s. A server without the route hides the block.
(() => {
  const root = document.getElementById('phone'); if (!root) return;
  const esc = (s) => String(s ?? '').replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
  const T = (k, v) => (window.T ? window.T(k, v) : k);
  const since = (iso) => { const t = Date.parse(iso); if (!Number.isFinite(t)) return T('time.neverSeen'); const m = Math.max(0, Math.round((Date.now() - t) / 60000));
    return m < 1 ? T('time.now') : m < 60 ? T('time.agoMin', { n: m }) : m < 48 * 60 ? T('time.agoH', { n: Math.floor(m / 60) }) : T('time.agoD', { n: Math.floor(m / 1440) }); };
  let data = null; let code = null; let tick = null; const busy = new Set();
  const left = () => { const s = Math.max(0, Math.round((Date.parse(code.expires) - Date.now()) / 1000)); return s <= 0 ? T('phone.expired') : s < 60 ? T('phone.leftS', { n: s }) : T('phone.leftMin', { n: Math.ceil(s / 60) }); };
  const render = () => { const sum = root.querySelector('summary'); const body = root.querySelector('.phone-body');
    if (!data) { sum.textContent = T('phone.noAnswer'); body.innerHTML = ''; return; }
    const n = data.devices.length;
    sum.textContent = T('phone.summary', { n });
    const codeRow = code ? `<div class="phone-code"><code>${esc(code.code.slice(0, 3))} ${esc(code.code.slice(3))}</code><span class="m" data-left>${esc(left())}</span></div>${code.kind === 'poste' ? `<p class="m">${esc(T('phone.posteHint', { url: data.address || 'http://…:3078' }))}</p>` : ''}` : '';
    const row = (d) => `<li data-id="${esc(d.id)}"><span class="k">${esc(d.name)}${d.kind === 'poste' ? esc(T('phone.poste')) : ''}</span><button type="button" class="stop" data-forget ${busy.has(d.id) ? 'disabled' : ''}>${esc(T(busy.has(d.id) ? 'phone.forgetting' : 'phone.forget'))}</button><span class="m">${esc(since(d.last_seen))}${d.kind === 'poste' ? '' : esc(T(d.push ? 'phone.push' : 'phone.noPush'))}</span></li>`;
    body.innerHTML = data.lan
      ? `<p class="m" title="${esc(T('phone.addressTitle'))}">${esc(data.address || T('phone.noLan'))}</p><button type="button" class="btn phone-new" data-new>${esc(T(code ? 'phone.otherCode' : 'phone.newCode'))}</button> <button type="button" class="btn phone-new" data-poste>${esc(T('phone.posteCode'))}</button>${codeRow}${n ? `<ul class="mac-list">${data.devices.map(row).join('')}</ul>` : ''}`
      : `<p class="m">${esc(T('phone.relaunch'))}</p>${n ? `<ul class="mac-list">${data.devices.map(row).join('')}</ul>` : ''}`; };
  const countdown = () => { clearInterval(tick); tick = setInterval(() => { const el = root.querySelector('[data-left]'); if (!el) return; el.textContent = left(); if (Date.parse(code.expires) < Date.now()) { clearInterval(tick); code = null; render(); } }, 1000); };
  // 403: a poste (docs/studio.md), the pairing stays to the Studio; the line hides
  // the code in force comes with the list: a reload, or the other page, shows the same one
  const load = async () => { try { const r = await fetch('/api/devices'); if (r.status === 404 || r.status === 403) { root.hidden = true; return; } data = await r.json(); root.hidden = false; if (data.code && data.code.code !== code?.code) { code = data.code; countdown(); } if (!data.code) code = null; } catch (e) { data = null; } render(); };
  if (location.hash === '#phone') root.open = true;
  const post = (p, body) => fetch(p, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body || {}) }).then((r) => r.json()).catch((e) => ({ error: e.message }));
  root.addEventListener('click', async (e) => {
    if (e.target.closest('[data-new]') || e.target.closest('[data-poste]')) { const r = await post('/api/pair/code', e.target.closest('[data-poste]') ? { kind: 'poste' } : {}); if (r.code) { code = r; countdown(); } render(); return; }
    const f = e.target.closest('[data-forget]'); if (f) { const id = f.closest('li').dataset.id; busy.add(id); render(); await post(`/api/devices/${encodeURIComponent(id)}/forget`); busy.delete(id); await load(); } });
  // a device paired with the current code: the code is used, the list grows
  window.escadrillePhone = { load };
  if (window.escadrilleI18n) window.escadrilleI18n.onChange(render);
  load(); setInterval(() => { if (!document.hidden) load(); }, 30000); // a hidden tab asks nothing (docs/perf.md)
})();
