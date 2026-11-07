import test from 'node:test';
import assert from 'node:assert/strict';
import { nextWeeklyReset, limitsOf } from '../lib/status.mjs';

const now = Date.parse('2026-11-01T21:45:00Z');
test('a weekly reset already past moves forward by whole weeks, never « imminent »', () => {
  assert.equal(nextWeeklyReset('2026-11-01T13:00:00.000Z', now), '2026-11-08T13:00:00.000Z');
  assert.equal(nextWeeklyReset('2026-10-18T13:00:00.000Z', now), '2026-11-08T13:00:00.000Z');
  assert.equal(nextWeeklyReset('2026-11-08T13:00:00.000Z', now), '2026-11-08T13:00:00.000Z');
  assert.equal(nextWeeklyReset('nope', now), null);
});
test('the weekly block of the panel never carries a past reset', () => {
  const l = limitsOf({ quota: { weekly: 0.13, resetsAt: '2026-11-01T13:00:00.000Z', at: '2026-11-01T21:40:00Z' }, now });
  assert.equal(l.weekly.resetsAt, '2026-11-08T13:00:00.000Z');
  assert.equal(l.weekly.pct, 13);
});

test('the account line: plan and masked address from Claude Code config, nothing when absent', async () => {
  const { accountOf, maskEmail } = await import('../lib/status.mjs');
  const fs = await import('node:fs'); const os = await import('node:os'); const path = await import('node:path');
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'acct-'));
  assert.equal(accountOf(home), null);
  fs.writeFileSync(path.join(home, '.claude.json'), JSON.stringify({ oauthAccount: { planDisplayName: 'Ultra', emailAddress: 'dev@example.com', organizationRateLimitTier: 'default_claude_max_20x', accessToken: 'secret' } }));
  assert.deepEqual(accountOf(home), { plan: 'Ultra', email: 'dev@example.com', masked: 'd•••@example.com', tier: 'default_claude_max_20x' });
  assert.equal(maskEmail('x'), null);
});

test('claude -p /usage: the weekly and Fable windows, read without a model call', async () => {
  const { parseUsageText } = await import('../lib/status.mjs');
  const now = Date.parse('2026-11-02T00:30:00+01:00');
  const w = parseUsageText('You are currently using your subscription\n\nCurrent week (all models): 18% used · resets Nov 8 at 2pm (Europe/Paris)\nCurrent week (Fable): 29% used · resets Nov 8 at 2pm (Europe/Paris)\n\nWhat is contributing…', now);
  assert.equal(w.weekly.pct, 18); assert.equal(w.models.fable.weekly.pct, 29); assert.equal(w.fiveHour, null);
  assert.equal(new Date(w.weekly.resetsAt).getDate(), 8);
  assert.deepEqual(parseUsageText('nothing here', now), { weekly: null, fiveHour: null, models: {} });
});
