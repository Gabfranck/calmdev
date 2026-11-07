// What a capped output would have been: the head and tail of a long output with one line on where the rest is, a
// big JSON as its shape. scripts/frugal-outputs.mjs prices the outputs of real transcripts with it. The hook does
// not cap commands: Claude Code refused every rewrite of a Bash command (docs/frugal.md, « La réécriture de Bash,
// écartée »).
export const CAP_DEFAULTS = { lines: 200, bytes: 16384, jsonBytes: 8192 };

const kb = (b) => Math.max(1, Math.round(b / 1024)) + ' Ko';
const clip = (s, n) => (Buffer.byteLength(s) <= n ? s : Buffer.from(s).subarray(0, n).toString('utf8').replace(/�+$/, '') + '…');

// The shape of a JSON value, three levels deep: keys with their type, arrays with their length.
export const shapeOf = (v, depth = 0) => {
  if (Array.isArray(v)) return v.length ? `[${v.length} × ${shapeOf(v[0], depth + 1)}]` : '[]';
  if (v && typeof v === 'object') {
    const keys = Object.keys(v);
    if (depth >= 3) return `{${keys.length} clés}`;
    const shown = keys.slice(0, 12).map((k) => `${k}: ${shapeOf(v[k], depth + 1)}`);
    return `{ ${shown.join(', ')}${keys.length > 12 ? `, … ${keys.length - 12} de plus` : ''} }`;
  }
  return v === null ? 'null' : typeof v;
};

// What the session reads of an output. → { cut, text }: cut is false when the output is left whole.
export const capText = (out, { lines = CAP_DEFAULTS.lines, bytes = CAP_DEFAULTS.bytes, jsonBytes = CAP_DEFAULTS.jsonBytes } = {}, file = '<fichier>') => {
  const size = Buffer.byteLength(out);
  const t = out.trim();
  if (size > jsonBytes && /^[[{]/.test(t)) {
    let j; try { j = JSON.parse(t); } catch { j = undefined; }
    if (j !== undefined) {
      const head = Array.isArray(j) ? '.[0]' : '.' + (Object.keys(j)[0] || '');
      return { cut: true, text: `[calmdev] JSON de ${kb(size)} non lu, sa forme : ${clip(shapeOf(j), 1500)}\n[calmdev] Filtre-le avant de le lire : jq '${head}' ${file}, ou node -e "const j=JSON.parse(require('fs').readFileSync('${file}','utf8'));console.log(JSON.stringify(j${Array.isArray(j) ? '[0]' : ''}).slice(0,2000))" ; en entier : relance la commande avec « # entier » à la fin.\n` };
    }
  }
  const all = out.split('\n'); if (all[all.length - 1] === '') all.pop();
  if (all.length <= lines && size <= bytes) return { cut: false, text: out };
  const half = Math.max(1, Math.floor(lines / 2));
  const head = clip(all.slice(0, half).join('\n'), Math.floor(bytes / 2));
  const tail = all.length > half ? clip(all.slice(Math.max(half, all.length - half)).join('\n'), Math.floor(bytes / 2)) : '';
  const shown = Math.min(all.length, half * 2);
  const line = `[calmdev] ${all.length - shown > 0 ? `${all.length - shown} lignes coupées sur ${all.length}` : `sortie coupée à ${kb(bytes)}`} (${kb(size)}). La suite : Grep ou Read avec offset et limit dans ${file} ; en entier : relance avec « # entier » à la fin.`;
  return { cut: true, text: `${head}\n${line}\n${tail}${tail ? '\n' : ''}` };
};
