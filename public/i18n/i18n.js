// The two languages of the app (public/i18n/i18n.js). The server serves this file at /i18n.js followed by
// `escadrilleI18n.init(en, fr)` with public/i18n/en.json and fr.json, so every page has both dictionaries at once and
// switches without a reload. Load it first, in the <head>, before any other script of the app.
//   t('key', { n: 3, name: 'x' })   a string; an entry may be { zero?, one, other } chosen by Intl.PluralRules on n
//   t.num(n) t.usd(n) t.pct(x) t.date(d) t.time(d) t.dateTime(d) t.ago(d)   numbers, money and dates by Intl
//   t.lang  'en' | 'fr' ; escadrilleI18n.set('fr') switches, keeps the choice, and calls every onChange handler
//   (a page that registers none is reloaded); data-i18n="key" sets textContent, data-i18n-attr="title:key;aria-label:key"
//   sets attributes, data-i18n-html="key" sets innerHTML (only for keys whose text holds the page's own markup).
// The server writes a text it cannot translate itself as ⟦key|{"var":…}⟧ (lib/i18n.mjs msg()); it decodes those in
// every JSON answer for the language of the cookie, and decode() here catches any that arrive raw.
(function (root) {
  const LANGS = ['en', 'fr'];
  const LOCALE = { en: 'en-US', fr: 'fr-FR' };
  const KEY = 'escadrille.lang';

  const make = ({ dicts = {}, lang = 'en' } = {}) => {
    const I = { dicts, lang, handlers: [] };
    const entry = (lg, key) => { const d = I.dicts[lg] || {}; if (Object.prototype.hasOwnProperty.call(d, key)) return d[key]; const e = I.dicts.en || {}; return Object.prototype.hasOwnProperty.call(e, key) ? e[key] : undefined; };
    const nf = (lg, opts) => new Intl.NumberFormat(LOCALE[lg] || lg, opts);
    const num = (lg, n, opts) => (typeof n === 'number' && Number.isFinite(n) ? nf(lg, opts).format(n) : '—');
    const usd = (lg, n, digits) => {
      if (typeof n !== 'number' || !Number.isFinite(n)) return '—';
      const d = digits ?? (Math.abs(n) >= 100 ? 0 : 2);
      const s = nf(lg, { minimumFractionDigits: d, maximumFractionDigits: d }).format(Math.abs(n));
      return (n < 0 ? '−' : '') + (lg === 'fr' ? s + ' $' : '$' + s);
    };
    // A plain number fills {n}; a text is decoded (it may hold a marker); anything else is String()
    const fill = (lg, text, vars) => String(text).replace(/\{(\w+)\}/g, (m, k) => {
      if (!vars || !(k in vars)) return m; const v = vars[k];
      if (typeof v === 'number') return num(lg, v);
      return v === null || v === undefined ? '' : decode(lg, String(v));
    });
    const tr = (lg, key, vars) => {
      let e = entry(lg, key);
      if (e === undefined) return key;
      if (e && typeof e === 'object') {
        const n = Number(vars && (vars.n ?? vars.count)) || 0;
        e = n === 0 && e.zero !== undefined ? e.zero : e[new Intl.PluralRules(LOCALE[lg] || lg).select(n)] ?? e.other;
      }
      return fill(lg, e, vars);
    };
    // ⟦key⟧ or ⟦key|{json vars}⟧, nested markers allowed inside the vars
    const decode = (lg, s) => {
      if (typeof s !== 'string' || !s.includes('⟦')) return s;
      let out = ''; let i = 0;
      while (i < s.length) {
        const a = s.indexOf('⟦', i); if (a < 0) { out += s.slice(i); break; }
        out += s.slice(i, a); let depth = 0; let b = a;
        for (; b < s.length; b++) { if (s[b] === '⟦') depth++; else if (s[b] === '⟧' && --depth === 0) break; }
        if (b >= s.length) { out += s.slice(a); break; }
        const body = s.slice(a + 1, b); const bar = body.indexOf('|');
        const key = bar < 0 ? body : body.slice(0, bar); let vars = null;
        if (bar >= 0) { try { vars = JSON.parse(body.slice(bar + 1)); } catch { vars = null; } }
        out += tr(lg, key, vars); i = b + 1;
      }
      return out;
    };
    const deep = (lg, v) => {
      if (typeof v === 'string') return decode(lg, v);
      if (Array.isArray(v)) return v.map((x) => deep(lg, x));
      if (v && typeof v === 'object' && (Object.getPrototypeOf(v) === Object.prototype || Object.getPrototypeOf(v) === null)) { const o = {}; for (const k of Object.keys(v)) o[k] = deep(lg, v[k]); return o; }
      return v;
    };
    const toDate = (d) => (d instanceof Date ? d : new Date(d));
    const valid = (d) => !Number.isNaN(toDate(d).getTime());

    const t = (key, vars) => tr(I.lang, key, vars);
    t.num = (n, opts) => num(I.lang, n, opts);
    t.usd = (n, digits) => usd(I.lang, n, digits);
    t.pct = (x, digits = 0) => (typeof x === 'number' && Number.isFinite(x) ? nf(I.lang, { style: 'percent', maximumFractionDigits: digits }).format(x) : '—');
    t.date = (d, opts = { day: 'numeric', month: 'short' }) => (valid(d) ? new Intl.DateTimeFormat(LOCALE[I.lang], opts).format(toDate(d)) : '—');
    t.time = (d) => t.date(d, { hour: '2-digit', minute: '2-digit' });
    t.dateTime = (d) => t.date(d, { day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' });
    t.ago = (d) => {
      if (!valid(d)) return '—';
      const s = Math.round((toDate(d).getTime() - Date.now()) / 1000); const rtf = new Intl.RelativeTimeFormat(LOCALE[I.lang], { numeric: 'auto' });
      const a = Math.abs(s);
      return a < 60 ? rtf.format(0, 'second') : a < 3600 ? rtf.format(Math.round(s / 60), 'minute') : a < 86400 ? rtf.format(Math.round(s / 3600), 'hour') : rtf.format(Math.round(s / 86400), 'day');
    };
    t.decode = (s) => decode(I.lang, s);
    t.has = (key) => entry(I.lang, key) !== undefined;
    Object.defineProperty(t, 'lang', { get: () => I.lang });
    Object.defineProperty(t, 'locale', { get: () => LOCALE[I.lang] });
    return { I, t, tr, decode, deep, usd, num };
  };

  // Node (lib/i18n.mjs, the tests): the factory only
  if (typeof module !== 'undefined' && module.exports) { module.exports = { make, LANGS, LOCALE }; return; }

  // The browser: the stored choice, else the first fr or en of the browser, else English
  const pick = () => {
    if (LANGS.includes(root.ESCADRILLE_LANG)) return root.ESCADRILLE_LANG; // the tests set it
    try { const q = new URLSearchParams(root.location.search).get('lang'); if (LANGS.includes(q)) { root.localStorage.setItem(KEY, q); return q; } } catch {} // ?lang=en, kept: a capture, a link
    try { const s = root.localStorage.getItem(KEY); if (LANGS.includes(s)) return s; } catch {}
    const nav = root.navigator ? [...(root.navigator.languages || []), root.navigator.language] : [];
    for (const l of nav) { const p = String(l || '').slice(0, 2).toLowerCase(); if (LANGS.includes(p)) return p; }
    return 'en';
  };
  const core = make({ lang: pick() });
  const { t } = core;
  const doc = root.document;
  const cookie = () => { try { doc.cookie = `escadrille-lang=${core.I.lang}; path=/; max-age=31536000; SameSite=Lax`; } catch {} };

  // The static text of a page: data-i18n, data-i18n-html, data-i18n-attr, within el (the document by default)
  const apply = (el) => {
    const scope = el || doc; if (!scope || !scope.querySelectorAll) return;
    for (const n of scope.querySelectorAll('[data-i18n]')) n.textContent = t(n.dataset.i18n);
    for (const n of scope.querySelectorAll('[data-i18n-html]')) n.innerHTML = t(n.dataset.i18nHtml);
    for (const n of scope.querySelectorAll('[data-i18n-attr]')) {
      for (const pair of n.dataset.i18nAttr.split(';')) { const [attr, key] = pair.split(':').map((x) => x.trim()); if (attr && key) n.setAttribute(attr, t(key)); }
    }
  };
  const mark = () => { if (doc && doc.documentElement) doc.documentElement.lang = core.I.lang; cookie(); };

  const api = {
    t, make, LANGS, apply,
    get lang() { return core.I.lang; },
    init(en, fr) { core.I.dicts = { en: en || {}, fr: fr || {} }; mark(); if (doc && doc.readyState !== 'loading') apply(); },
    onChange(fn) { if (typeof fn === 'function') core.I.handlers.push(fn); },
    set(lang) {
      if (!LANGS.includes(lang) || lang === core.I.lang) return;
      core.I.lang = lang; try { root.localStorage.setItem(KEY, lang); } catch {}
      mark(); apply();
      if (!core.I.handlers.length) { root.location.reload(); return; }
      for (const fn of core.I.handlers) { try { fn(lang); } catch (e) { console.error(e); } }
    },
  };
  root.escadrilleI18n = api;
  root.T = t; // the pages call T(key, vars): `t` is a common local name in them
  if (doc && doc.addEventListener) doc.addEventListener('DOMContentLoaded', () => apply());
})(typeof window !== 'undefined' ? window : globalThis);
