// The five-hour window read from `claude -p /usage` (lib/status.mjs parseUsageText, docs/limits.md « La source sans token »).
// test/fixtures/usage-2026-11-02.txt is the only real output kept (the pilot's reading, 2 November 00:30, cut after
// « What is contributing… »): it carries no five-hour line. The other forms below are plausible, never seen: each one is
// tested so that the day Claude Code prints it, the panel reads it; a form not listed is skipped, never guessed.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, mkdtempSync, writeFileSync, chmodSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { parseUsageText, parseResetText, measureUsage, redactUsage, limitsOf } from '../lib/status.mjs';
import { rowsOf } from '../lib/limits.mjs';
// Fake home folders are assembled at run time: scripts/trace-scan.mjs takes a written one for a real one.
const USERS = '/Users'; const HOMES = '/home';

const REAL = readFileSync(new URL('./fixtures/usage-2026-11-02.txt', import.meta.url), 'utf8');
const NOW = new Date(2026, 10, 2, 15, 30).getTime(); // 2 November, 15:30 local
const local = (iso) => { const d = new Date(iso); return [d.getDate(), d.getHours(), d.getMinutes()]; };

test('the real /usage of 2 November: weekly and Fable read, no five-hour window (none printed)', () => {
  const w = parseUsageText(REAL, NOW);
  assert.equal(w.weekly.pct, 18); assert.equal(w.models.fable.weekly.pct, 29);
  assert.equal(w.fiveHour, null);
  const rows = rowsOf({ claude: limitsOf({ measured: { at: new Date(NOW).toISOString(), ...w }, now: NOW }), now: NOW });
  assert.equal(rows.find((r) => r.id === 'fiveHour').reason, 'unmeasured');
});

const FORMS = [
  ['Current session: 12% used · resets 7pm (Europe/Paris)', 12, [2, 19, 0]],
  ['Current session (all models): 12% used · resets 7:30pm (Europe/Paris)', 12, [2, 19, 30]],
  ['Current session (5-hour): 40% used · resets in 2h 10m', 40, [2, 17, 40]],
  ['Current 5-hour window: 7.5% used · resets in 45m', 7.5, [2, 16, 15]],
  ['5-hour limit: 3% used - resets 19:00', 3, [2, 19, 0]],
  ['Current session: 61% used · resets 1am (Europe/Paris)', 61, [3, 1, 0]], // 1am is past today: tomorrow
  ['Current session: 61% used · resets 3pm', 61, [3, 15, 0]], // 3pm is half an hour ago: tomorrow, never the past
  ['Current session: 20% used · resets tomorrow at 9am', 20, [3, 9, 0]],
  ['Current session: 20% used · resets Nov 2 at 6pm (Europe/Paris)', 20, [2, 18, 0]],
];
for (const [line, pct, at] of FORMS) {
  test(`five-hour form: ${line}`, () => {
    const w = parseUsageText(`${REAL}\n${line}\n`, NOW);
    assert.equal(w.fiveHour.pct, pct); assert.deepEqual(local(w.fiveHour.resetsAt), at);
    assert.ok(Date.parse(w.fiveHour.resetsAt) > NOW, 'a five-hour reset is never in the past');
    assert.equal(w.weekly.pct, 18, 'the weekly line still wins its slot');
  });
}

test('the five-hour line with no reset: the share, the reset null (never guessed)', () => {
  assert.deepEqual(parseUsageText('Current session: 9% used', NOW).fiveHour, { utilization: 0.09, pct: 9, resetsAt: null });
  assert.equal(parseUsageText('Current session: 9% used · resets soonish', NOW).fiveHour.resetsAt, null);
});

test('lines not understood are skipped, never guessed', () => {
  for (const s of ['Current session: lots used', 'Current session: 140% used', 'Session started 12% ago', 'Current session (5-hour) 12%', 'Current week (all models): 18% left'])
    assert.deepEqual(parseUsageText(s, NOW), { weekly: null, fiveHour: null, models: {} }, s);
  for (const s of ['25pm', '7:75pm', 'in a while', '', 'Foo 8 at 2pm']) assert.equal(parseResetText(s, NOW), null, s);
});

test('a model five-hour window goes under the model, the main one stays apart', () => {
  const w = parseUsageText('Current session (all models): 30% used · resets 7pm\nCurrent session (Opus): 50% used · resets 7pm', NOW);
  assert.equal(w.fiveHour.pct, 30); assert.equal(w.models.opus.fiveHour.pct, 50);
});

test('the panel row: a percentage and a reset ahead; read before a reset now past, « reset », never the past', () => {
  const w = parseUsageText(`${REAL}\nCurrent session: 12% used · resets 7pm (Europe/Paris)\n`, NOW);
  const measured = { at: new Date(NOW).toISOString(), ...w };
  const row = rowsOf({ claude: limitsOf({ measured, now: NOW }), now: NOW }).find((r) => r.id === 'fiveHour');
  assert.equal(row.pct, 12); assert.ok(Date.parse(row.resetsAt) > NOW);
  const later = NOW + 4 * 36e5; // 19:30, the window restarted at 19:00
  const after = rowsOf({ claude: limitsOf({ measured, now: later }), now: later }).find((r) => r.id === 'fiveHour');
  assert.equal(after.pct, null); assert.equal(after.reason, 'reset'); assert.ok(Date.parse(after.resetsAt) > later);
});

const fakeClaude = (dir, text) => {
  const out = path.join(dir, 'out.json'); writeFileSync(out, JSON.stringify({ type: 'result', result: text }));
  const bin = path.join(dir, 'claude'); writeFileSync(bin, `#!/bin/sh\ncat '${out}'\n`); chmodSync(bin, 0o755); return bin;
};

test('measureUsage: no five-hour window in the answer, its raw text is kept, redacted', async () => {
  const dir = mkdtempSync(path.join(tmpdir(), 'usage-'));
  const rawFile = path.join(dir, '.escadrille', 'usage-raw.txt');
  const m = await measureUsage({ claude: fakeClaude(dir, `${REAL}\nAccount: someone@example.com\n`), rawFile, timeoutMs: 10e3 });
  assert.equal(m.weekly.pct, 18); assert.equal(m.fiveHour, null);
  const kept = readFileSync(rawFile, 'utf8');
  assert.match(kept, /Current week \(Fable\): 29% used/); assert.doesNotMatch(kept, /someone@example\.com/);
});

test('measureUsage: a five-hour window read, nothing kept', async () => {
  const dir = mkdtempSync(path.join(tmpdir(), 'usage-'));
  const rawFile = path.join(dir, 'usage-raw.txt');
  const m = await measureUsage({ claude: fakeClaude(dir, `${REAL}\nCurrent session: 12% used · resets in 3h\n`), rawFile, timeoutMs: 10e3 });
  assert.equal(m.fiveHour.pct, 12); assert.equal(existsSync(rawFile), false);
});

test('redactUsage: addresses, home folders and long tokens go', () => {
  const s = redactUsage(`a@b.io ${USERS}/someone/x sk-abcdefghijklmnop gab`, { home: `${USERS}/someone`, user: 'gab' });
  assert.doesNotMatch(s, /a@b\.io|someone|sk-abc|gab/);
});
