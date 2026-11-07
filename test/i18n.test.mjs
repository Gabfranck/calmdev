// Phase 9 I: the app in English and French (public/i18n/i18n.js). No browser: the dictionaries hold the same keys and the
// same variables; every key the code names exists; no French text is written by hand in public/ outside them; t()
// chooses plurals and formats numbers, money and dates by Intl; the server decodes its markers by the request's language.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import { runInNewContext } from 'node:vm';
import path from 'node:path';
import { msg, deep, langOf, bundle } from '../lib/i18n.mjs';

const ROOT = path.join(path.dirname(new URL(import.meta.url).pathname), '..');
const PUB = path.join(ROOT, 'public');
const en = JSON.parse(readFileSync(path.join(PUB, 'i18n', 'en.json'), 'utf8'));
const fr = JSON.parse(readFileSync(path.join(PUB, 'i18n', 'fr.json'), 'utf8'));
const vars = (v) => new Set([...(typeof v === 'object' ? Object.values(v) : [v]).join(' ').matchAll(/\{(\w+)\}/g)].map((m) => m[1]));

test('en.json and fr.json hold the same keys, the same variables and the same plural shape', () => {
  assert.deepEqual(Object.keys(en).sort(), Object.keys(fr).sort(), 'the same keys');
  for (const k of Object.keys(en)) {
    assert.deepEqual([...vars(en[k])].sort(), [...vars(fr[k])].sort(), `the same variables in ${k}`);
    assert.equal(typeof en[k], typeof fr[k], `the same shape for ${k}`);
    if (typeof en[k] === 'object') assert.ok('other' in en[k] && 'other' in fr[k], `${k} has an other form`);
    if (typeof en[k] === 'string') assert.ok(en[k].trim() && fr[k].trim(), `${k} is not empty`);
  }
});

// The files of public/ the app serves, the dictionaries and the brand aside
const files = (dir) => readdirSync(dir, { withFileTypes: true }).flatMap((d) => {
  const p = path.join(dir, d.name);
  if (d.isDirectory()) return d.name === 'i18n' || d.name === 'brand' ? [] : files(p);
  return /\.(html|js)$/.test(d.name) ? [p] : [];
});

