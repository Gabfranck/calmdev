// The thread's Markdown tables never cut a word in the middle: cells wrap at spaces, a wide table scrolls in its own box.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const css = readFileSync(new URL('../public/app.css', import.meta.url), 'utf8');
const rule = (sel) => css.split('\n').find((l) => l.startsWith(sel + ' {') || l.startsWith(sel + ' { '));

test('.md-table cells never break a word with overflow-wrap: anywhere', () => {
  const cells = rule('.md-table th, .md-table td');
  assert.ok(cells, 'the cell rule exists');
  assert.doesNotMatch(cells, /overflow-wrap:\s*(anywhere|break-word)/);
  assert.doesNotMatch(cells, /word-break:\s*(break-all|break-word)/);
  assert.match(cells, /overflow-wrap:\s*normal/);
  assert.match(cells, /hyphens:\s*auto/);
});

test('.md-table scrolls sideways in its own box', () => {
  assert.match(rule('.md-table'), /overflow-x:\s*auto/);
});

test('no other rule makes .md-table cells break anywhere', () => {
  for (const l of css.split('\n')) if (/\.md-table/.test(l)) assert.doesNotMatch(l, /overflow-wrap:\s*anywhere/);
});
