#!/usr/bin/env node
// Haiku's look at a capture, on the real Claude Code (docs/frugal.md, « Le pré-tri des captures par Haiku »): a blank
// PNG must come back `vide`. Less than a cent, from a terminal (claude needs the network). Writes
// .escadrille/frugal-live.json.
//   node scripts/frugal-live.mjs
// The essays of a capped Bash command (four on 2026-11-02, all refused) are in docs/frugal.md: Bash is left whole.
import { mkdtempSync, writeFileSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { deflateSync } from 'node:zlib';
import { triageImage } from '../lib/frugal.mjs';
import { projectRel } from '../lib/names.mjs';

const dir = mkdtempSync(join(tmpdir(), 'frugal-live-'));
const out = {};

// A white 400×300 PNG
const crc = (b) => { let c, t = []; for (let n = 0; n < 256; n++) { c = n; for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1; t[n] = c >>> 0; } c = 0xffffffff; for (const x of b) c = t[(c ^ x) & 0xff] ^ (c >>> 8); return (c ^ 0xffffffff) >>> 0; };
const chunk = (type, data) => { const len = Buffer.alloc(4); len.writeUInt32BE(data.length); const td = Buffer.concat([Buffer.from(type), data]); const c = Buffer.alloc(4); c.writeUInt32BE(crc(td)); return Buffer.concat([len, td, c]); };
const w = 400, h = 300; const ihdr = Buffer.alloc(13); ihdr.writeUInt32BE(w, 0); ihdr.writeUInt32BE(h, 4); ihdr[8] = 8; ihdr[9] = 2;
const raw = Buffer.alloc((w * 3 + 1) * h, 255); for (let y = 0; y < h; y++) raw[y * (w * 3 + 1)] = 0;
const png = join(dir, 'blank.png'); mkdirSync(dir, { recursive: true });
writeFileSync(png, Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), chunk('IHDR', ihdr), chunk('IDAT', deflateSync(raw)), chunk('IEND', Buffer.alloc(0))]));
out.triage = triageImage(png);

mkdirSync(projectRel(), { recursive: true });
writeFileSync(projectRel('frugal-live.json'), JSON.stringify(out, null, 1));
console.log(`Haiku sur une capture blanche : ${out.triage.line || 'pas de réponse'} → ${out.triage.verdict === 'vide' ? 'juste' : 'à revoir'}`);
console.log(`Détail : ${projectRel('frugal-live.json')}`);
