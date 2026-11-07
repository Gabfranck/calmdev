// Retire a plan from the screen (docs/flot.md, « Retirer un plan »): one confirmation that says what stops, then a toast
// « Plan retiré · Annuler » (Annuler = POST /api/plan/:id/reopen). Shared by the plan page and the home.
//   escadrilleRetire.ask({ id, title, running: [ids], cost }, onChange)   the confirmation, then the call and the toast
//   escadrilleRetire.reopen(id, onChange)                                 the inverse, no toast
//   escadrilleRetire.sectionHtml(list)                                    « Retirés (n) », a <details> closed by default
(() => {
  const T = (k, v) => window.T(k, v);
  const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  const post = async (url, body) => { const r = await fetch(url, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body || {}) }); const j = await r.json().catch(() => ({})); if (!r.ok) throw new Error(j.error || r.status); return j; };
  const money = (n) => (Number.isFinite(n) ? (Math.round(n * 100) / 100).toLocaleString(document.documentElement.lang || 'fr', { minimumFractionDigits: 2, maximumFractionDigits: 2 }) + ' $' : '');

  let toastEl = null; let toastTimer = null;
  const toast = (text, undo) => {
    if (!toastEl) { toastEl = document.createElement('div'); toastEl.className = 'rt-toast'; toastEl.setAttribute('role', 'status'); document.body.appendChild(toastEl); }
    clearTimeout(toastTimer);
    toastEl.innerHTML = `<span>${esc(text)}</span>${undo ? `<button type="button" class="rt-undo">${esc(T('retire.undo'))}</button>` : ''}`;
    toastEl.hidden = false;
    const b = toastEl.querySelector('.rt-undo'); if (b) b.onclick = () => { toastEl.hidden = true; undo(); };
    toastTimer = setTimeout(() => { toastEl.hidden = true; }, 8000);
  };

  const reopen = async (id, onChange) => { await post(`/api/plan/${encodeURIComponent(id)}/reopen`); onChange && onChange('reopened'); };

  const ask = ({ id, title, running = [], cost = null }, onChange) => {
    const d = document.createElement('dialog'); d.className = 'rt-dialog'; d.setAttribute('aria-labelledby', 'rt-h');
    const body = running.length ? T('retire.confirmStop', { n: running.length, list: running.join(', ') }) : T('retire.confirmIdle');
    d.innerHTML = `<form method="dialog"><h2 id="rt-h">${esc(T('retire.confirmTitle', { title }))}</h2><p>${esc(body)}</p>${Number.isFinite(cost) && cost > 0 ? `<p class="rt-cost">${esc(T('retire.running', { n: running.length, cost: money(cost) }))}</p>` : ''}<p class="rt-err" hidden></p><div class="rt-acts"><button type="submit" value="cancel" class="btn">${esc(T('plan.cancel'))}</button><button type="button" class="btn danger" data-go>${esc(T('retire.confirm'))}</button></div></form>`;
    document.body.appendChild(d);
    d.addEventListener('close', () => d.remove());
    d.querySelector('[data-go]').onclick = async (e) => {
      e.target.disabled = true;
      try { await post(`/api/plan/${encodeURIComponent(id)}/retire`, {}); d.close(); onChange && onChange('retired'); toast(T('retire.done'), () => reopen(id, onChange).catch((x) => toast(String(x.message || x)))); }
      catch (x) { const p = d.querySelector('.rt-err'); p.textContent = String(x.message || x); p.hidden = false; e.target.disabled = false; }
    };
    d.showModal(); d.querySelector('[data-go]').focus();
  };

  const sectionHtml = (list) => (list && list.length ? `<details class="rt-section"><summary>${esc(T('retire.section', { n: list.length }))}</summary><ul>${list.map((p) => `<li><span class="rt-t">${esc(p.title)}</span><span class="rt-m">${esc(p.closedWhy || '')}${p.closedAt ? ' · ' + esc(String(p.closedAt).slice(0, 10)) : ''}</span>${p.archived ? '' : `<button type="button" class="card-link" data-reopen="${esc(p.id)}">${esc(T('retire.reopen'))}</button>`}</li>`).join('')}</ul></details>` : '');

  window.escadrilleRetire = { ask, reopen, toast, sectionHtml };
})();
