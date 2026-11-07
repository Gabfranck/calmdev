// GET /api/projects/logo never answers 404 (click robot, 2026-11-04: 36 lines of 404 for a worktree the page named):
// a project without a logo or unknown gets 204, a known one with a logo 200, and nothing outside a known project is read.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { logoAnswer } from '../lib/projectlogo.mjs';

test('a known project with a logo: 200 and the file; without one: 204', () => {
  const d = mkdtempSync(path.join(tmpdir(), 'logo-'));
  assert.deepEqual(logoAnswer({ project: d, known: [d] }), { status: 204 });
  mkdirSync(path.join(d, 'public')); writeFileSync(path.join(d, 'public', 'favicon.svg'), '<svg/>');
  const a = logoAnswer({ project: d, known: [d] });
  assert.equal(a.status, 200); assert.equal(a.logo.type, 'image/svg+xml');
});

test('an unknown project or none: 204, and its folder is never looked at', () => {
  let looked = 0; const find = () => { looked++; return { path: '/x.svg', type: 'image/svg+xml' }; };
  assert.deepEqual(logoAnswer({ project: '/a/worktree', known: ['/a'], find }), { status: 204 });
  assert.deepEqual(logoAnswer({ project: null, known: ['/a'], find }), { status: 204 });
  assert.equal(looked, 0);
});

test('the route answers through logoAnswer, with no 404 left', () => {
  const src = readFileSync(path.join(path.dirname(new URL(import.meta.url).pathname), '..', 'server.mjs'), 'utf8');
  const line = src.split('\n').find((l) => l.includes("url.pathname === '/api/projects/logo'"));
  assert.ok(line.includes('projectlogo.logoAnswer(')); assert.ok(!line.includes('404'));
});
