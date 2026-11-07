// A model's row acts on its family only (fable, opus, sonnet, haiku), whatever the id's spelling: dated ids, Bedrock
// prefixes, aliases with a context suffix, or a /usage line that names « Claude Opus ». Other rows still act on all.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { modelKey, rowTouches } from '../lib/limits.mjs';

test('modelKey reads the family anywhere in the id', () => {
  for (const [id, fam] of [['claude-fable-5-1', 'fable'], ['opus', 'opus'], ['opus[1m]', 'opus'], ['claude-3-5-sonnet-20241022', 'sonnet'],
    ['us.anthropic.claude-haiku-5-5-v1:0', 'haiku'], ['Claude Opus', 'opus'], ['claude-sonnet-5-5', 'sonnet']]) assert.equal(modelKey(id), fam, id);
});

test('a model row touches its family only; other rows touch all', () => {
  const fable = { kind: 'model', model: 'fable' };
  assert.equal(rowTouches(fable, 'claude-fable-5-1'), true);
  assert.equal(rowTouches(fable, 'claude-opus-5-5'), false);
  assert.equal(rowTouches({ kind: 'model', model: 'claude opus' }, 'claude-opus-5-5'), true);
  assert.equal(rowTouches({ kind: 'model', model: 'claude opus' }, 'claude-3-5-sonnet-20241022'), false);
  assert.equal(rowTouches({ kind: 'model', model: 'sonnet' }, 'claude-3-5-sonnet-20241022'), true);
  assert.equal(rowTouches({ kind: 'model', model: 'opus' }, 'claude-3-5-sonnet-20241022'), false);
  assert.equal(rowTouches({ kind: 'weekly' }, 'claude-opus-5-5'), true);
  assert.equal(rowTouches(null, 'claude-opus-5-5'), true);
});
