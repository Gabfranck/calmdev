import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, existsSync, writeFileSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { writeHandoff, handoffFile, archiveFile, TOO_LONG } from '../lib/pilothandoff.mjs';

const proj = () => mkdtempSync(path.join(tmpdir(), 'handoff-'));
const day = new Date('2026-11-07T10:00:00Z');

test('a 6 KB handoff is refused with the one-sentence instruction and nothing is touched', () => {
  const p = proj();
  const r = writeHandoff(p, 'x'.repeat(6 * 1024), day);
  assert.equal(r.ok, false);
  assert.match(r.reason, /^Passation trop longue : garde l’état présent et la suite, l’historique part en archive/);
  assert.equal(r.reason, TOO_LONG);
  assert.equal(existsSync(handoffFile(p)), false);
  assert.equal(existsSync(archiveFile(p, day)), false);
});

test('a valid rewrite leaves the old handoff readable in the dated archive', () => {
  const p = proj();
  mkdirSync(path.dirname(handoffFile(p)), { recursive: true });
  writeFileSync(handoffFile(p), 'ancienne passation\n');
  const r = writeHandoff(p, 'nouvelle passation', day);
  assert.equal(r.ok, true);
  assert.match(archiveFile(p, day), /passation-pilote-archive-2026-11-07\.md$/);
  assert.match(readFileSync(archiveFile(p, day), 'utf8'), /ancienne passation/);
  assert.equal(readFileSync(handoffFile(p), 'utf8'), 'nouvelle passation\n');
});

test('two rewrites the same day keep both old handoffs', () => {
  const p = proj();
  assert.equal(writeHandoff(p, 'un', day).ok, true);
  assert.equal(writeHandoff(p, 'deux', day).ok, true);
  assert.equal(writeHandoff(p, 'trois', day).ok, true);
  const a = readFileSync(archiveFile(p, day), 'utf8');
  assert.match(a, /un/); assert.match(a, /deux/); assert.doesNotMatch(a, /trois/);
  assert.ok(a.indexOf('un') < a.indexOf('deux'));
});
