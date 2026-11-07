// The phone's words, in English and French. The language is the device's (English when it is neither),
// read once at start with Intl, which every runtime here has; on the web ?lang=fr|en forces it (captures).
// Plurals: a key with `_one` and `_other` variants, picked by the `n` parameter.
import { Platform } from 'react-native';
import en from './locales/en.json';
import fr from './locales/fr.json';

export type Lang = 'en' | 'fr';
export const DICTIONARIES: Record<Lang, Record<string, string>> = { en, fr };

// 'fr-CA' → 'fr', 'en-GB' → 'en', anything else → 'en'
export const pickLang = (locale?: string | null): Lang => (/^fr(\b|_|-|$)/i.test(locale || '') ? 'fr' : 'en');

const detect = (): Lang => {
  if (Platform.OS === 'web' && typeof window !== 'undefined' && window.location) {
    const forced = new URLSearchParams(window.location.search).get('lang');
    if (forced === 'fr' || forced === 'en') return forced;
  }
  try { return pickLang(Intl.DateTimeFormat().resolvedOptions().locale); } catch { return 'en'; }
};

export const lang: Lang = detect();
const locale = lang === 'fr' ? 'fr-FR' : 'en-US';
export const speechLocale = locale;

const plurals = new Intl.PluralRules(locale);

export const t = (key: string, params: Record<string, string | number> = {}): string => {
  const dict = DICTIONARIES[lang];
  const form = typeof params.n === 'number' ? `${key}_${plurals.select(params.n) === 'one' ? 'one' : 'other'}` : '';
  let text = dict[form] ?? dict[key];
  if (text === undefined) text = en[key as keyof typeof en] ?? key;
  return text.replace(/\{(\w+)\}/g, (m, name) => (name in params ? String(params[name]) : m));
};

// Does a key exist (a status the server invents falls back to its raw value)
export const has = (key: string): boolean => key in DICTIONARIES[lang];

// 0.8 → « 80 % » in French, « 80% » in English
export const percent = (v: number): string => new Intl.NumberFormat(locale, { style: 'percent', maximumFractionDigits: 0 }).format(v);
// 0.5 → « 0,50 $ » in French, « $0.50 » in English
export const money = (v: number): string => {
  const n = new Intl.NumberFormat(locale, { minimumFractionDigits: 2, maximumFractionDigits: 2 }).format(v);
  return lang === 'fr' ? `${n} $` : `$${n}`;
};
