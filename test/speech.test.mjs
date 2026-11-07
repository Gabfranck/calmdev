import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';
import { i18nInto } from './i18n-env.mjs';

const src = readFileSync(new URL('../public/speech.js', import.meta.url), 'utf8');

const el = (extra = {}) => {
  const l = {}; const attrs = {};
  return { listeners: l, attrs, value: '', title: '', disabled: false, hidden: false, textContent: '', ownerDocument: null,
    addEventListener(t, f) { (l[t] ||= []).push(f); },
    fire(t, ev = {}) { for (const f of l[t] || []) f(ev); },
    dispatchEvent(e) { (l[e.type] ||= []).length; this.lastEvent = e.type; },
    setAttribute(k, v) { attrs[k] = String(v); },
    querySelector: () => null,
    insertAdjacentElement() {},
    ...extra };
};

const load = (win) => { const ctx = vm.createContext({ ...win, Event }); ctx.window = ctx; i18nInto(ctx); vm.runInContext(src, ctx); return ctx; };

test('without SpeechRecognition: button disabled with a reason, nothing thrown', () => {
  const w = load({}); const f = el(); const b = el();
  const d = w.attachDictation(f, b);
  assert.equal(d.supported, false);
  assert.equal(b.disabled, true);
  assert.match(b.title, /Chrome|Safari/);
  const h = el(); w.attachDictation(f, h, { fallback: 'hide' });
  assert.equal(h.hidden, true);
  assert.doesNotThrow(() => w.attachDictation(null, null));
});

test('with SpeechRecognition: inserts at the cursor, stops on Escape', () => {
  const recs = [];
  class FakeSR { constructor() { recs.push(this); } start() { this.onstart(); } stop() { this.stopped = true; this.onend(); } }
  const w = load({ SpeechRecognition: FakeSR });
  const f = el({ value: 'Bonjour  monde', selectionStart: 8, selectionEnd: 8 }); const b = el();
  const d = w.attachDictation(f, b);
  assert.equal(d.supported, true);
  b.fire('click');
  assert.equal(b.attrs['aria-pressed'], 'true');
  assert.equal(recs[0].lang, 'fr-FR');
  recs[0].onresult({ resultIndex: 0, results: [Object.assign([{ transcript: ' le beau ' }], { isFinal: true })] });
  assert.equal(f.value, 'Bonjour le beau monde');
  assert.equal(f.selectionStart, 'Bonjour le beau'.length);
  assert.equal(f.lastEvent, 'input');
  f.fire('keydown', { key: 'Escape' });
  assert.equal(recs[0].stopped, true);
  assert.equal(b.attrs['aria-pressed'], 'false');
  b.fire('click'); b.fire('click'); // start, then stop on the second click
  assert.equal(recs[1].stopped, true);
});

test('not-allowed gives one line under the field', () => {
  class FakeSR { start() { this.onerror({ error: 'not-allowed' }); this.onend(); } stop() {} }
  const w = load({ SpeechRecognition: FakeSR }); const status = el(); const f = el(); const b = el();
  w.attachDictation(f, b, { status });
  b.fire('click');
  assert.match(status.textContent, /refusé/);
});
