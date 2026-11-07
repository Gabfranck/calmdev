// Phase 11, G: public/ux.js, the interaction contract shared by every page (docs/phase11/ux.md §2). No browser: a
// minimal DOM is simulated (elements that focus, contain, close and match a few selectors), enough for the stack of
// layers, the focus given back, Escape on a <details> and on an [aria-expanded] line, the arrows and the keys sheet.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { runInNewContext } from 'node:vm';
import path from 'node:path';
import { i18nInto } from './i18n-env.mjs';

const SRC = readFileSync(path.join(path.dirname(new URL(import.meta.url).pathname), '..', 'public', 'ux.js'), 'utf8');

// The fake DOM: tag, attributes, children, parent; closest() and matches() know [attr], [attr="v"], tag and details[open]
const make = () => {
  const listeners = {};
  const doc = { activeElement: null, readyState: 'complete', addEventListener: (t, f) => { (listeners[t] ||= []).push(f); }, removeEventListener() {} };
  class El {
    constructor(tag, attrs = {}) { this.tagName = tag.toUpperCase(); this.attrs = { ...attrs }; this.children = []; this.parentElement = null; this.isConnected = true; this.hidden = false; this.clicks = 0; this.onclick = null; }
    get open() { return 'open' in this.attrs; } set open(v) { if (v) this.attrs.open = ''; else delete this.attrs.open; }
    get id() { return this.attrs.id || ''; }
    get attributes() { return Object.entries(this.attrs).map(([name, value]) => ({ name, value })); }
    getAttribute(k) { return k in this.attrs ? this.attrs[k] : null; } setAttribute(k, v) { this.attrs[k] = String(v); } hasAttribute(k) { return k in this.attrs; } removeAttribute(k) { delete this.attrs[k]; }
    append(...cs) { for (const c of cs) { c.parentElement = this; this.children.push(c); } return this; }
    contains(o) { for (let n = o; n; n = n.parentElement) if (n === this) return true; return false; }
    getClientRects() { return this.hidden ? [] : [1]; }
    focus() { doc.activeElement = this; }
    click() { this.clicks++; if (this.onclick) this.onclick(); }
    matches(sel) { return sel.split(',').some((s) => one(this, s.trim())); }
    closest(sel) { for (let n = this; n; n = n.parentElement) if (n.matches(sel)) return n; return null; }
    querySelectorAll(sel) { const out = []; const walk = (n) => { for (const c of n.children) { if (c.matches(sel)) out.push(c); walk(c); } }; walk(this); return out; }
    querySelector(sel) { return this.querySelectorAll(sel)[0] || null; }
  }
  const one = (el, s) => {
    const m = s.match(/^([a-z]*)((?:\[[^\]]+\])*)(?::not\(\[([^=\]]+)(?:="([^"]*)")?\]\))*$/i); if (!m) return false;
    if (m[1] && el.tagName !== m[1].toUpperCase()) return false;
    for (const a of m[2].matchAll(/\[([^=\]]+)(?:="([^"]*)")?\]/g)) { if (!(a[1] in el.attrs)) return false; if (a[2] !== undefined && el.attrs[a[1]] !== a[2]) return false; }
    return true;
  };
  const body = new El('body');
  doc.body = body; doc.documentElement = new El('html').append(body);
  doc.getElementById = (id) => doc.documentElement.querySelectorAll(`[id="${id}"]`)[0] || null;
  doc.querySelector = (s) => doc.documentElement.querySelector(s);
  doc.createElement = (t) => new El(t);
  const window = { document: doc, Event: class { constructor(t) { this.type = t; } }, setTimeout, clearTimeout, innerWidth: 1440, innerHeight: 900 };
  window.window = window; i18nInto(window); runInNewContext(SRC, window);
  const key = (k, target = doc.activeElement, extra = {}) => { const e = { key: k, target, defaultPrevented: false, preventDefault() { this.defaultPrevented = true; }, stopImmediatePropagation() {}, ...extra }; for (const f of listeners.keydown || []) f(e); return e; };
  return { UX: window.escadrilleUX, doc, El, body, key };
};

test('the layers: Escape closes the last one opened, calls its close and gives the focus back to its trigger', () => {
  const { UX, doc, El, body, key } = make();
  const b1 = new El('button'); const p1 = new El('div'); const b2 = new El('button'); const p2 = new El('div');
  body.append(b1, p1); p1.append(b2); body.append(p2);
  const closed = [];
  b1.focus(); UX.open(p1, { close: () => closed.push('p1') });
  b2.focus(); UX.open(p2, { close: () => closed.push('p2') });
  assert.equal(UX.stack.length, 2);
  assert.ok(key('Escape').defaultPrevented); assert.deepEqual(closed, ['p2']); assert.equal(doc.activeElement, b2);
  key('Escape'); assert.deepEqual(closed, ['p2', 'p1']); assert.equal(doc.activeElement, b1);
  assert.equal(key('Escape').defaultPrevented, false, 'nothing left: Escape is not taken');
});

test('close() from the code: the layer leaves, the focus goes back, or to `restore` when a render replaced the trigger', () => {
  const { UX, doc, El, body } = make();
  const b = new El('button', { 'data-read': 'x' }); const p = new El('div'); body.append(b, p);
  b.focus(); UX.open(p, { restore: '[data-read="x"]' });
  b.isConnected = false; body.children = body.children.filter((c) => c !== b); const b2 = new El('button', { 'data-read': 'x' }); body.append(b2);
  doc.activeElement = null; assert.ok(UX.close(p)); assert.equal(doc.activeElement, b2, 'the new button of the same data-*');
  assert.equal(UX.close(p), false, 'twice is nothing');
});

test('a layer whose element left the page is forgotten: Escape goes to the one below', () => {
  const { UX, doc, El, body, key } = make();
  const b = new El('button'); const p = new El('div'); const gone = new El('div'); body.append(b, p, gone);
  let n = 0; b.focus(); UX.open(p, { close: () => n++ }); UX.open(gone, { trigger: null });
  gone.isConnected = false; key('Escape'); assert.equal(n, 1); assert.equal(doc.activeElement, b);
});

test('without a layer: an open <details> holding the focus closes, the focus on its summary', () => {
  const { doc, El, body, key } = make();
  const d = new El('details', { open: '' }); const s = new El('summary'); const a = new El('button'); d.append(s, a); body.append(d);
  a.focus(); assert.ok(key('Escape').defaultPrevented); assert.equal(d.open, false); assert.equal(doc.activeElement, s);
});

test('without a layer: an [aria-expanded="true"] line is clicked shut (its own toggle), or forced shut, and keeps the focus', () => {
  const { doc, El, body, key } = make();
  const line = new El('button', { 'aria-expanded': 'true', 'aria-controls': 'why1' }); const why = new El('div', { id: 'why1' }); body.append(line, why);
  line.onclick = () => line.setAttribute('aria-expanded', 'false');
  line.focus(); key('Escape'); assert.equal(line.clicks, 1); assert.equal(line.getAttribute('aria-expanded'), 'false'); assert.equal(doc.activeElement, line);
  const stuck = new El('div', { 'aria-expanded': 'true', 'aria-controls': 'why2', tabindex: '0' }); const w2 = new El('div', { id: 'why2' }); body.append(stuck, w2);
  stuck.focus(); key('Escape'); assert.equal(stuck.getAttribute('aria-expanded'), 'false'); assert.equal(w2.hidden, true);
});

test('a re-rendered line: after its toggle replaced it, the focus goes to the new line of the same data-*', () => {
  const { doc, El, body, key } = make();
  const line = new El('button', { 'aria-expanded': 'true', 'data-line': '7' }); body.append(line);
  let fresh = null;
  line.onclick = () => { line.isConnected = false; body.children = []; fresh = new El('button', { 'aria-expanded': 'false', 'data-line': '7' }); body.append(fresh); };
  line.focus(); key('Escape'); assert.equal(doc.activeElement, fresh);
});

test('a search field: Escape empties it first, and the input event tells its screen', () => {
  const { El, body, key } = make();
  const f = new El('input', { type: 'search' }); f.type = 'search'; f.value = 'abc'; const seen = []; f.dispatchEvent = (e) => seen.push(e.type); body.append(f);
  f.focus(); assert.ok(key('Escape').defaultPrevented); assert.equal(f.value, ''); assert.deepEqual(seen, ['input']);
});

test('next(): the arrows both ways, Home and End, never looping, by orientation', () => {
  const { UX } = make();
  assert.equal(UX.next(0, 3, 'ArrowDown'), 1); assert.equal(UX.next(1, 3, 'ArrowUp'), 0);
  assert.equal(UX.next(2, 3, 'ArrowDown'), 2, 'no loop at the end'); assert.equal(UX.next(0, 3, 'ArrowUp'), 0, 'no loop at the start');
  assert.equal(UX.next(1, 3, 'Home'), 0); assert.equal(UX.next(0, 3, 'End'), 2);
  assert.equal(UX.next(0, 3, 'ArrowRight'), -1, 'vertical ignores ← →'); assert.equal(UX.next(0, 3, 'ArrowRight', 'horizontal'), 1);
  assert.equal(UX.next(1, 3, 'ArrowUp', 'both'), 0); assert.equal(UX.next(-1, 3, 'ArrowUp'), 2); assert.equal(UX.next(0, 0, 'ArrowDown'), -1);
});

test('keys(): one row per key of the screen, then the keys of every screen', () => {
  const { UX } = make();
  const h = UX.keysHTML([[['↑', '↓'], 'dans l’arbre des fichiers'], ['Entrée', 'ouvrir']]);
  const rows = [...h.matchAll(/<li>/g)].length; assert.equal(rows, 5);
  assert.match(h, /<kbd>↑<\/kbd> <kbd>↓<\/kbd><\/span><span>dans l’arbre des fichiers/);
  assert.match(h, /<kbd>1<\/kbd> <kbd>2<\/kbd> <kbd>3<\/kbd> <kbd>4<\/kbd><\/span><span>Conversation, Ressources, Flot, Revue/);
  assert.match(h, /<kbd>Échap<\/kbd><\/span><span>fermer/); assert.match(h, /<kbd>\?<\/kbd><\/span><span>cette aide/);
});

test('nearest(): the nearest box that way on a map, ahead along the axis, the distance across counted twice', () => {
  const { UX } = make();
  // a 2 × 2 grid and a far box on the right of the first row
  const r = [{ x: 0, y: 0, w: 100, h: 40 }, { x: 200, y: 0, w: 100, h: 40 }, { x: 0, y: 100, w: 100, h: 40 }, { x: 200, y: 100, w: 100, h: 40 }, { x: 600, y: 10, w: 100, h: 40 }];
  assert.equal(UX.nearest(r, 0, 'ArrowRight'), 1); assert.equal(UX.nearest(r, 1, 'ArrowLeft'), 0, 'both ways');
  assert.equal(UX.nearest(r, 0, 'ArrowDown'), 2); assert.equal(UX.nearest(r, 2, 'ArrowUp'), 0);
  assert.equal(UX.nearest(r, 1, 'ArrowRight'), 4, 'the far box on the same row'); assert.equal(UX.nearest(r, 0, 'ArrowLeft'), -1, 'nothing that way');
  assert.equal(UX.nearest(r, 0, 'Enter'), -1);
});

test('keys() takes a function: a page that holds several screens gives the rows of the one shown', () => {
  const { UX } = make();
  let screen = 'memory'; UX.keys(() => (screen === 'memory' ? [[['/'], 'chercher']] : []));
  assert.equal([...UX.keysHTML([() => (screen === 'memory' ? [[['/'], 'chercher']] : [])]).matchAll(/<li>/g)].length, 4);
  screen = 'other'; assert.equal([...UX.keysHTML([() => (screen === 'memory' ? [[['/'], 'chercher']] : [])]).matchAll(/<li>/g)].length, 3);
});
