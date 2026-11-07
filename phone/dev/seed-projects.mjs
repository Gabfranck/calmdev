// Test data for the phone's « Projet » setting: the phase 5 seed (project Escadrille, with its states) plus
// two more plans in other projects, so the app has three to group.
//   node phone/dev/seed-projects.mjs <dir>
import { execFileSync } from 'node:child_process';
import { readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';

const dir = process.argv[2];
if (!dir) { console.error('usage: node phone/dev/seed-projects.mjs <dir>'); process.exit(1); }
execFileSync(process.execPath, [path.join(import.meta.dirname, 'seed.mjs'), dir], { stdio: 'inherit' });

const plans = path.join(dir, 'plans');
const put = (file, patch) => {
  const p = { ...JSON.parse(readFileSync(path.join(plans, file), 'utf8')), ...patch };
  writeFileSync(path.join(plans, (patch.id || p.id) + '.json'), JSON.stringify(p, null, 1));
};
put('2026-11-01-phase-5-le-telephone-en-trois.json', { project: '/srv/projets/escadrille' });
put('exemple.json', { id: 'orchard-quick-wins', title: 'Quick wins de Linear', created: '2026-11-01T03:00:00.000Z', project: '/srv/projets/Orchard' });
put('exemple.json', { id: 'acme-import', title: 'L’import CSV', created: '2026-11-01T02:00:00.000Z', project: '/srv/projets/Acme' });
