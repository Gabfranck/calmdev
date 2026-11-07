// The interaction contract, shared by every page (phase 11, G; docs/phase11/ux.md §2). No dependency, no screen known:
//   escadrilleUX.open(el, { trigger, close, trap, restore })  a layer (panel, sheet, drawer, form in place); Escape closes
//     the last one, calls its close() and gives the focus back to its trigger (or to `restore`, a selector or a function,
//     when a full render replaced the trigger)
//   escadrilleUX.close(el, { focus = true })  the layer leaves the stack (the code closed it another way)
//   escadrilleUX.tip(root)                    the floating tip of [data-tip] (and of [title], moved into data-tip), at
//     hover and at focus, position: fixed above everything, never in the flow
//   escadrilleUX.trap(el)                     the focus turns in el; returns the release
//   escadrilleUX.roving(container, selector, { orientation })  ↑ ↓ (or ← →), Home, End, both ways; one Tab stop
//   escadrilleUX.keys(list)                   the keys of the screen; `?` opens them in a sheet, Escape closes it
//   escadrilleUX.next(i, n, key, orientation) the index the arrows give (pure, tested)
//   escadrilleUX.nearest(rects, i, key)       the nearest box that way on a map (pure, tested)
// Escape, without a layer: an open <details> holding the focus closes on its summary; then an [aria-expanded="true"]
// that has or holds the focus closes and keeps it. In a search field (type=search or data-ux-clear), Escape empties it first.
(function (root) {
  const doc = root.document;
  const T = (k, v) => (root.T ? root.T(k, v) : k);
  const stack = [];
  const typing = (t) => !!t && (t.isContentEditable || /^(INPUT|TEXTAREA|SELECT)$/.test(t.tagName || ''));
  const shown = (el) => !!el && el.isConnected !== false && !el.hidden && (!el.getClientRects || el.getClientRects().length > 0);
  const FOCUSABLE = 'a[href], button:not([disabled]), input:not([disabled]):not([type="hidden"]), select:not([disabled]), textarea:not([disabled]), summary, [tabindex]:not([tabindex="-1"])';
  const focusables = (el) => [...el.querySelectorAll(FOCUSABLE)].filter(shown);
  const focus = (el) => { if (el && el.focus) { el.focus({ preventScroll: false }); return doc && doc.activeElement === el; } return false; };

  // 1. The layers
  const restore = (L) => {
    if (L.trigger && L.trigger.isConnected !== false && shown(L.trigger) && focus(L.trigger)) return;
    const r = typeof L.restore === 'function' ? L.restore() : (L.restore && doc ? doc.querySelector(L.restore) : null);
    if (r && focus(r)) return;
    const box = L.trigger && L.trigger.parentElement; if (box && box.isConnected !== false) { const f = focusables(box)[0]; if (f) focus(f); }
  };
  const find = (el) => stack.findIndex((L) => L.el === el);
  const open = (el, { trigger, close, trap: t = false, restore: r } = {}) => {
    const i = find(el); if (i >= 0) stack.splice(i, 1);
    const L = { el, trigger: trigger === undefined ? (doc ? doc.activeElement : null) : trigger, close, restore: r, release: t ? trap(el) : null };
    stack.push(L); return L;
  };
  const drop = (L) => { const i = stack.indexOf(L); if (i >= 0) stack.splice(i, 1); if (L.release) { L.release(); L.release = null; } };
  const close = (el, { focus: back = true } = {}) => { const i = find(el); if (i < 0) return false; const L = stack[i]; drop(L); if (back) restore(L); return true; };
  // Escape: the last layer still on the page; a layer whose element left the page is forgotten
  const escape = (e) => {
    hideTip();
    const t = e.target;
    if (t && t.tagName === 'INPUT' && (t.type === 'search' || t.hasAttribute('data-ux-clear')) && t.value) {
      t.value = ''; t.dispatchEvent(new root.Event('input', { bubbles: true })); return true;
    }
    while (stack.length) {
      const L = stack[stack.length - 1];
      if (L.el.isConnected === false) { drop(L); continue; }
      drop(L); if (L.close) L.close(); restore(L); return true;
    }
    if (typing(t) && t.value) return false;
    const a = doc.activeElement;
    const d = a && a.closest && a.closest('details[open]');
    if (d) { d.open = false; const s = d.querySelector('summary'); if (s) s.focus(); return true; }
    const x = a && a.closest && a.closest('[aria-expanded="true"]');
    if (x && !x.matches('select, [aria-haspopup="listbox"]')) {
      const id = x.id; const key = [...x.attributes].find((at) => at.name.startsWith('data-'));
      if (x.matches('button, [role="button"]')) x.click();
      let el = x.isConnected ? x : (id ? doc.getElementById(id) : null) || (key ? doc.querySelector(`[${key.name}="${String(key.value).replace(/"/g, '\\"')}"]`) : null);
      if (el && el.getAttribute('aria-expanded') === 'true') {
        el.setAttribute('aria-expanded', 'false');
        for (const c of (el.getAttribute('aria-controls') || '').split(/\s+/).filter(Boolean)) { const p = doc.getElementById(c); if (p) p.hidden = true; }
      }
      if (el) focus(el);
      return true;
    }
    return false;
  };

  // 2. The focus that turns inside a sheet or a drawer
  function trap(el) {
    const on = (e) => {
      if (e.key !== 'Tab') return;
      const f = focusables(el); if (!f.length) { e.preventDefault(); return; }
      const first = f[0]; const last = f[f.length - 1]; const a = doc.activeElement;
      if (e.shiftKey && (a === first || !el.contains(a))) { e.preventDefault(); last.focus(); }
      else if (!e.shiftKey && (a === last || !el.contains(a))) { e.preventDefault(); first.focus(); }
    };
    doc.addEventListener('keydown', on, true);
    return () => doc.removeEventListener('keydown', on, true);
  }

  // 3. The arrows, both ways, never looping
  const KEYS = { vertical: { ArrowDown: 1, ArrowUp: -1 }, horizontal: { ArrowRight: 1, ArrowLeft: -1 }, both: { ArrowDown: 1, ArrowUp: -1, ArrowRight: 1, ArrowLeft: -1 } };
  const next = (i, n, key, orientation = 'vertical') => {
    if (!n) return -1;
    if (key === 'Home') return 0;
    if (key === 'End') return n - 1;
    const d = (KEYS[orientation] || KEYS.vertical)[key]; if (!d) return -1;
    if (i < 0) return d > 0 ? 0 : n - 1;
    return Math.min(n - 1, Math.max(0, i + d));
  };
  // the nearest box in the direction of an arrow (a map: modules, nodes): ahead along the axis, the distance across
  // counted twice; null when nothing lies that way. rects: [{ x, y, w, h }]
  const nearest = (rects, i, key) => {
    const c = (r) => [r.x + r.w / 2, r.y + r.h / 2]; const [x0, y0] = c(rects[i] || {});
    const dir = { ArrowRight: [1, 0], ArrowLeft: [-1, 0], ArrowDown: [0, 1], ArrowUp: [0, -1] }[key]; if (!dir || rects[i] === undefined) return -1;
    let best = -1; let score = Infinity;
    rects.forEach((r, j) => { if (j === i) return; const [x, y] = c(r); const along = (x - x0) * dir[0] + (y - y0) * dir[1]; if (along <= 1) return;
      const across = Math.abs((x - x0) * dir[1]) + Math.abs((y - y0) * dir[0]); const sc = along + 2 * across; if (sc < score) { score = sc; best = j; } });
    return best;
  };
  const roving = (container, selector, { orientation = 'vertical' } = {}) => {
    const items = () => [...container.querySelectorAll(selector)].filter(shown);
    const refresh = () => {
      const all = items(); if (!all.length) return;
      const cur = all.find((el) => el === doc.activeElement) || all.find((el) => el.getAttribute('tabindex') === '0') || all.find((el) => el.matches('[aria-current], [aria-selected="true"]')) || all[0];
      for (const el of all) el.setAttribute('tabindex', el === cur ? '0' : '-1');
    };
    container.addEventListener('keydown', (e) => {
      if (e.metaKey || e.ctrlKey || e.altKey) return;
      const it = e.target.closest && e.target.closest(selector); if (!it || !container.contains(it)) return;
      const all = items(); const j = next(all.indexOf(it), all.length, e.key, orientation); if (j < 0) return;
      e.preventDefault();
      for (const el of all) el.setAttribute('tabindex', el === all[j] ? '0' : '-1');
      all[j].focus(); if (all[j].scrollIntoView) all[j].scrollIntoView({ block: 'nearest' });
    });
    container.addEventListener('focusin', (e) => { const it = e.target.closest && e.target.closest(selector); if (it && container.contains(it)) for (const el of items()) el.setAttribute('tabindex', el === it ? '0' : '-1'); });
    if (root.MutationObserver) new root.MutationObserver(refresh).observe(container, { childList: true, subtree: true });
    refresh();
    return { refresh };
  };

  // 4. The floating tip: one element, outside <body> so it never counts in the page, fixed, 8 px under its element
  let tipEl = null; let tipFor = null; let tipTimer = 0; let tipN = 0;
  const tipBox = () => {
    if (tipEl) return tipEl;
    tipEl = doc.createElement('div'); tipEl.className = 'ux-tip'; tipEl.setAttribute('role', 'tooltip'); tipEl.id = 'uxTip'; tipEl.hidden = true;
    doc.documentElement.appendChild(tipEl); return tipEl;
  };
  function hideTip() { if (root.clearTimeout) root.clearTimeout(tipTimer); if (tipEl) tipEl.hidden = true; if (tipFor) { tipFor.removeAttribute('aria-describedby'); tipFor = null; } }
  const showTip = (el) => {
    const text = el.getAttribute('data-tip'); if (!text || !el.isConnected) return;
    const b = tipBox(); b.textContent = text; b.hidden = false; tipFor = el; el.setAttribute('aria-describedby', b.id);
    const r = el.getBoundingClientRect(); const w = b.offsetWidth; const h = b.offsetHeight;
    const vw = root.innerWidth; const vh = root.innerHeight;
    const top = r.bottom + 8 + h > vh ? Math.max(4, r.top - 8 - h) : r.bottom + 8;
    const left = Math.min(Math.max(4, r.left + r.width / 2 - w / 2), Math.max(4, vw - w - 4));
    b.style.top = `${Math.round(top)}px`; b.style.left = `${Math.round(left)}px`;
  };
  // A native title is moved into data-tip; a control whose title was its only name keeps it as aria-label
  const adopt = (el) => {
    if (!el.getAttribute || el.tagName === 'IFRAME') return;
    const t = el.getAttribute('title'); if (t === null) return;
    el.removeAttribute('title'); if (!t.trim()) return;
    el.setAttribute('data-tip', t);
    if (!el.getAttribute('aria-label') && !(el.textContent || '').trim()) el.setAttribute('aria-label', t);
  };
  const watched = new Set();
  const tip = (r = doc) => {
    if (!r || watched.has(r)) return; watched.add(r);
    const scan = (n) => { if (n.nodeType !== 1) return; if (n.hasAttribute('title')) adopt(n); for (const c of n.querySelectorAll('[title]')) adopt(c); };
    scan(r.documentElement || r);
    if (root.MutationObserver) new root.MutationObserver((ms) => { for (const m of ms) { if (m.type === 'attributes') adopt(m.target); else for (const n of m.addedNodes) scan(n); } })
      .observe(r.documentElement || r, { subtree: true, childList: true, attributes: true, attributeFilter: ['title'] });
  };

  // 5. The keys of the screen, in a sheet opened by `?`
  const screenKeys = [];
  let sheet = null;
  const GLOBAL = () => [[['1', '2', '3', '4'], T('ux.keys.steps')], [[T('ux.keys.esc')], T('ux.keys.close')], [['?'], T('ux.keys.help')]];
  const rowHTML = (keys, verb) => `<li><span class="ux-keys-k">${keys.map((k) => `<kbd>${esc(k)}</kbd>`).join(' ')}</span><span>${esc(verb)}</span></li>`;
  const esc = (s) => String(s).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c]);
  const rowsOf = (list) => list.flatMap((r) => (typeof r === 'function' ? r() || [] : [r]));
  const keysHTML = (list) => `<ul class="ux-keys-list">${[...rowsOf(list), ...GLOBAL()].map(([k, v]) => rowHTML(Array.isArray(k) ? k : [k], v)).join('')}</ul>`;
  // a list of rows, or a function giving them when the sheet opens (a page that holds several screens: index.html)
  const keys = (list = []) => { if (typeof list === 'function') screenKeys.push(list); else for (const r of list) screenKeys.push(r); return { show: showKeys }; };
  function showKeys() {
    if (!doc || !doc.body) return;
    if (!sheet) {
      sheet = doc.createElement('dialog'); sheet.className = 'ux-keys'; sheet.setAttribute('aria-labelledby', 'uxKeysTitle');
      sheet.addEventListener('close', () => close(sheet, { focus: true }));
      sheet.addEventListener('click', (e) => { if (e.target === sheet || e.target.closest('[data-ux-keys-close]')) sheet.close(); });
      doc.body.appendChild(sheet);
    }
    sheet.innerHTML = `<div class="ux-keys-head"><h2 id="uxKeysTitle">${esc(T('ux.keys.title'))}</h2><button type="button" class="btn ux-keys-x" data-ux-keys-close>${esc(T('ux.keys.closeBtn'))}</button></div>${keysHTML(screenKeys)}`;
    const trigger = doc.activeElement;
    if (!sheet.open) { if (sheet.showModal) sheet.showModal(); else sheet.setAttribute('open', ''); }
    open(sheet, { trigger, close: () => { if (sheet.open) sheet.close(); }, trap: true });
    const x = sheet.querySelector('[data-ux-keys-close]'); if (x) x.focus();
  }

  const api = { open, close, tip, trap, roving, keys, showKeys, next, nearest, keysHTML, stack, _escape: escape };
  root.escadrilleUX = api;
  if (!doc || !doc.addEventListener) return;

  doc.addEventListener('keydown', (e) => {
    if (e.key === 'Escape' && !e.isComposing) { if (escape(e)) { e.preventDefault(); e.stopImmediatePropagation(); } return; }
    if (e.key === '?' && !e.metaKey && !e.ctrlKey && !e.altKey && !typing(e.target) && !(sheet && sheet.open)) { e.preventDefault(); showKeys(); }
  }, true);
  doc.addEventListener('mouseover', (e) => {
    const el = e.target.closest && e.target.closest('[data-tip]'); if (!el || el === tipFor) return;
    hideTip(); const n = ++tipN; tipTimer = root.setTimeout(() => { if (n === tipN && el.matches(':hover')) showTip(el); }, 150);
  });
  doc.addEventListener('mouseout', (e) => { const el = e.target.closest && e.target.closest('[data-tip]'); if (el && !(e.relatedTarget && el.contains(e.relatedTarget))) { tipN++; if (tipFor === el) hideTip(); } });
  doc.addEventListener('focusin', (e) => { const el = e.target.closest && e.target.closest('[data-tip]'); if (el && el.matches(':focus-visible')) { hideTip(); showTip(el); } });
  doc.addEventListener('focusout', (e) => { if (tipFor && tipFor.contains(e.target)) hideTip(); });
  doc.addEventListener('pointerdown', () => { tipN++; hideTip(); }, true);
  doc.addEventListener('scroll', () => { if (tipFor) hideTip(); }, true);
  const start = () => tip(doc);
  if (doc.readyState === 'loading') doc.addEventListener('DOMContentLoaded', start); else start();
})(typeof window !== 'undefined' ? window : globalThis);
