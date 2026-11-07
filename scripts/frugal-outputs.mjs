#!/usr/bin/env node
// The biggest tool outputs of some days, read from Claude Code's JSONL transcripts, and what each cost
// with and without the frugal cap (docs/frugal.md, « Les sorties d'outils »). Read-only.
//
//   node scripts/frugal-outputs.mjs [--days 2026-11-01,2026-11-02] [--top 20] [--lines 200] [--bytes 16384] [--root ~/.claude/projects]
//
// An output enters the context once (a cache write) and is read again by every later call of the same
// conversation, until a compaction (cache reads): cost = tokens × (write + later calls × read), at the
// prices of lib/usage.mjs. Tokens of a text output: its characters over a ratio measured in the same
// transcripts (the context growth after a lone tool result); an image: Claude's size formula.
import { readdirSync, statSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { homedir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { priceOf } from '../lib/usage.mjs';
import { LIMITS } from '../lib/frugal.mjs';
import { capText } from '../lib/frugal-cap.mjs';

const arg = (k, d) => { const i = process.argv.indexOf('--' + k); return i > 0 ? process.argv[i + 1] : d; };

const walk = (dir, out = []) => {
  let list; try { list = readdirSync(dir, { withFileTypes: true }); } catch { return out; }
  for (const e of list) {
    const p = join(dir, e.name);
    if (e.isDirectory()) walk(p, out); else if (e.name.endsWith('.jsonl')) out.push(p);
  }
  return out;
};

// Claude's image cost: scaled to fit 1568 px on the long side and 1.15 megapixels, then w×h/750.
export const imageTokens = (b64 = '') => {
  let w = 0, h = 0;
  try {
    const b = Buffer.from(b64.slice(0, 64), 'base64');
    if (b.readUInt32BE(0) === 0x89504e47) { w = b.readUInt32BE(16); h = b.readUInt32BE(20); }
  } catch {}
  if (!w || !h) return 1600;
  const s = Math.min(1, 1568 / Math.max(w, h), Math.sqrt(1.15e6 / (w * h)));
  return Math.round((w * s) * (h * s) / 750);
};

const textOf = (content) => typeof content === 'string' ? content : (content || []).filter((b) => b.type === 'text').map((b) => b.text).join('\n');
const imagesOf = (content) => Array.isArray(content) ? content.filter((b) => b.type === 'image') : [];
const ctxOf = (u) => (u.input_tokens || 0) + (u.cache_creation_input_tokens || 0) + (u.cache_read_input_tokens || 0);
const localDay = (ts) => { const d = new Date(ts); return isNaN(d) ? '' : d.toLocaleDateString('sv'); };

// One transcript → its tool outputs with their position, and samples of chars per token.
export const outputsOf = (text, file = '') => {
  const calls = []; const seen = new Set(); const uses = new Map(); const results = []; const ratios = []; const compactAt = [];
  let pendingLone = null; // { chars, before: ctx+output of the previous call }
  for (const line of text.split('\n')) {
    let e; try { e = JSON.parse(line); } catch { continue; }
    if (e.type === 'system' && e.subtype === 'compact_boundary') { compactAt.push(calls.length); continue; }
    if (e.type === 'assistant' && e.message?.usage) {
      for (const b of e.message.content || []) if (b.type === 'tool_use') uses.set(b.id, b);
      if (seen.has(e.message.id)) continue;
      seen.add(e.message.id);
      const u = e.message.usage;
      if (pendingLone && calls.length) {
        const prev = calls[calls.length - 1];
        const delta = ctxOf(u) - prev.ctx - (prev.output || 0);
        if (delta > 200) ratios.push(pendingLone / delta);
      }
      pendingLone = null;
      calls.push({ model: e.message.model, ctx: ctxOf(u), output: u.output_tokens || 0, oneHour: (u.cache_creation?.ephemeral_1h_input_tokens || 0) > 0 });
      continue;
    }
    if (e.type !== 'user' || !Array.isArray(e.message?.content)) continue;
    const blocks = e.message.content.filter((b) => b.type === 'tool_result');
    if (blocks.length === 1 && !imagesOf(blocks[0].content).length) pendingLone = textOf(blocks[0].content).length; else pendingLone = null;
    for (const b of blocks) {
      const use = uses.get(b.tool_use_id) || {};
      const t = textOf(b.content);
      const imgs = imagesOf(b.content);
      results.push({ file, day: localDay(e.timestamp), at: calls.length, tool: use.name || '?', input: use.input || {}, text: t, imageTokens: imgs.reduce((s, i) => s + imageTokens(i.source?.data), 0), images: imgs.length, persisted: /Output too large|saved to|tool-results\//.test(t.slice(0, 400)) });
    }
  }
  // Later calls of the same context: up to the next compaction
  for (const r of results) {
    const end = compactAt.find((c) => c > r.at) ?? calls.length;
    r.later = calls.slice(r.at + 1, end);
    r.next = calls[r.at] || calls[calls.length - 1] || {};
  }
  return { results, ratios, calls: calls.length };
};

const cost = (tokens, r) => {
  const p = priceOf(r.next.model) || priceOf('claude-opus-5-5');
  const write = tokens * (r.next.oneHour ? p.cacheWrite1h : p.cacheWrite5m);
  const reads = r.later.reduce((s, c) => s + tokens * (priceOf(c.model) || p).cacheRead, 0);
  return (write + reads) / 1e6;
};

const label = (r) => {
  const i = r.input;
  const what = i.command || i.file_path || i.pattern || i.url || i.description || '';
  return `${r.tool} ${String(what).replace(/\s+/g, ' ').slice(0, 70)}`;
};

export const measure = ({ root, days, top = 20, limits = LIMITS }) => {
  const since = Math.min(...days.map((d) => new Date(d + 'T00:00:00').getTime())) - 864e5;
  const files = walk(root).filter((f) => { try { return statSync(f).mtimeMs >= since; } catch { return false; } });
  const all = []; const ratios = []; let persisted = 0;
  for (const f of files) {
    const o = outputsOf(readFileSync(f, 'utf8'), f.slice(root.length + 1));
    ratios.push(...o.ratios);
    for (const r of o.results) if (days.includes(r.day)) { all.push(r); if (r.persisted) persisted++; }
  }
  ratios.sort((a, b) => a - b);
  const ratio = ratios.length ? ratios[Math.floor(ratios.length / 2)] : 3.5;
  const POINTER = 60; // tokens of the cut line or the refusal that replaces the output
  for (const r of all) {
    r.tokens = Math.round(r.text.length / ratio) + r.imageTokens;
    // Only what the hook holds: a Read (refused once, counted as cut: an upper bound, the second try passes) and an
    // image; a Bash output stays whole (docs/frugal.md, « La réécriture de Bash, écartée »)
    const capped = r.images || r.tool !== 'Read' ? null : capText(r.text, limits);
    r.cappedTokens = r.images ? POINTER : capped?.cut ? Math.round(capped.text.length / ratio) + POINTER : r.tokens;
    r.costNow = cost(r.tokens, r); r.costCapped = cost(r.cappedTokens, r); r.reads = r.later.length;
  }
  all.sort((a, b) => b.tokens - a.tokens);
  const topList = all.slice(0, top);
  const sum = (xs, k) => xs.reduce((s, x) => s + x[k], 0);
  const cutAll = all.filter((r) => r.cappedTokens < r.tokens);
  return {
    files: files.length, outputs: all.length, ratio: Math.round(ratio * 100) / 100, ratioSamples: ratios.length, persisted,
    top: topList.map((r) => ({ what: label(r), file: r.file, day: r.day, lines: r.text.split('\n').length, images: r.images, tokens: r.tokens, capped: r.cappedTokens, reads: r.reads, now: r.costNow, withCap: r.costCapped })),
    topNow: sum(topList, 'costNow'), topCapped: sum(topList, 'costCapped'),
    allNow: sum(all, 'costNow'), allCapped: sum(all, 'costCapped'), cutCount: cutAll.length, cutNow: sum(cutAll, 'costNow'), cutCapped: sum(cutAll, 'costCapped'),
  };
};

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const days = String(arg('days', '2026-11-01,2026-11-02')).split(',');
  const m = measure({ root: arg('root', join(homedir(), '.claude', 'projects')), days, top: Number(arg('top', 20)), limits: { ...LIMITS, lines: Number(arg('lines', LIMITS.lines)), bytes: Number(arg('bytes', LIMITS.bytes)) } });
  const $ = (x) => x.toFixed(2).replace('.', ',') + ' $';
  console.log(`${m.files} transcriptions, ${m.outputs} sorties d'outils les ${days.join(' et ')} ; ${m.ratio} caractères par token (médiane de ${m.ratioSamples} mesures) ; ${m.persisted} sorties déjà mises de côté par Claude Code.\n`);
  console.log('| # | Sortie | Lignes | Tokens | Relue | Sans plafond | Avec plafond |\n|---|---|---|---|---|---|---|');
  m.top.forEach((r, i) => console.log(`| ${i + 1} | \`${r.what.replace(/\|/g, '\\|').replace(/`/g, "'")}\`${r.images ? ` (${r.images} image)` : ''} | ${r.lines} | ${r.tokens} → ${r.capped} | ${r.reads} fois | ${$(r.now)} | ${$(r.withCap)} |`));
  console.log(`\nLes ${m.top.length} plus grosses : ${$(m.topNow)} sans plafond, ${$(m.topCapped)} avec.`);
  console.log(`Toutes les sorties : ${$(m.allNow)} sans plafond, ${$(m.allCapped)} avec ; ${m.cutCount} auraient été coupées (${$(m.cutNow)} → ${$(m.cutCapped)}).`);
}
