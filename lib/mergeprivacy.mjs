// The same net as the push (lib/privacy.mjs), at merge time: sessions merge into main locally, sometimes alone at night,
// and Dev pushes main by hand, so a trace that enters main never meets the push button (Dev, 2026-11-02).
//
//   checkBranch({ root, base, branch, ctx })  → { ok, findings: [{ file, line, kind }] }
//
// One `git diff base...branch`, added lines only, each passed to privacy.scan. The value found is never returned (a
// finding names a file, a line and a kind: secret, home, phone, lan). An unreadable diff throws: the caller refuses.
// docs/decisions.md and docs/backlog.md are written live on main and cleaned at push time: excluded.
import { execFileSync } from 'node:child_process';
import * as privacy from './privacy.mjs';

export const EXCLUDED = new Set(['docs/decisions.md', 'docs/backlog.md']);

export const checkBranch = ({ root, base, branch, ctx = privacy.context() }) => {
  const diff = execFileSync('git', ['diff', '--no-color', '--no-renames', '--no-ext-diff', '-U0', `${base}...${branch}`],
    { cwd: root, timeout: 30000, maxBuffer: 256 * 1024 * 1024, stdio: ['ignore', 'pipe', 'pipe'] }).toString();
  const findings = []; const seen = new Set(); let file = null; let line = 0; let header = false;
  for (const l of diff.split('\n')) {
    if (l.startsWith('diff --git ')) { header = true; file = null; continue; }
    // an added line « ++ x » reads « +++ x »: the file name is only taken in the header, before the first hunk
    if (header && l.startsWith('+++ ')) { file = l === '+++ /dev/null' ? null : l.slice(6); continue; }
    if (l.startsWith('@@')) { header = false; const m = /\+(\d+)/.exec(l); line = m ? Number(m[1]) : 0; continue; }
    if (header || !l.startsWith('+')) continue;
    const at = line++;
    if (!file || EXCLUDED.has(file)) continue;
    for (const f of privacy.scan(l.slice(1), ctx)) {
      const key = `${file}:${at}:${f.kind}`; if (seen.has(key)) continue;
      seen.add(key); findings.push({ file, line: at, kind: f.kind });
    }
  }
  return { ok: findings.length === 0, findings };
};

// The refusal in one line, positions only (never the value)
export const reason = (findings, max = 6) => {
  const at = findings.slice(0, max).map((f) => `${f.file}:${f.line} (${f.kind})`);
  const more = findings.length > max ? ` +${findings.length - max}` : '';
  return `Vie privée : la branche ajoute ${at.join(', ')}${more}. Rien n'est fusionné : retire-les de la branche, ou relis et approuve si c'est un faux positif.`;
};