// The string literals of a script, comments dropped; a template gives its literal parts. A line holding `i18n-ok`
// is skipped (an identifier that happens to be French: an anchor, a query name).
const literals = (src) => {
  const out = []; let i = 0; let line = 1; const n = src.length; let prev = '';
  const lines = src.split('\n');
  const push = (s, l) => { if (!lines[l - 1]?.includes('i18n-ok')) out.push({ s, line: l }); };
  const readString = (q) => { const l = line; let s = ''; i++; while (i < n && src[i] !== q) { if (src[i] === '\\') { s += src[i + 1]; i += 2; continue; } if (src[i] === '\n') line++; s += src[i++]; } i++; push(s, l); };
  const readTemplate = () => {
    let l = line; let s = ''; i++;
    while (i < n && src[i] !== '`') {
      if (src[i] === '\\') { s += src[i + 1]; i += 2; continue; }
      if (src[i] === '$' && src[i + 1] === '{') { push(s, l); s = ' '; i += 2; code(1); l = line; continue; }
      if (src[i] === '\n') line++;
      s += src[i++];
    }
    i++; push(s, l);
  };
  const code = (depth) => {
    while (i < n) {
      const c = src[i];
      if (c === '\n') { line++; i++; continue; }
      if (c === '/' && src[i + 1] === '/') { while (i < n && src[i] !== '\n') i++; continue; }
      if (c === '/' && src[i + 1] === '*') { const e = src.indexOf('*/', i + 2); line += src.slice(i, e).split('\n').length - 1; i = e + 2; continue; }
      if (c === '/' && (/[(,=:[!&|?{};+\-*%<>~^]/.test(prev) || prev === '' || /\breturn$/.test(src.slice(Math.max(0, i - 8), i).trimEnd()))) {
        i++; let cls = false; while (i < n && (src[i] !== '/' || cls)) { if (src[i] === '\\') i++; else if (src[i] === '[') cls = true; else if (src[i] === ']') cls = false; i++; } i++; prev = 'x'; continue;
      }
      if (c === "'" || c === '"') { readString(c); prev = 'x'; continue; }
      if (c === '`') { readTemplate(); prev = 'x'; continue; }
      if (c === '{' && depth) depth++;
      if (c === '}' && depth) { depth--; if (!depth) { i++; return; } }
      if (!/\s/.test(c)) prev = c;
      i++;
    }
  };
  code(0);
  return out;
};

// The visible text of a page: text nodes and the attributes a person reads; its scripts go through literals()
const htmlTexts = (src) => {
  const out = []; const lineAt = (idx) => src.slice(0, idx).split('\n').length;
  for (const m of src.matchAll(/<script\b[^>]*>([\s\S]*?)<\/script>/g)) { const base = lineAt(m.index) - 1; for (const x of literals(m[1])) out.push({ s: x.s, line: base + x.line }); }
  const body = src.replace(/<!--[\s\S]*?-->/g, (c) => c.replace(/[^\n]/g, ' ')).replace(/<(script|style)\b[\s\S]*?<\/\1>/g, (c) => c.replace(/[^\n]/g, ' '));
  for (const m of body.matchAll(/\s(?:title|aria-label|placeholder|alt|value|content|label)="([^"]*)"/g)) out.push({ s: m[1], line: lineAt(m.index) });
  for (const m of body.matchAll(/>([^<]+)</g)) out.push({ s: m[1], line: lineAt(m.index) });
  return out;
};

// French: an accented letter, a guillemet, or a word of French (common words, and the words of fr.json that
// en.json does not use)
const STOP = 'le la les des du une est sont pas sur avec pour dans aucun aucune rien cette ces qui que et ou où au aux ton ta tes ses son sa plus encore déjà tout tous toutes fois ici puis sans chez vers par'.split(' ');
const enWords = new Set(Object.values(en).flatMap((v) => (typeof v === 'object' ? Object.values(v) : [v])).join(' ').toLowerCase().match(/[\p{L}]+/gu) || []);
const frWords = new Set(Object.values(fr).flatMap((v) => (typeof v === 'object' ? Object.values(v) : [v])).join(' ').toLowerCase().match(/[\p{L}]+/gu) || []);
const ALLOW = new Set(['escadrille', 'claude', 'code', 'mac', 'iphone', 'linear', 'github', 'conversation', 'architecture', 'session', 'sessions', 'plan', 'plans', 'note', 'notes', 'type', 'source', 'test', 'tests', 'pilote', 'poste', 'main', 'lit', 'journal', 'cli', 'propose']); // propose: English as well (the pilot's verb key, public/pilotlog.js)
const VOCAB = new Set([...STOP, ...[...frWords].filter((w) => w.length > 2 && !enWords.has(w) && !ALLOW.has(w))]);
const french = (s) => {
  const text = s.replace(/<[^>]*>/g, ' ').replace(/&\w+;/g, ' ').replace(/[\w-]+="[^"]*"?/g, ' ').replace(/\b[a-z]+(?:-[a-z]+)+\b/g, ' '); // tags, attributes, css-like names
  if (/[àâçéèêëîïôûùüÿœæÀÂÇÉÈÊÎÔÛ«»]/.test(text)) return true;
  const words = text.toLowerCase().match(/[\p{L}]+/gu) || [];
  const bare = text.trim(); if (/^[a-z]\w*(\.\w+)+$/i.test(bare)) return false; // a dictionary key
  if (/^[#/?.]|[_=:/.]/.test(bare) && /^[#/?=&a-z0-9_.:-]*$/.test(bare)) return false; // an anchor, a path, a key
  return words.some((w) => VOCAB.has(w));
};

test('no French text written by hand in public/: every visible text goes through the dictionaries', () => {
  const bad = [];
  for (const f of files(PUB)) {
    const src = readFileSync(f, 'utf8');
    const found = f.endsWith('.html') ? htmlTexts(src) : literals(src);
    for (const { s, line } of found) if (s.trim() && french(s)) bad.push(`${path.relative(ROOT, f)}:${line} ${s.trim().replace(/\s+/g, ' ').slice(0, 90)}`);
  }
  assert.deepEqual(bad, [], `${bad.length} French texts outside public/i18n/:\n${bad.join('\n')}`);
});

test('every key the code names exists in the dictionaries', () => {
  const missing = new Set();
  const scan = (src, where) => {
    for (const m of src.matchAll(/\bT\(\s*'([\w.-]+)'\s*[,)]/g)) if (!(m[1] in en)) missing.add(`${where} ${m[1]}`);
    for (const m of src.matchAll(/data-i18n(?:-html)?="([\w.-]+)"/g)) if (!(m[1] in en)) missing.add(`${where} ${m[1]}`);
    for (const m of src.matchAll(/data-i18n-attr="([^"]+)"/g)) for (const p of m[1].split(';')) { const k = p.split(':')[1]?.trim(); if (k && !(k in en)) missing.add(`${where} ${k}`); }
    for (const m of src.matchAll(/\bmsg\(\s*'([\w.-]+)'\s*[,)]/g)) if (!(m[1] in en)) missing.add(`${where} ${m[1]}`);
  };
  for (const f of files(PUB)) scan(readFileSync(f, 'utf8'), path.relative(ROOT, f));
  scan(readFileSync(path.join(ROOT, 'server.mjs'), 'utf8'), 'server.mjs');
  for (const f of readdirSync(path.join(ROOT, 'lib'))) if (f.endsWith('.mjs')) scan(readFileSync(path.join(ROOT, 'lib', f), 'utf8'), 'lib/' + f);
  assert.deepEqual([...missing], []);
});

test('t(): plurals, numbers, money and dates by Intl, the fallback to English, then the key', () => {
  const ctx = { console, Intl, Date, Object, JSON, Number, String };
  ctx.window = ctx; runInNewContext(readFileSync(path.join(PUB, 'i18n', 'i18n.js'), 'utf8'), ctx);
  const { make } = ctx.escadrilleI18n;
  const dicts = { en: { n: { one: '{n} session', other: '{n} sessions' }, hi: 'Hi {name}', only: 'only en' }, fr: { n: { one: '{n} session', other: '{n} sessions' }, hi: 'Salut {name}' } };
  const E = make({ dicts, lang: 'en' }).t; const F = make({ dicts, lang: 'fr' }).t;
  assert.equal(E('n', { n: 1 }), '1 session'); assert.equal(E('n', { n: 2 }), '2 sessions'); assert.equal(E('n', { n: 1200 }), '1,200 sessions');
  assert.equal(F('n', { n: 0 }), '0 session'); assert.equal(F('n', { n: 1.5 }), '1,5 session');
  assert.equal(F('hi', { name: 'Dev' }), 'Salut Dev'); assert.equal(F('only'), 'only en'); assert.equal(F('nope'), 'nope');
  assert.equal(E.usd(12.4), '$12.40'); assert.equal(F.usd(12.4), '12,40 $'); assert.equal(E.usd(1234), '$1,234');
  assert.match(F.date('2026-11-01T10:00:00Z'), /nov/); assert.match(E.date('2026-11-01T10:00:00Z'), /Nov/);
  assert.equal(E.date('nonsense'), '—');
});

test('the server: markers decoded by the language of the cookie, then Accept-Language, else French; /i18n.js holds both', () => {
  const key = Object.keys(en).find((k) => typeof en[k] === 'string' && !/\{/.test(en[k]) && en[k] !== fr[k]);
  const body = { error: msg(key), list: [{ text: 'x ' + msg(key) }], at: 3 };
  assert.deepEqual(deep('en', body), { error: en[key], list: [{ text: 'x ' + en[key] }], at: 3 });
  assert.equal(deep('fr', body).error, fr[key]);
  assert.equal(langOf({ headers: { cookie: 'a=1; escadrille-lang=en' } }), 'en');
  assert.equal(langOf({ headers: { 'accept-language': 'de-DE,en;q=0.8' } }), 'en');
  assert.equal(langOf({ headers: { 'accept-language': 'fr-FR' } }), 'fr');
  assert.equal(langOf({ headers: {} }), 'fr');
  const js = bundle(); assert.match(js, /escadrilleI18n\.init\(/); assert.ok(js.includes(JSON.stringify(en[key])));
});
