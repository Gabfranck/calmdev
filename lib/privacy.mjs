// The developer's private life never leaves the Mac (Dev, 2026-11-02 evening): a protected guardrail. Everything
// Escadrille sends out or prepares to share (a pushed branch, a PR, the research corpus) goes through this file.
//
//   redact(text, ctx)       the text with secrets, the home folder, e-mails, phones, LAN addresses, the developer's full
//                           name and the names of their other projects replaced by placeholders
//   privateTopic(text)      true when the text speaks of the developer's life (money, health, family, career…): such a
//                           message is withheld whole, never redacted word by word
//   scan(text, ctx)         the findings ({ kind, sample }) that forbid publishing text as is (a pushed diff)
//   context({ home, names, projects })   the ctx above, from the machine: home folder, git user.name, other projects
//
// Automatic redaction is a floor, not a promise: what is shared is reread by the developer first.
import { homedir } from 'node:os';
import path from 'node:path';

const SECRET = [
  /\bsk-[A-Za-z0-9_-]{16,}/g, /\bgh[pousr]_[A-Za-z0-9]{20,}/g, /\bgithub_pat_[A-Za-z0-9_]{20,}/g, /\bxox[abprs]-[A-Za-z0-9-]{10,}/g,
  /\bAKIA[0-9A-Z]{16}\b/g, /\blin_api_[A-Za-z0-9]{20,}/g, /\beyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}/g,
  /-----BEGIN [A-Z ]*PRIVATE KEY-----[\s\S]*?-----END [A-Z ]*PRIVATE KEY-----/g, /\bExponentPushToken\[[^\]]+\]/g,
];
const KEYVAL = /\b(token|key|k|password|passwd|pwd|secret|mdp|motDePasse|api_?key|authorization)(["']?\s*[:=]\s*["']?)(?!<)([^\s"'&,;)}]{6,})/gi;
const BEARER = /\b(Bearer|Basic)\s+[A-Za-z0-9._~+/=-]{12,}/g;
const HEX = /\b[0-9a-f]{40,}\b/gi; // keys and tokens; a git sha (40) included: harmless, and a 64-hex guard key looks the same
const EMAIL = /\b[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}\b/g;
const PHONE = /(?<![\w.])(?:\+33\s?|0)[1-9](?:[ .-]?\d{2}){4}(?![\w.])/g;
const LAN = /\b(?:10\.\d{1,3}|192\.168|172\.(?:1[6-9]|2\d|3[01]))\.\d{1,3}\.\d{1,3}\b/g;
const HOMES = /(?:\/Users|\/home)\/[^/\s"'`)]+/g;
const TMP = /\/(?:private\/)?var\/folders\/[^\s"'`)]+/g;

// Words of a life, French and English. A false alarm withholds one message, a miss exposes one: the list errs wide.
export const PRIVATE_TOPIC = /\b(salaires?|argent|TJM|tarifs? journaliers?|factures?|banques?|imp[ôo]ts?|URSSAF|loyers?|pr[êe]t immobilier|dettes?|sant[ée]|m[ée]decins?|maladie|malade|th[ée]rapeute|famille|enfants?|copine|petite amie|ma femme|mon mari|divorce|carri[èe]re|CV|embauche|recrutement|ch[ôo]mage|France Travail|P[ôo]le emploi|freelance|ma mission|ma vie|salary|my wife|my husband|girlfriend|boyfriend|my kids|health|doctor|therapy|unemployment|job interview|my career)\b/i;
export const privateTopic = (text) => PRIVATE_TOPIC.test(String(text || ''));

const esc = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
// The product's own names, old and new: its checkout sits in the developer's registry, yet it is no « other project »
// (the public export counted 339 « calmdev » traces, 7 November)
export const PRODUCT_NAMES = ['escadrille', 'calmdev'];
export const context = ({ home = homedir(), names = [], projects = [], keep = PRODUCT_NAMES } = {}) => {
  const others = [...new Set(projects.flatMap((p) => { const b = path.basename(p); const parent = path.basename(path.dirname(p)); return [b, parent]; }))]
    .filter((n) => n && n.length > 2 && !keep.includes(n.toLowerCase()) && !/^(dev|src|code|projects?|users|home)$/i.test(n))
    .sort((a, b) => b.length - a.length);
  // the full name, each of its parts, an e-mail's local part (a cut text keeps « Jane Fr » or « name.pro@gma »)
  const parts = names.flatMap((n) => [n, ...String(n).split(/[\s@]+/)]).filter((n) => n && n.length > 3 && !/^(gmail|com|fr|pro)$/i.test(n));
  return { home, names: [...new Set(parts)].sort((a, b) => b.length - a.length), others };
};

export const redact = (text, ctx = context()) => {
  let t = String(text ?? '').replace(/%2F/gi, '/'); // an encoded path (?project=%2FUsers%2F…) is a path
  for (const re of SECRET) t = t.replace(re, '<secret>');
  t = t.replace(KEYVAL, (_, k, sep) => `${k}${sep}<secret>`).replace(BEARER, (_, w) => `${w} <secret>`).replace(HEX, '<hex>');
  if (ctx.home) t = t.split(ctx.home).join('~');
  t = t.replace(HOMES, '~').replace(TMP, '<tmp>').replace(EMAIL, '<email>').replace(PHONE, '<tel>').replace(LAN, '<ip-lan>');
  for (const n of ctx.names || []) t = t.replace(new RegExp(`\\b${esc(n)}\\b`, 'gi'), '<dev>');
  (ctx.others || []).forEach((n) => { t = t.replace(new RegExp(`\\b${esc(n)}\\b`, 'gi'), '<autre-projet>'); });
  return t;
};

// What forbids a publication as is (the added lines of a branch about to be pushed): secrets, the home folder, a
// phone number, a LAN address. E-mails are left to the developer's git config (every commit carries one).
export const scan = (text, ctx = context()) => {
  const t = String(text || ''); const out = [];
  const add = (kind, re) => { for (const m of t.matchAll(new RegExp(re.source, re.flags.includes('g') ? re.flags : re.flags + 'g'))) { out.push({ kind, sample: m[0].slice(0, 12) + (m[0].length > 12 ? '…' : '') }); if (out.length > 50) return; } };
  for (const re of SECRET) add('secret', re);
  add('secret', BEARER);
  add('home', ctx.home ? new RegExp(esc(ctx.home) + '(?=/|\\b)') : HOMES);
  add('phone', PHONE); add('lan', LAN);
  return out;
};
