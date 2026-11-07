// The guessed reply (docs/suggest.md): in an empty composer, the likely answer in grey behind the cursor. Tab takes it,
// typing hides it, Escape clears it and keeps the focus; Enter on an empty field never sends it. Shared by the
// Conversation (public/mainchat.js) and the thread of a session (public/plan.html): any textarea[data-sg] in a
// .composer .box, with data-sg-project, and for a session data-sg-plan, data-sg-session, data-sg-stop (the waiting reply).
// One GET /api/suggest per stop (cached; the main thread's for 60 s), never per keystroke; each send POSTs its outcome.
(() => {
  const T = (k, v) => (typeof window.T === 'function' ? window.T(k, v) : k);
  const cache = new Map(); // ctx key → { at, p: Promise<{ text, kind, plan, session }> }
  const dismissed = new Set(); // ctx key + text, cleared by Escape until the next stop
  const opening = new WeakMap(); // textarea → { shown, tabbed }
  const MAIN_TTL = 60e3;
  const ctxOf = (ta) => ({ project: ta.dataset.sgProject || '', plan: ta.dataset.sgPlan || '', session: ta.dataset.sgSession || '', stop: ta.dataset.sgStop || '' });
  const keyOf = (c) => [c.project, c.plan, c.session, c.stop].join('|');
  const isSession = (c) => !!c.plan;
  const fetchFor = (c) => {
    const k = keyOf(c); const hit = cache.get(k);
    if (hit && (isSession(c) || Date.now() - hit.at < MAIN_TTL)) return hit.p;
    const q = new URLSearchParams({ project: c.project }); if (c.plan) { q.set('plan', c.plan); q.set('session', c.session); }
    const p = fetch('/api/suggest?' + q).then((r) => (r.ok ? r.json() : { text: null })).catch(() => ({ text: null }));
    cache.set(k, { at: Date.now(), p }); return p;
  };
  const sid = (ta) => ta.id || (ta.id = 'sg-ta-' + Math.random().toString(36).slice(2, 8));
  // The layer: same grid cell as the textarea, same font, padding, line height and wrapping; the textarea above it
  const ensure = (ta) => {
    const box = ta.parentElement; let g = box.querySelector(':scope > .sg-ghost');
    if (!g) {
      g = document.createElement('div'); g.className = 'sg-ghost'; g.setAttribute('aria-hidden', 'true'); g.hidden = true;
      g.innerHTML = '<span class="sg-text"></span><kbd class="sg-key"></kbd>';
      const sr = document.createElement('span'); sr.className = 'sg-sr'; sr.id = 'sg-sr-' + sid(ta);
      box.insertBefore(g, ta); box.insertBefore(sr, ta); box.classList.add('sg-box');
    }
    const cs = getComputedStyle(ta);
    for (const p of ['fontFamily', 'fontSize', 'fontWeight', 'letterSpacing', 'lineHeight', 'paddingTop', 'paddingRight', 'paddingBottom', 'paddingLeft', 'borderTopWidth', 'borderRightWidth', 'borderBottomWidth', 'borderLeftWidth', 'textIndent', 'tabSize']) g.style[p] = cs[p];
    return g;
  };
  const busy = (ta) => { const box = ta.parentElement; const mic = box.querySelector('.mic[aria-pressed="true"]'); const interim = box.querySelector('.interim'); return !!mic || !!(interim && interim.textContent.trim()); };
  const hide = (ta) => {
    const g = ta.parentElement && ta.parentElement.querySelector(':scope > .sg-ghost'); if (!g || g.hidden) return;
    g.hidden = true; if (ta.dataset.sgPh !== undefined) { ta.placeholder = ta.dataset.sgPh; delete ta.dataset.sgPh; }
    const d = (ta.getAttribute('aria-describedby') || '').split(' ').filter((x) => x && !x.startsWith('sg-sr-'));
    if (d.length) ta.setAttribute('aria-describedby', d.join(' ')); else ta.removeAttribute('aria-describedby');
    const sr = document.getElementById('sg-sr-' + ta.id); if (sr) sr.textContent = '';
  };
  const show = (ta, s) => {
    const g = ensure(ta); g.querySelector('.sg-text').textContent = s.text; g.querySelector('.sg-key').textContent = T('main.suggestKey'); g.hidden = false;
    if (ta.dataset.sgPh === undefined) { ta.dataset.sgPh = ta.placeholder; ta.placeholder = ''; }
    const sr = document.getElementById('sg-sr-' + ta.id); sr.textContent = T('main.suggestHint', { text: s.text });
    const d = (ta.getAttribute('aria-describedby') || '').split(' ').filter((x) => x && x !== sr.id); ta.setAttribute('aria-describedby', [...d, sr.id].join(' '));
    const o = opening.get(ta) || {}; o.shown = s; opening.set(ta, o);
  };
  const current = new WeakMap(); // textarea → the guess for its context (or null)
  const update = (ta) => {
    const s = current.get(ta); const c = ctxOf(ta);
    if (!s || !s.text || ta.value !== '' || ta.disabled || document.activeElement !== ta || busy(ta) || dismissed.has(keyOf(c) + '\n' + s.text)) return hide(ta);
    show(ta, s);
  };
  const open = (ta) => {
    const c = ctxOf(ta); if (!c.project || (isSession(c) && !c.stop)) { current.set(ta, null); return hide(ta); }
    const k = keyOf(c); ta.dataset.sgKey = k;
    fetchFor(c).then((s) => { if (ta.dataset.sgKey !== k) return; current.set(ta, s && s.text ? s : s && s.kind ? { ...s, text: null } : null); update(ta); });
  };
  const isSg = (t) => t && t.matches && t.matches('.composer textarea[data-sg]');
  // Each send records how the guess fared: accepted as is, taken by Tab then edited, or typed over
  let last = { v: null, at: 0 };
  const record = (ta) => {
    const sent = ta.value.trim(); if (!sent) return; if (last.v === sent && Date.now() - last.at < 1500) return; last = { v: sent, at: Date.now() };
    const s = current.get(ta); const o = opening.get(ta) || {}; const c = ctxOf(ta);
    if (!s || !s.kind) return; // no stop waiting: nothing to learn from
    fetch('/api/suggest', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ project: c.project, plan: s.plan || null, session: s.session || null, kind: s.kind, suggestion: o.shown ? o.shown.text : null, sent, tabbed: !!o.tabbed }) }).catch(() => {});
    opening.delete(ta); cache.delete(keyOf(c));
  };
  document.addEventListener('focusin', (e) => { if (isSg(e.target)) open(e.target); });
  document.addEventListener('focusout', (e) => { if (isSg(e.target)) hide(e.target); });
  document.addEventListener('input', (e) => { if (isSg(e.target)) update(e.target); });
  document.addEventListener('click', (e) => { const b = e.target.closest && e.target.closest('.composer .mic'); if (!b) return; const ta = b.closest('.box') && b.closest('.box').querySelector('textarea[data-sg]'); if (ta) setTimeout(() => update(ta), 0); });
  document.addEventListener('submit', (e) => { const ta = e.target.querySelector && e.target.querySelector('textarea[data-sg]'); if (ta) record(ta); }, true);
  document.addEventListener('keydown', (e) => {
    const ta = e.target; if (!isSg(ta) || e.isComposing) return;
    const g = ta.parentElement.querySelector(':scope > .sg-ghost'); const visible = g && !g.hidden;
    if (e.key === 'Tab' && !e.shiftKey && !e.metaKey && !e.ctrlKey && !e.altKey && visible && ta.value === '') {
      e.preventDefault(); e.stopImmediatePropagation(); const s = current.get(ta);
      ta.value = s.text; ta.setSelectionRange(ta.value.length, ta.value.length); const o = opening.get(ta) || {}; o.tabbed = true; opening.set(ta, o);
      hide(ta); ta.dispatchEvent(new Event('input', { bubbles: true })); return;
    }
    if (e.key === 'Escape' && visible) { e.preventDefault(); e.stopImmediatePropagation(); const s = current.get(ta); dismissed.add(keyOf(ctxOf(ta)) + '\n' + s.text); hide(ta); return; }
    if (e.key === 'Enter' && !e.shiftKey) { if (ta.value.trim()) record(ta); return; } // an empty field sends nothing, the grey text included
    if (visible && e.key.length === 1 && !e.metaKey && !e.ctrlKey) hide(ta); // typing hides it at once, before the input event
  }, true);
  window.escadrilleSuggest = { refresh: () => { cache.clear(); const ta = document.activeElement; if (isSg(ta)) open(ta); } };
})();
