// PIL (night of 3 November): a Bash command that rewrites a file by script — sed -i, perl -i, python or node writing a file,
// a heredoc or an echo/cat redirected into a file, tee. A file changes only through Edit or Write (lib/planner.mjs EDIT_RULE);
// the rule in lib/policy.mjs (patch .escadrille/pil-policy.patch) refuses it in one line with the path.
// scriptEditOf(command) → the path (or '?') when the command rewrites a file, else null. Writes to $TMPDIR, /tmp, /dev are free.
const FREE = /^(\/dev\/|\$TMPDIR|"\$TMPDIR|\$\{TMPDIR|\/tmp\/|\/private\/tmp\/|&\d)/;
const unq = (s) => String(s || '').replace(/^['"]|['"]$/g, '');
export const scriptEditOf = (command) => {
  const c = String(command || '');
  let m = /\bsed\s+(?:-[a-zA-Z]*\s+)*-i\S*(?:\s+''|\s+"")?\s+(?:-e\s+)?('[^']*'|"[^"]*"|\S+)\s+(\S+)/.exec(c); if (m) return unq(m[2]);
  m = /\bperl\s+-[a-zA-Z]*i\S*\s+(?:-[a-zA-Z]+\s+)*('[^']*'|"[^"]*"|\S+)\s+(\S+)/.exec(c); if (m) return unq(m[2]);
  if (/\b(writeFileSync|appendFileSync|writeFile)\s*\(/.test(c) && /\bnode\b/.test(c)) { m = /(?:writeFileSync|appendFileSync|writeFile)\s*\(\s*(['"`])([^'"`]+)\1/.exec(c); return m ? m[2] : '?'; }
  if (/\bpython3?\b/.test(c) && /(open\([^)]*,\s*['"][wa]|\.write_text\(|\.write\()/.test(c)) { m = /open\(\s*['"]([^'"]+)['"]\s*,\s*['"][wa]/.exec(c); return m ? m[1] : '?'; }
  for (const r of c.matchAll(/(?:^|[^0-9&>])>>?\s*('[^']*'|"[^"]*"|[^\s;&|)]+)/g)) { const p = unq(r[1]); if (!FREE.test(p) && !FREE.test(r[1])) return p; }
  m = /\btee\s+(?:-a\s+)?('[^']*'|"[^"]*"|[^\s;&|]+)/.exec(c); if (m && !FREE.test(unq(m[1]))) return unq(m[1]);
  return null;
};
export const scriptEditLine = (p) => `Un fichier ne se modifie qu'avec Edit ou Write : script refusé sur ${p}`;
