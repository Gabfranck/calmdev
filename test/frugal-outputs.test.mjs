// The measure of the biggest tool outputs (scripts/frugal-outputs.mjs) on a made-up transcript
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { outputsOf, measure, imageTokens } from '../scripts/frugal-outputs.mjs';

const ts = '2026-11-01T10:00:00Z';
const call = (id, ctx, output = 10, tools = []) => JSON.stringify({ type: 'assistant', timestamp: ts, message: { id, model: 'claude-opus-5-5', usage: { input_tokens: 0, cache_creation_input_tokens: 0, cache_read_input_tokens: ctx, output_tokens: output }, content: tools } });
const result = (id, content) => JSON.stringify({ type: 'user', timestamp: ts, message: { content: [{ type: 'tool_result', tool_use_id: id, content }] } });
const big = Array.from({ length: 1000 }, (_, i) => `line ${i} of the output`).join('\n'); // 23 890 chars

const transcript = [
  call('a', 1000, 10, [{ type: 'tool_use', id: 't1', name: 'Read', input: { file_path: 'big.log' } }]),
  result('t1', big),
  call('b', 1000 + 10 + 6000, 10, [{ type: 'tool_use', id: 't2', name: 'Bash', input: { command: 'ls' } }]),
  result('t2', 'short'),
  call('c', 8000), call('d', 8100),
  JSON.stringify({ type: 'system', subtype: 'compact_boundary', timestamp: ts }),
  call('e', 2000),
].join('\n');

test('outputsOf finds each output, its tool, and the later calls up to a compaction', () => {
  const o = outputsOf(transcript, 'f.jsonl');
  assert.equal(o.results.length, 2);
  assert.equal(o.results[0].tool, 'Read'); assert.equal(o.results[0].input.file_path, 'big.log');
  assert.equal(o.results[0].later.length, 2, 'b writes it, c and d read it again, e comes after the compaction');
  assert.equal(o.ratios.length, 2);
  assert.ok(Math.abs(o.ratios[0] - big.length / 6000) < 0.01, 'chars per token from the context growth');
});

test('measure ranks the outputs and prices them with and without the cap', () => {
  const root = mkdtempSync(path.join(tmpdir(), 'frugal-m-')); mkdirSync(path.join(root, 'p'));
  writeFileSync(path.join(root, 'p', 's.jsonl'), transcript);
  const m = measure({ root, days: ['2026-11-01'], top: 5, limits: { lines: 20, bytes: 16384, jsonBytes: 8192 } });
  assert.equal(m.outputs, 2);
  const [first] = m.top;
  assert.match(first.what, /^Read big\.log/);
  assert.equal(first.reads, 2);
  assert.ok(first.capped < first.tokens / 10, 'cut to 20 lines');
  assert.ok(first.withCap < first.now / 5);
  assert.equal(m.cutCount, 1);
});

test('imageTokens reads a PNG size and falls back to 1600', () => {
  const png = Buffer.alloc(32); png.writeUInt32BE(0x89504e47, 0); png.writeUInt32BE(750, 16); png.writeUInt32BE(1000, 20);
  assert.equal(imageTokens(png.toString('base64')), 1000);
  assert.equal(imageTokens('garbage'), 1600);
});
