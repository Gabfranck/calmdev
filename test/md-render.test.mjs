// The markdown of the thread (public/md.js, shared by the Conversation and the plan page): tables, joined paragraphs,
// and what must not regress.
import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
const md = createRequire(import.meta.url)('../public/md.js');

test('a GFM table becomes a <table> with alignments', () => {
  const h = md('| Nom | Coût | Note |\n|:--|--:|:-:|\n| **A** | 12 $ | `x` |\n| B | 3 $ | ok |');
  assert.match(h, /^<div class="md-table"><table><thead>/);
  assert.equal((h.match(/<tr>/g) || []).length, 3);
  assert.match(h, /<th>Nom<\/th><th class="md-r">Coût<\/th><th class="md-c">Note<\/th>/);
  assert.match(h, /<td><strong>A<\/strong><\/td><td class="md-r">12 \$<\/td><td class="md-c"><code>x<\/code><\/td>/);
  assert.doesNotMatch(h, /\|/);
});

test('table cells are escaped; a pipe in code or escaped stays text', () => {
  const h = md('| a | b |\n|---|---|\n| <img src=x onerror=1> | `a|b` \\| c |');
  assert.doesNotMatch(h, /<img/);
  assert.match(h, /&lt;img src=x onerror=1&gt;/);
  assert.match(h, /<code>a\|b<\/code> \| c/);
});

test('a table ends at the blank line; text around it stays', () => {
  const h = md('Avant\n\n| a | b |\n|---|---|\n| 1 | 2 |\n\nAprès');
  assert.match(h, /^<p>Avant<\/p><div class="md-table">.*<\/div><p>Après<\/p>$/);
});

test('a pipe line without a separator is not a table', () => {
  const h = md('a | b\nc | d');
  assert.doesNotMatch(h, /<table/);
  assert.equal(h, '<p>a | b c | d</p>');
});

test('lines of one paragraph join with a space', () => {
  assert.equal(md('une ligne\nla suite\nfin'), '<p>une ligne la suite fin</p>');
});

test('a blank line separates paragraphs; two spaces or a backslash force a <br>', () => {
  assert.equal(md('un\n\ndeux'), '<p>un</p><p>deux</p>');
  assert.equal(md('un  \ndeux'), '<p>un<br>deux</p>');
  assert.equal(md('un\\\ndeux'), '<p>un<br>deux</p>');
});

test('lists, headings and code keep their lines', () => {
  assert.equal(md('- a\n- b\n1. c'), '<ul><li>a</li><li>b</li></ul><ol><li>c</li></ol>');
  assert.equal(md('# Titre\ntexte'), '<h2>Titre</h2><p>texte</p>');
  assert.equal(md('```\nl1\nl2\n```'), '<pre><code>l1\nl2</code></pre>');
  assert.equal(md('- a\n  suite\n- b'), '<ul><li>a suite</li><li>b</li></ul>');
});

test('a numbered list split by blank lines stays one list and keeps its first number', () => {
  assert.equal(md('1. a\n\n2. b\n\n3. c'), '<ol><li>a</li><li>b</li><li>c</li></ol>');
  assert.equal(md('3. x\n4. y'), '<ol start="3"><li>x</li><li>y</li></ol>');
  assert.equal(md('- a\n\ntexte'), '<ul><li>a</li></ul><p>texte</p>');
});

test('an indented code fence stays a code block, inside its list item', () => {
  assert.equal(md('- a\n  ```\n  l1\n    l2\n  ```\n- b'), '<ul><li>a<pre><code>l1\n  l2</code></pre></li><li>b</li></ul>');
  assert.equal(md('  ```js\nx\n  ```'), '<pre><code>x</code></pre>');
});

test('raw HTML is escaped, inline marks render', () => {
  assert.equal(md('<script>alert(1)</script> **gras** `code`'), '<p>&lt;script&gt;alert(1)&lt;/script&gt; <strong>gras</strong> <code>code</code></p>');
});
