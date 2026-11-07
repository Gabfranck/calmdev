#!/usr/bin/env node
// Plays a journeys file on this Mac, outside any sandbox, exactly as the server does for a QA: line (lib/qarun.mjs,
// docs/qarun.md). For the developer and the pilot; a session never runs it (no browser in its sandbox).
//
//   node scripts/qarun.mjs <parcours.json> [--environment <env.json>] [--out <dossier>] [--check]
//   node scripts/qarun.mjs --capture <url> --compte <nom> --environment <env.json> [--out <dossier>]
//
// env.json: { "lanHosts": ["192.168.1.x"], "accounts": { "<nom>": { "identifiant": "…", "motDePasse": "…" } },
//            "logins": { "http://192.168.1.x:8081": { "aller": "…/auth", "identifiant": "<sélecteur>", "motDePasse": "<sélecteur>", "valider": "Se connecter", "attendre_texte": "…" } },
//            "env": { "DASHBOARD_TOKEN": "…" } }
// It is the shape of the project's `environment` setting; keep that file outside every repository.
// --check validates and prepares the file without a browser and prints what would not be played.
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { runQa, captureConnected, prepareFile, readEnvironment, qaNote, connectedCaptureNote } from '../lib/qarun.mjs';

const args = process.argv.slice(2);
const opt = (name) => { const i = args.indexOf(name); return i >= 0 ? args[i + 1] : undefined; };
const file = args.find((a, i) => !a.startsWith('--') && (i === 0 || !args[i - 1].startsWith('--')));
const environment = opt('--environment') ? JSON.parse(readFileSync(opt('--environment'), 'utf8')) : {};
const out = opt('--out');

if (opt('--capture')) {
  const r = await captureConnected({ target: opt('--capture'), account: opt('--compte'), worktree: out ? path.dirname(out) : process.cwd(), name: out ? path.basename(out) : undefined, environment });
  console.log(connectedCaptureNote(r, opt('--capture'), opt('--compte')));
  process.exit(r.ok ? 0 : 1);
}
if (!file) { console.error('usage : node scripts/qarun.mjs <parcours.json> [--environment env.json] [--out dossier] [--check]'); process.exit(2); }
const abs = path.resolve(file);
if (args.includes('--check')) {
  const E = readEnvironment(environment);
  if (E.errors.length) { console.error(E.errors.join('\n')); process.exit(1); }
  const { prepared, error } = prepareFile(abs, E);
  if (error) { console.error(error); process.exit(1); }
  for (const p of prepared) console.log(`${p.error ? '✗' : '✓'} ${p.id ?? '?'}${p.error ? ' : ' + p.error : ` : ${p.steps.length} étapes${p.account ? `, compte ${p.account}` : ''}`}`);
  process.exit(prepared.some((p) => p.error) ? 1 : 0);
}
const r = await runQa({ file: abs, project: path.dirname(abs), environment, outDir: out });
console.log(qaNote(r, file));
if (r.ok) for (const x of r.results) console.log(`${x.ok ? '✓' : '✗'} ${x.id}${x.echec ? ' : ' + x.echec : ''}${x.bloquees ? ` (${x.bloquees} bloquée(s))` : ''}`);
process.exit(r.ok ? 0 : 1);
