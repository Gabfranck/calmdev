// The server's side of the two languages (public/i18n/i18n.js). A text the screen shows as is (an error, a system line, a
// pending card, a burst journal line) is written msg(key, vars): a marker ⟦key|{vars}⟧ that may be stored in
// the base as it is. Every JSON answer decodes the markers for the language of the request (langOf: the cookie
// escadrille-lang the pages set, else Accept-Language, else French, as the phone and the API tests expect).
// What goes to Claude (prompts, escadrille:* blocks) is never a marker; plain() decodes in French where a stored text
// may reach a prompt.
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import path from 'node:path';

const require = createRequire(import.meta.url);
const PUB = path.join(path.dirname(new URL(import.meta.url).pathname), '..', 'public');
const { make } = require(path.join(PUB, 'i18n', 'i18n.js'));

export const dicts = () => ({ en: JSON.parse(readFileSync(path.join(PUB, 'i18n', 'en.json'), 'utf8')), fr: JSON.parse(readFileSync(path.join(PUB, 'i18n', 'fr.json'), 'utf8')) });
let core = make({ dicts: dicts() });
export const reload = () => { core = make({ dicts: dicts() }); };

export const msg = (key, vars) => (vars && Object.keys(vars).length ? `⟦${key}|${JSON.stringify(vars)}⟧` : `⟦${key}⟧`);
export const tr = (lang, key, vars) => core.tr(lang, key, vars);
export const decode = (lang, s) => core.decode(lang, s);
export const deep = (lang, v) => core.deep(lang, v);
export const plain = (v) => core.deep('fr', v);
export const usd = (lang, n, d) => core.usd(lang, n, d);

export const langOf = (req) => {
  const c = /(?:^|;\s*)escadrille-lang=(en|fr)\b/.exec(req?.headers?.cookie || '');
  if (c) return c[1];
  const al = String(req?.headers?.['accept-language'] || '').toLowerCase().split(',').map((x) => x.trim().slice(0, 2));
  for (const l of al) if (l === 'en' || l === 'fr') return l;
  return 'fr';
};

// The script served at /i18n.js: the factory, then both dictionaries
export const bundle = () => { const d = dicts(); return `${readFileSync(path.join(PUB, 'i18n', 'i18n.js'), 'utf8')}\n;(typeof window !== 'undefined' ? window : globalThis).escadrilleI18n.init(${JSON.stringify(d.en)}, ${JSON.stringify(d.fr)});\n`; };
