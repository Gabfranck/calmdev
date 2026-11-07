// Phase 13 PIL, the checks of a stop (docs/pilot.md, « Les vérifications reviennent aux sessions »). The pilot used
// to run scripts/ux-contract.mjs and scripts/click-robot.mjs by hand for a screen session and paste their output: four
// round trips for session X on 2026-11-02. The project declares its checks in its `environment` setting:
//   "checks": [{ "paths": ["public/"], "command": ["node", "scripts/ux-contract.mjs", "{base}", "{project}"], "timeoutMs": 600000 }]
// The server runs them outside the sandbox at every turn end of a session whose branch touches one of the paths, against
// the server the session started ({base}: its dev server), and hands the output back to the session like CAPTURE:.
// Pure here; the run itself is lib/devenv.mjs runCommand, the argv is the developer's, never a text of the session.
export const MAX_CHECKS = 6;
export const DEFAULT_TIMEOUT_MS = 600000;
const VARS = ['base', 'project', 'worktree', 'branch'];

export const validateChecks = (list) => {
  if (list === undefined || list === null) return { checks: [], errors: [] };
  if (!Array.isArray(list)) return { checks: [], errors: ['checks : une liste'] };
  const checks = []; const errors = [];
  list.slice(0, MAX_CHECKS).forEach((c, i) => {
    if (!c || typeof c !== 'object') { errors.push(`checks[${i}] : un objet`); return; }
    const paths = (Array.isArray(c.paths) ? c.paths : [c.paths]).map((p) => String(p || '').trim()).filter(Boolean);
    const command = Array.isArray(c.command) ? c.command.map(String) : null;
    if (!paths.length) errors.push(`checks[${i}] : paths manquant`);
    if (!command || !command.length) errors.push(`checks[${i}] : command est un argv (une liste de mots)`);
    if (paths.length && command?.length) checks.push({ name: String(c.name || command.slice(0, 2).join(' ')).slice(0, 80), paths, command, cwd: c.cwd ? String(c.cwd) : null, timeoutMs: Number.isFinite(Number(c.timeoutMs)) && Number(c.timeoutMs) > 0 ? Math.min(Number(c.timeoutMs), 1800000) : DEFAULT_TIMEOUT_MS });
  });
  return { checks, errors };
};

const touches = (files, prefix) => files.some((f) => { const p = String(f).replace(/^\.\//, ''); return p === prefix || p.startsWith(prefix.endsWith('/') ? prefix : prefix + '/') || (prefix.includes('*') && new RegExp('^' + prefix.replace(/[.+?^${}()|[\]\\]/g, '\\$&').replace(/\*\*/g, '.*').replace(/\*/g, '[^/]*') + '$').test(p)); });
// The checks whose paths the changed files touch
export const checksFor = (environment, files = []) => validateChecks(environment?.checks).checks.filter((c) => c.paths.some((p) => touches(files, p)));

// {base}, {project}, {worktree}, {branch} in an argv; a missing variable leaves the check unrun
export const resolveArgv = (argv, vars = {}) => {
  const missing = new Set();
  const out = argv.map((w) => String(w).replace(/\{(base|project|worktree|branch)\}/g, (_, k) => { if (vars[k] === undefined || vars[k] === null || vars[k] === '') { missing.add(k); return ''; } return String(vars[k]); }));
  return { argv: out, missing: [...missing].filter((k) => VARS.includes(k)) };
};

// One result → its lines for the session; the first is the verdict, the pilot sees only this one
export const checkNote = (check, r) => {
  const head = r.skipped ? `VÉRIFICATION ${check.name} : non lancée (${r.skipped})` : r.code === 0 ? `VÉRIFICATION ${check.name} : vert` : `VÉRIFICATION ${check.name} : ${r.killed ? 'délai dépassé' : `code ${r.code ?? '?'}`}${r.gaps != null ? `, ${r.gaps} écart${r.gaps > 1 ? 's' : ''}` : ''}`;
  const body = (r.lines || []).slice(-40).map((l) => '  │ ' + l);
  return [head, ...body].join('\n');
};
// The number of gaps a script printed, when it says so (« 3 écarts », « 2 defects », « 1 défaut »)
export const gapsOf = (lines = []) => { for (const l of [...lines].reverse()) { const m = /(\d+)\s+(écarts?|defects?|défauts?|gaps?)\b/i.exec(l); if (m) return Number(m[1]); } return null; };
// The final line for the pilot's journal: green, or n gaps
export const summaryLine = (results = []) => { const red = results.filter((r) => !r.skipped && r.code !== 0); if (!results.length) return null; if (!red.length) return `Vérifications : vert (${results.length})`; const n = red.reduce((a, r) => a + (r.gaps ?? 1), 0); return `Vérifications : ${n} écart${n > 1 ? 's' : ''} (${red.map((r) => r.name).join(', ')})`; };
// A run is repeated only when the branch moved: the signature of a run
export const runKey = (head, files = []) => `${head}:${[...files].sort().join(',')}`;
