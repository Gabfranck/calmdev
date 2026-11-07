// The dictionaries for a test that loads a script of public/ outside a browser: into a vm context, or into globalThis
// (a script imported with `await import`). French by default, as the assertions written before phase 9 I.
import { runInContext, isContext, createContext } from 'node:vm';
import { bundle } from '../lib/i18n.mjs';

export const i18nInto = (ctx, lang = 'fr') => { ctx.ESCADRILLE_LANG = lang; if (ctx.window && typeof ctx.window === 'object') ctx.window.ESCADRILLE_LANG = lang; if (ctx === globalThis) (0, eval)(bundle()); else { if (!isContext(ctx)) createContext(ctx); runInContext(bundle(), ctx); } return ctx; };
export const i18nGlobal = (lang = 'fr') => i18nInto(globalThis, lang);
