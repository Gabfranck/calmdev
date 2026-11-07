// Seeds a running test server with a plan written while Fable is in reserve (session FAB; not a test):
//   PORT=3191 ESCADRILLE_DB=.escadrille/seed/fres.sqlite ESCADRILLE_PLANS=.escadrille/seed/plans node --no-warnings server.mjs &
//   ESCADRILLE_DB=.escadrille/seed/fres.sqlite node --no-warnings test/seed-fablereserve.mjs
// The plan « Carnet : l'export partagé » has three formulas; sans limite is chosen and the reserve keeps Fable on one
// session (with its reason), the others are moved to Opus by lib/blocks.mjs. Prints the URL.
import { mkdirSync } from 'node:fs';
import { DatabaseSync } from 'node:sqlite';
import path from 'node:path';
import { validatePlan } from '../lib/blocks.mjs';

const DB = process.env.ESCADRILLE_DB; if (!DB) { console.log('seed-fablereserve: set ESCADRILLE_DB to the running server database'); process.exit(0); }
const carnet = path.resolve(path.dirname(new URL(import.meta.url).pathname), '..', '.escadrille', 'seed', 'Carnet'); mkdirSync(carnet, { recursive: true });
const FABLE = 'claude-fable-5-1', OPUS = 'claude-opus-5-5', SONNET = 'claude-sonnet-5-5';
const S = (id, name, model, budget, extra = {}) => ({ id, name, model, budget, path: carnet, stops: ['Le premier écran', 'Captures 1440 et 390'], prompt: `Session ${id} : ${name}.`, ...extra });
const raw = {
  id: '2026-11-02-export-partage', title: "Carnet : l'export partagé", goal: 'Partager un carnet en lien public, sans compte.', formula: 'unlimited', fableReserve: true,
  formulas: [
    { tier: 'frugal', gain: 'Moitié prix, pas de vérificateur : les régressions se voient à la QA.', sessions: [S('A', 'Le lien public et ses droits', OPUS, 6), S('B', "L'écran de partage", OPUS, 5), S('V', 'Les tests du lien', SONNET, 2, { wave: 2, after: ['A', 'B'] })] },
    { tier: 'recommended', gain: 'Une tête Fable sur la sécurité du lien, des mains Opus, un vérificateur neuf.', sessions: [S('A', 'Le lien public et ses droits', FABLE, 8, { fableWhy: 'Un lien public sans compte ouvre les carnets à tout le monde : un défaut de droits est une fuite.' }), S('B', "L'écran de partage", OPUS, 6), S('V', 'Les tests du lien', SONNET, 2, { wave: 2, after: ['A', 'B'] })] },
    { tier: 'unlimited', gain: 'Une vérification par étape et une passe finale.', sessions: [S('A', 'Le lien public et ses droits', FABLE, 10, { fableWhy: 'Un lien public sans compte ouvre les carnets à tout le monde : un défaut de droits est une fuite.' }), S('B', "L'écran de partage", FABLE, 8), S('C', 'La révocation et l’expiration', FABLE, 6), S('V', 'La vérification du lien', FABLE, 4, { wave: 2, after: ['A', 'B', 'C'] }), S('F', 'La passe finale', FABLE, 4, { wave: 3, after: ['V'] })] },
  ],
};
const { plan, errors } = validatePlan(raw, { project: carnet }); if (errors) { console.error(errors); process.exit(1); }
const db = new DatabaseSync(DB);
db.prepare('insert or replace into plans (id, title, created, json, project) values (?, ?, ?, ?, ?)').run(plan.id, plan.title, plan.created, JSON.stringify(plan), carnet);
db.prepare('delete from sessions where plan = ?').run(plan.id);
const enc = encodeURIComponent; console.log(`/plan/${plan.id}?project=${enc(carnet)}`);
