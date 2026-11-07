// The page opened from a poste (docs/studio.md): the browser of the MacBook pilots the Studio. GET /api/whoami says
// so; then one quiet line at the top tells where everything runs, and the buttons that would act on the Studio's own
// screen (terminal, open the folder, the dev server on its localhost) disappear: the server refuses them anyway (403).
// « Open the PR » (the only git push, cookie only: docs/gate.md) gives way to a line « to do on the Mac ».
(() => {
  const T = (k, v) => (window.T ? window.T(k, v) : k);
  const css = `.on-poste [data-act="terminal"], .on-poste [data-open="open"], .on-poste [data-open="devserver"], .on-poste #phone, .on-poste [data-pr="open"] { display: none !important; }
.on-poste .pr:has([data-pr="open"])::before { content: var(--pr-on-mac); display: block; color: var(--muted, #6b7080); font-size: 13px; }
.remote-line { position: fixed; top: 8px; right: 12px; z-index: 50; padding: 3px 9px; border: 1px solid var(--border, #e4e4e7); border-radius: 999px;
  background: var(--ground, #fff); color: var(--muted, #6b7080); font: 12px/1.4 var(--mono, ui-monospace, Menlo, monospace); pointer-events: none; }`;
  const show = (w) => {
    const host = w.host || 'Studio'; const addr = (w.address || location.host).replace(/^https?:\/\//, '');
    document.documentElement.classList.add('on-poste');
    const st = document.createElement('style'); st.textContent = css; document.head.appendChild(st);
    const el = document.createElement('div'); el.className = 'remote-line'; el.id = 'remoteLine';
    const paint = () => { document.documentElement.style.setProperty('--pr-on-mac', JSON.stringify(T('remote.prOnMac'))); el.textContent = `${host} · ${addr}`; el.title = T('remote.title', { host }); el.setAttribute('aria-label', T('remote.on', { host })); };
    paint(); document.body.appendChild(el);
    if (window.escadrilleI18n) window.escadrilleI18n.onChange(paint);
  };
  fetch('/api/whoami').then((r) => (r.ok ? r.json() : null)).then((w) => { if (w && w.poste) show(w); }).catch(() => {});
})();
