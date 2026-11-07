// Renders the app icons of desktop/src-tauri/icons from the calmdev brand (docs/design-system/calmdev/brand/icon-1024.svg):
// the PNGs Tauri asks for and icon.icns, written here in Node (iconutil and sips need a temp folder a sandbox may refuse).
//   node desktop/scripts/icons.mjs        (needs rsvg-convert, as docs/design-system/calmdev/make.mjs)
import { execFileSync } from 'node:child_process';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const desktop = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const source = path.join(desktop, '..', 'docs', 'design-system', 'calmdev', 'brand', 'icon-1024.svg');
const out = path.join(desktop, 'src-tauri', 'icons');
mkdirSync(out, { recursive: true });

// RSVG_CONVERT gives its full path when the PATH lookup is refused (a sandbox)
const render = (size) => execFileSync(process.env.RSVG_CONVERT || 'rsvg-convert', ['-w', String(size), '-h', String(size), source]);
const pngs = { '32x32.png': 32, '128x128.png': 128, '128x128@2x.png': 256, 'icon.png': 512 };
for (const [name, size] of Object.entries(pngs)) writeFileSync(path.join(out, name), render(size));

// ICNS: 'icns' + total length, then one block per size (type, length of the block, PNG data)
const types = [['icp4', 16], ['icp5', 32], ['ic11', 32], ['ic12', 64], ['ic07', 128], ['ic13', 256], ['ic08', 256], ['ic14', 512], ['ic09', 512], ['ic10', 1024]];
const blocks = types.map(([type, size]) => {
  const data = render(size);
  const head = Buffer.alloc(8);
  head.write(type, 0, 'ascii');
  head.writeUInt32BE(data.length + 8, 4);
  return Buffer.concat([head, data]);
});
const body = Buffer.concat(blocks);
const head = Buffer.alloc(8);
head.write('icns', 0, 'ascii');
head.writeUInt32BE(body.length + 8, 4);
writeFileSync(path.join(out, 'icon.icns'), Buffer.concat([head, body]));
console.log(`icons written in ${path.relative(process.cwd(), out)} from ${path.basename(source)} (${readFileSync(source).length} bytes)`);
