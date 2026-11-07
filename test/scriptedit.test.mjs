// PIL 6: a file rewritten by script is named, then refused in one line (lib/scriptedit.mjs, rule of lib/policy.mjs)
import test from 'node:test';
import assert from 'node:assert/strict';
import { scriptEditOf, scriptEditLine } from '../lib/scriptedit.mjs';
import { EDIT_RULE } from '../lib/planner.mjs';

test('PIL 6 édition par script : sed -i, python, node, heredoc, cat >> sont refusés avec leur chemin', () => {
  assert.equal(scriptEditOf("sed -i '' 's/a/b/' lib/x.mjs"), 'lib/x.mjs');
  assert.equal(scriptEditOf("sed -i 's/a/b/' docs/y.md"), 'docs/y.md');
  assert.equal(scriptEditOf("python3 - <<'EOF'\nopen('server.mjs','w').write(s)\nEOF"), 'server.mjs');
  assert.equal(scriptEditOf(`node -e "require('fs').writeFileSync('a.json', x)"`), 'a.json');
  assert.equal(scriptEditOf("cat >> docs/pilot.md <<'EOF'\nx\nEOF"), 'docs/pilot.md');
  assert.equal(scriptEditOf('echo hi > notes.txt'), 'notes.txt');
  assert.equal(scriptEditOf('git log | tee out.log'), 'out.log');
  assert.equal(scriptEditLine('docs/pilot.md'), "Un fichier ne se modifie qu'avec Edit ou Write : script refusé sur docs/pilot.md");
});

test('PIL 6 édition par script : les lectures et les écritures temporaires passent', () => {
  for (const c of ['grep -n x lib/a.mjs', 'node --test test/a.test.mjs 2>&1 | head', 'ls > /dev/null', 'node --test > "$TMPDIR/suite.log" 2>&1', 'git status --short', "sed -n 1,20p server.mjs"]) assert.equal(scriptEditOf(c), null, c);
});

test('PIL 6 la consigne des sessions dit Edit ou Write', () => {
  assert.match(EDIT_RULE, /^Un fichier ne se modifie qu'avec Edit ou Write ; un script qui réécrit un fichier .* est refusé\.$/);
});
