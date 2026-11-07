// The installed app (phase 11, W): Escadrille as a borderless window, Chrome's « window-controls-overlay ». The layout
// itself is CSS (app.css, @media (display-mode: window-controls-overlay)); this file only offers the install, once:
// when Chrome says the page can become an app (beforeinstallprompt) and it is not one yet, the sidebar shows one folded
// line, `#installLine`, drawn by sidebar.js. One click installs; once installed or refused it never comes back
// (localStorage `escadrille.install` = done | no). No service worker: Chrome on the desktop does not ask for one.
//   escadrilleApp.sync()  shows or hides the line (sidebar.js calls it each time the bar is drawn)
//   escadrilleApp.wants(stored, installed, offered)  the pure rule (tested)
(function (root) {
  const KEY = 'escadrille.install';
  const T = (k, v) => (root.T ? root.T(k, v) : k);
  const wants = (stored, installed, offered) => !!offered && !installed && stored !== 'done' && stored !== 'no';
  const stored = () => { try { return root.localStorage.getItem(KEY); } catch { return null; } };
  const store = (v) => { try { root.localStorage.setItem(KEY, v); } catch {} };
  // Already an app window (standalone, or the borderless overlay): nothing to offer
  const installed = () => !!(root.matchMedia && ['standalone', 'window-controls-overlay', 'minimal-ui', 'fullscreen'].some((m) => root.matchMedia(`(display-mode: ${m})`).matches));
  let offer = null; // the BeforeInstallPromptEvent, kept until the click

  const sync = () => {
    const doc = root.document; const el = doc && doc.getElementById('installLine'); if (!el) return;
    const show = wants(stored(), installed(), offer);
    el.hidden = !show;
    if (!show) return;
    el.innerHTML = `<button type="button" class="install-go" data-install>${T('install.line')}</button><button type="button" class="install-no" data-install-no aria-label="${T('install.no')}" data-tip="${T('install.no')}">×</button>`;
  };

  if (root.addEventListener) {
    root.addEventListener('beforeinstallprompt', (e) => { e.preventDefault(); offer = e; sync(); });
    root.addEventListener('appinstalled', () => { store('done'); offer = null; sync(); });
    if (root.document) root.document.addEventListener('click', async (e) => {
      const t = e.target && e.target.closest ? e.target.closest('[data-install], [data-install-no]') : null; if (!t) return;
      if (t.hasAttribute('data-install-no')) { store('no'); offer = null; return sync(); }
      const o = offer; if (!o) return;
      offer = null; sync();
      try { await o.prompt(); const c = await o.userChoice; store(c && c.outcome === 'accepted' ? 'done' : 'no'); } catch { store('no'); }
      sync();
    });
  }
  // offered(): Chrome offers the install right now (the « À toi » list of the home shows one line, mainchat.js)
  root.escadrilleApp = { sync, wants, offered: () => wants(stored(), installed(), offer) };
})(typeof window !== 'undefined' ? window : globalThis);
