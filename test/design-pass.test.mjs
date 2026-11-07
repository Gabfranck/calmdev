// Phase 7, session P: the design pass. One face on every project screen and the pre-review's reasons cut to ten
// words. The project line of the top bar and the sidebar of tools became the one sidebar in phase 9 (test/sidebar.test.mjs).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { tenWords } from '../lib/prereview.mjs';

const PUB = path.join(path.dirname(new URL(import.meta.url).pathname), '..', 'public');
const read = (f) => readFileSync(path.join(PUB, f), 'utf8');
const SCREENS = ['index.html', 'resources.html', 'flow.html', 'plan.html', 'review.html', 'architecture.html'];

test('every project screen loads the one face and the one sidebar', () => {
  for (const f of SCREENS) {
    const html = read(f);
    // the one face is the system stack of app.css (--font, --mono); no web font from outside (test/local-fonts.test.mjs)
    assert.match(html, /href="\/app\.css/, f + ' loads the face (app.css)'); assert.doesNotMatch(html, /fonts\.(googleapis|gstatic)\.com/, f + ' calls no Google Fonts');
    assert.match(html, /<script src="\/sidebar\.js"><\/script>/, f + ' loads the sidebar');
  }
});

test('the review without ?project= takes the project the home would take: the stored one, else the last escadrille', () => {
  const html = read('review.html');
  assert.match(html, /localStorage\.getItem\('escadrille\.project'\)/);
  assert.match(html, /escadrilleProjects\.current\(\{ search: location\.search, stored: null, escadrilles/);
  assert.match(html, /<script src="\/projects\.js"><\/script>\s*<script src="\/sidebar\.js"><\/script>\s*<script>/);
});

test('the pre-review shows a reason in ten words at most', () => {
  assert.equal(tenWords('migration'), 'migration');
  const long = 'règle enfreinte : aucune session ne pousse sur main sans une revue de Dev';
  const out = tenWords(long);
  assert.equal(out.split(' ').length, 10); assert.ok(out.endsWith('…'));
  assert.equal(tenWords(null), '');
});
