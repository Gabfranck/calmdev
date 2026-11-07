// One live stream per page (2026-11-01). The browser keeps six connections per server; the home alone opened four or
// five EventSource streams (sidebar, thread, project flow, pilot log, planning), so a second tab or the app window froze
// every request of the app. Loaded first on every page, this file replaces EventSource for Escadrille's own
// /api/events URLs by a light object fed by a single shared stream (/api/events?all=1), where the server wraps each
// event as { key, data }. Other URLs (the phone's token stream, any other origin) keep the real EventSource.
(function (root) {
  const Real = root.EventSource; if (!Real || root.escadrilleEvents) return;
  const norm = (p) => String(p || '').replace(/\/+$/, '');
  // The same key the server computes for one stream (server.mjs, /api/events)
  const keyOf = (u) => { const s = u.searchParams; if (s.has('demo')) return 'demo'; if (s.get('plan')) return 'plan:' + s.get('plan'); if (s.has('running')) return 'running'; if (s.get('main')) return 'main:' + norm(s.get('main')); if (s.get('project')) return 'project:' + norm(s.get('project')); return 'escadrille:' + s.get('escadrille'); };
  const subs = new Set(); let shared = null; const types = new Set();
  // At most one « change » per subscriber every CHANGE_MS (docs/perf.md, 2026-11-02): four sessions and two pilots sent
  // several a second, each one reloaded 15 routes per tab and the Mac had to restart. The first goes at once, the ones
  // that follow within the window become a single one at its end: the page never misses the last state.
  const CHANGE_MS = 2000;
  const fire = (s, type, ev) => { for (const fn of s.listeners[type] || []) { try { fn.call(s, ev); } catch (e) { console.error(e); } } if (type === 'message' && s.onmessage) s.onmessage(ev); };
  const deliver = (type, raw) => {
    let key = null; let data = raw;
    try { const j = JSON.parse(raw); if (j && typeof j === 'object' && 'key' in j && 'data' in j) { key = j.key; data = JSON.stringify(j.data); } } catch { /* a bare event: every page listener gets it */ }
    for (const s of subs) {
      if (key !== null && norm(key) !== s.key) continue; const ev = { type, data, target: s };
      if (type !== 'change') { fire(s, type, ev); continue; }
      const t = Date.now(); const wait = (s.lastChange || 0) + CHANGE_MS - t;
      if (wait <= 0 && !s.held) { s.lastChange = t; fire(s, type, ev); continue; }
      s.held = ev; if (!s.holdTimer) s.holdTimer = setTimeout(() => { s.holdTimer = null; const e = s.held; s.held = null; s.lastChange = Date.now(); if (e && subs.has(s)) fire(s, 'change', e); }, Math.max(0, wait));
    }
  };
  const listen = (type) => { if (types.has(type) || !shared) return; types.add(type); shared.addEventListener(type, (e) => deliver(type, e.data)); };
  const open = () => {
    if (shared) return; shared = new Real('/api/events?all=1'); types.clear();
    for (const t of ['hello', 'change', 'message', 'pending']) listen(t);
    for (const s of subs) for (const t of Object.keys(s.listeners)) listen(t);
    shared.onerror = (e) => { for (const s of subs) if (s.onerror) s.onerror(e); };
    shared.onopen = (e) => { for (const s of subs) { s.readyState = 1; if (s.onopen) s.onopen(e); } };
  };
  class Shared {
    constructor(url) { this.url = String(url); this.key = keyOf(new URL(this.url, location.href)); this.listeners = {}; this.readyState = 0; this.onmessage = null; this.onerror = null; this.onopen = null; subs.add(this); if (!document.hidden) open(); if (shared && shared.readyState === 1) this.readyState = 1; }
    addEventListener(type, fn) { (this.listeners[type] ||= []).push(fn); listen(type); }
    removeEventListener(type, fn) { this.listeners[type] = (this.listeners[type] || []).filter((f) => f !== fn); }
    close() { this.readyState = 2; subs.delete(this); if (!subs.size && shared) { shared.close(); shared = null; } }
  }
  Shared.CONNECTING = 0; Shared.OPEN = 1; Shared.CLOSED = 2;
  root.EventSource = function (url, opts) {
    let u; try { u = new URL(String(url), location.href); } catch { return new Real(url, opts); }
    if (u.origin !== location.origin || u.pathname !== '/api/events' || u.searchParams.has('token') || u.searchParams.has('all')) return new Real(url, opts);
    return new Shared(url);
  };
  root.EventSource.CONNECTING = 0; root.EventSource.OPEN = 1; root.EventSource.CLOSED = 2;
  // A tab in the background gives its connection back (2026-11-02: six Escadrille tabs held Chrome's six connections to
  // the server, and every page of every tab froze, the inspector too). Hidden for 2 s: the stream closes; visible again:
  // it reopens and every listener gets one « change » so the page reloads what it missed. Leaving the page closes it.
  let hideTimer = null;
  const pause = () => { if (shared) { shared.close(); shared = null; } };
  const resume = () => { if (!subs.size || shared) return; open(); for (const s of subs) if (s.key !== 'demo') for (const fn of s.listeners.change || []) { try { fn.call(s, { type: 'change', data: String(Date.now()), target: s }); } catch (e) { console.error(e); } } };
  document.addEventListener('visibilitychange', () => { clearTimeout(hideTimer); if (document.hidden) hideTimer = setTimeout(pause, 2000); else resume(); });
  root.addEventListener('pagehide', pause);
  // The live software demo (docs/demo.md): its overlay changed (a file written, the demo removed), the page reloads itself
  try { new Shared('/api/events?demo=1').addEventListener('change', () => location.reload()); } catch (e) { console.error(e); }
  root.escadrilleEvents = { count: () => subs.size, keyOf, open: () => !!shared, CHANGE_MS };
})(window);
