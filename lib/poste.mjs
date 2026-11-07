// The « poste » (docs/studio.md): a trusted Mac of the LAN (the MacBook) paired by code with the Mac that runs the
// sessions (the Studio). Its token lives in an HttpOnly, SameSite=Strict cookie of its browser; it opens every route
// of the Mac except the few that act on the Studio's own screen or on the pairing itself. Pure functions, no I/O.

export const POSTE_DAYS = 30; // a phone lasts 90 days, a poste 30: it pilots sessions that write code
export const COOKIE = 'escadrille_poste';

// What stays to the Studio alone, even for a poste: a window or a Finder on the Studio's screen, a dev server on its
// localhost, the pairing and the device list (a poste does not make or forget others), the guardrail key link
export const studioOnly = (seg, method) => {
  if (seg[0] === 'guard') return true;
  if (seg[0] !== 'api') return false;
  if (seg[1] === 'pair' && seg[2] === 'code') return true;
  if (seg[1] === 'devices') return true;
  if (method === 'POST' && seg[1] === 'plan' && seg[3] === 'session' && ['terminal', 'open', 'devserver'].includes(seg[5]) && !seg[6]) return true;
  return false;
};

// The token of the cookie header, or null
export const cookieToken = (header) => {
  for (const part of String(header || '').split(';')) {
    const i = part.indexOf('='); if (i < 0) continue;
    if (part.slice(0, i).trim() === COOKIE) { const v = part.slice(i + 1).trim(); return /^[\w-]{20,100}$/.test(v) ? v : null; }
  }
  return null;
};

// The set-cookie header that gives the browser its token (or clears it with token null)
export const setCookie = (token) => (token
  ? `${COOKIE}=${token}; Path=/; HttpOnly; SameSite=Strict; Max-Age=${POSTE_DAYS * 86400}`
  : `${COOKIE}=; Path=/; HttpOnly; SameSite=Strict; Max-Age=0`);

// A write from a poste must come from a page of this server: an Origin equal to http://<Host>. GET and HEAD pass
// (they change nothing); a POST without Origin, or from another site, is refused (a third page posting to the Studio)
export const originOk = (req) => {
  if (req.method === 'GET' || req.method === 'HEAD') return true;
  const o = req.headers.origin; const h = req.headers.host;
  return !!o && !!h && o === `http://${h}`;
};

// The whole pairing page, served to the LAN without a token: the code, a name, « Appairer »; then back to /
const esc = (s) => String(s ?? '').replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
export const pairPage = (host = '') => `<!doctype html>
<html lang="fr"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">
<title>Appairer ce poste · Escadrille</title>
<style>
  :root { color-scheme: light dark; --fg: #16181d; --m: #6b7080; --bg: #fafaf9; --line: #e4e4e7; --acc: #2b59c3; }
  @media (prefers-color-scheme: dark) { :root { --fg: #ececef; --m: #9a9eab; --bg: #111214; --line: #2a2c31; --acc: #7aa2ff; } }
  body { margin: 0; min-height: 100vh; display: grid; place-items: center; background: var(--bg); color: var(--fg); font: 15px/1.5 -apple-system, BlinkMacSystemFont, "Inter", system-ui, sans-serif; }
  form { width: min(360px, 90vw); display: grid; gap: 14px; }
  h1 { font-size: 20px; font-weight: 600; margin: 0; letter-spacing: -0.01em; }
  p { margin: 0; color: var(--m); }
  label { display: grid; gap: 6px; font-size: 13px; color: var(--m); }
  input { font: inherit; padding: 10px 12px; border: 1px solid var(--line); border-radius: 8px; background: transparent; color: var(--fg); }
  input[name=code] { font: 600 22px/1.2 ui-monospace, "SF Mono", Menlo, monospace; letter-spacing: 0.15em; }
  button { font: inherit; font-weight: 600; padding: 10px 12px; border: 0; border-radius: 8px; background: var(--acc); color: #fff; cursor: pointer; }
  button:disabled { opacity: .6; cursor: default; }
  output { min-height: 1.5em; color: #c2410c; font-size: 13px; }
</style></head>
<body><form id="f" autocomplete="off">
  <h1>Appairer ce poste</h1>
  <p>Sur le Studio${host ? ` (${esc(host)})` : ''}, dans la page : « Appareils », « Code de poste ». Le code vaut 10 minutes.</p>
  <label>Code<input name="code" inputmode="numeric" maxlength="7" placeholder="482 913" required autofocus></label>
  <label>Nom de ce poste<input name="name" maxlength="40" value="MacBook"></label>
  <button>Appairer</button>
  <output id="o"></output>
</form>
<script>
  const f = document.getElementById('f'); const o = document.getElementById('o');
  f.addEventListener('submit', async (e) => { e.preventDefault(); const b = f.querySelector('button'); b.disabled = true; o.textContent = '';
    try { const r = await fetch('/api/pair', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ code: f.code.value, name: f.name.value, kind: 'poste' }) });
      const j = await r.json(); if (r.ok) { location.replace('/'); return; } o.textContent = j.error || 'refusé'; }
    catch (err) { o.textContent = 'Le Studio ne répond pas'; }
    b.disabled = false; });
</script></body></html>`;
