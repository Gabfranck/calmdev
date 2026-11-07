// lib/qarun.mjs (docs/qarun.md): the QA: and « CAPTURE: … compte= » lines, the closed step format, the file inside the
// worktree or the project, the LAN hosts, the login from the environment, the results and the board with a fake
// driver over the fixture site (test/fixtures/qarun), the queue; the real browser only when chrome-headless-shell is
// there and starts (never in a session's sandbox).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { mkdtempSync, mkdirSync, writeFileSync, symlinkSync, existsSync, readFileSync, rmSync, realpathSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { freePort } from './free-port.mjs';
import { findHeadlessShell } from '../lib/capture.mjs';
import {
  parseQaLines, parseConnectedCaptures, checkQaFile, checkHosts, allowedHost, resolverRules, validateStep, parseTarget, resolveValue,
  prepareParcours, prepareFile, readEnvironment, qaFolderName, qaNote, connectedCaptureNote, renderBoard, runQa, captureConnected, createQaQueue,
  STEPS, KEYS, MAX_PER_TURN, WIDTHS,
} from '../lib/qarun.mjs';
// A LAN address is assembled at run time: scripts/trace-scan.mjs would take a written one for a real one.
const ip = (net, host) => `${net}.${host}`;

const here = path.dirname(fileURLToPath(import.meta.url));
const fixtures = path.join(here, 'fixtures', 'qarun');
const tmp = (p) => realpathSync(mkdtempSync(path.join(tmpdir(), p)));
const wt = tmp('qarun-wt-'); const project = tmp('qarun-proj-'); const outside = tmp('qarun-out-');
writeFileSync(path.join(outside, 'secret.json'), '[]');
symlinkSync(path.join(outside, 'secret.json'), path.join(wt, 'lien.json'));
mkdirSync(path.join(project, 'qa')); writeFileSync(path.join(project, 'qa', 'p.json'), '[]');

// The fixture site on a free port: static files only
const port = freePort();
const site = createServer((req, res) => {
  const f = path.join(fixtures, path.basename(new URL(req.url, 'http://x').pathname) || 'index.html');
  if (!existsSync(f)) { res.writeHead(404); return res.end('absent'); }
  res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' }); res.end(readFileSync(f));
});
await new Promise((r) => site.listen(port, '127.0.0.1', r));
site.unref(); // the file's event loop may end with the server still up
const base = `http://localhost:${port}`;
process.on('exit', () => { site.close(); for (const d of [wt, project, outside]) rmSync(d, { recursive: true, force: true }); });

const environment = { lanHosts: [`${ip('192.168.1', 2)}`], accounts: { 'eleve.test': { identifiant: 'eleve.test', motDePasse: 'sesame' } }, logins: { [base]: { aller: `${base}/auth.html`, identifiant: 'input[placeholder="Identifiant"]', motDePasse: 'input[placeholder="Mot de passe"]', valider: 'Se connecter', attendre_texte: 'Choisis ton mode de jeu' } }, env: { JETON: 'abc123' } };

const journeys = [
  { id: 'passe', titre: 'Le bouton visible, un champ, un select, une touche', attendu: 'Rien de caché n’est cliqué.', etapes: [
    { aller: `${base}/index.html` }, { cliquer: 'Proposer une question' }, { attendre_texte: 'Question proposée' },
    { remplir: '#recherche', valeur: 'abc' }, { attendre_texte: 'Recherche : abc' }, { choisir: '#niveau', valeur: 'Seconde' }, { attendre_texte: 'Niveau : Seconde' },
    { touche: 'Escape' }, { attendre_texte: 'Échap reçu' }, { attendre_url: 'index.html' }, { capture: 'accueil' }] },
  { id: 'echoue', titre: 'Un texte qui ne vient jamais', etapes: [{ aller: `${base}/index.html` }, { attendre_texte: 'Texte qui ne vient jamais' }, { capture: 'jamais' }] },
  { id: 'inconnue', titre: 'Une étape hors liste', etapes: [{ aller: `${base}/index.html` }, { executer: 'rm -rf /' }] },
  { id: 'externe', titre: 'Une page qui appelle dehors', etapes: [{ aller: `${base}/ext.html` }, { capture: 'dehors' }] },
  { id: 'base-login-eleve', app: 'eleve', compte: 'eleve.test', titre: 'Routine de connexion', etapes: [
    { aller: `${base}/auth.html` }, { remplir: 'input[placeholder="Identifiant"]', valeur: 'eleve.test' }, { remplir: 'input[placeholder="Mot de passe"]', valeur: '{compte.motDePasse}' }, { cliquer: 'Se connecter' }, { attendre_texte: 'Choisis ton mode de jeu' }, { capture: 'jouer' }] },
  { id: 'connecte', app: 'eleve', compte: 'eleve.test', titre: 'Derrière la connexion', etapes: [{ aller: `${base}/app.html` }, { attendre_texte: 'Bienvenue eleve.test' }, { capture: 'app' }] },
  { id: 'compte-inconnu', app: 'eleve', compte: 'prof.inconnu', titre: 'Un compte absent du réglage', etapes: [{ aller: `${base}/app.html` }] },
  { id: 'mdp-clair', compte: 'aucun', titre: 'Un mot de passe écrit dans le fichier', etapes: [{ aller: `${base}/auth.html` }, { remplir: 'input[placeholder="Mot de passe"]', valeur: 'sesame' }, { cliquer: 'Se connecter' }] },
];
const file = path.join(wt, 'parcours.json'); writeFileSync(file, JSON.stringify(journeys, null, 1));

test('QA: and « CAPTURE: … compte= » lines, alone on their line, unique, capped', () => {
  const text = 'Voilà.\nQA: qa/parcours.json\n- QA: autre.json\nIl faut écrire QA: x.json en début de ligne.\nQA: qa/parcours.json\nQA: p.json ; rm -rf /\n';
  assert.deepEqual(parseQaLines(text), ['qa/parcours.json', 'autre.json']);
  assert.deepEqual(parseQaLines('', { claude: 'QA: a.json', summary: 'QA: b.json' }), ['a.json', 'b.json']);
  assert.equal(parseQaLines(Array.from({ length: 9 }, (_, i) => `QA: p${i}.json`).join('\n')).length, MAX_PER_TURN);
  assert.deepEqual(parseConnectedCaptures(`CAPTURE: http://${ip('192.168.1', 2)}:8081/play compte=eleve.lemon-active.2.05\nCAPTURE: http://localhost:3050/\nCAPTURE: http://${ip('192.168.1', 2)}:8081/play compte=eleve.lemon-active.2.05`), [{ target: `http://${ip('192.168.1', 2)}:8081/play`, account: 'eleve.lemon-active.2.05' }]);
  assert.deepEqual(parseQaLines(null, null), []);
});

test('the journeys file is a .json inside the worktree or the project, links followed', () => {
  assert.equal(checkQaFile('parcours.json', { worktree: wt }).file, file);
  assert.equal(checkQaFile(path.join(project, 'qa', 'p.json'), { worktree: wt, project }).ok, true);
  assert.match(checkQaFile(path.join(project, 'qa', 'p.json'), { worktree: wt }).error, /sort du worktree/);
  assert.match(checkQaFile('lien.json', { worktree: wt }).error, /sort du worktree/);
  assert.match(checkQaFile(path.join(outside, 'secret.json'), { worktree: wt, project }).error, /sort du worktree/);
  assert.match(checkQaFile('absent.json', { worktree: wt }).error, /introuvable/);
  assert.match(checkQaFile('notes.md', { worktree: wt }).error, /\.json/);
  assert.match(checkQaFile('parcours.json', {}).error, /ni worktree ni projet/);
  assert.match(checkQaFile('', { worktree: wt }).error, /vide/);
  assert.equal(qaFolderName(2, '/x/qa/2026-11-02/parcours.json'), '2-parcours');
});

test('LAN hosts: private addresses and .local names only; the resolver rule names them', () => {
  const { hosts, errors } = checkHosts([`${ip('192.168.1', 2)}`, ` ${ip('10.0.0', 5)} `, 'imac.local', 'example.com', '8.8.8.8', `${ip('192.168.1', 2)}`]);
  assert.deepEqual(hosts, [`${ip('192.168.1', 2)}`, `${ip('10.0.0', 5)}`, 'imac.local']);
  assert.equal(errors.length, 2); assert.match(errors[0], /example\.com refusé/);
  assert.equal(resolverRules(hosts), `--host-resolver-rules=MAP * ~NOTFOUND, EXCLUDE localhost, EXCLUDE 127.0.0.1, EXCLUDE ${ip('192.168.1', 2)}, EXCLUDE ${ip('10.0.0', 5)}, EXCLUDE imac.local`);
  assert.ok(allowedHost('localhost', hosts) && allowedHost('127.0.0.1', hosts) && allowedHost(`${ip('192.168.1', 2)}`, hosts));
  assert.ok(!allowedHost('example.com', hosts) && !allowedHost(`${ip('192.168.1', 3)}`, hosts));
  assert.match(readEnvironment({ lanHosts: ['example.com'] }).errors[0], /refusé/);
});

test('steps: the closed list, one line per refusal', () => {
  assert.deepEqual(Object.keys(STEPS), ['aller', 'cliquer', 'remplir', 'choisir', 'touche', 'attendre_texte', 'attendre_url', 'attendre', 'capture']);
  assert.equal(validateStep({ aller: 'http://localhost:3050/auth' }, 1).url, 'http://localhost:3050/auth');
  assert.equal(validateStep({ aller: `http://${ip('192.168.1', 2)}:8081/play` }, 1, [`${ip('192.168.1', 2)}`]).kind, 'aller');
  for (const [s, why] of [
    [{ executer: 'rm -rf /' }, /étape 3 : étape inconnue « executer »/], [{}, /étape inconnue/], [{ cliquer: 'a', remplir: 'b', valeur: 'c' }, /une seule action/],
    [{ cliquer: 'Ok', force: true }, /clé inconnue « force »/], [{ aller: 'https://localhost:3050' }, /seul http/], [{ aller: 'http://example.com/' }, /hors du Mac/],
    [{ aller: `http://${ip('192.168.1', 2)}:8081/` }, /hors du Mac/], [{ touche: 'F12' }, /touche inconnue/], [{ attendre: 60000 }, /0 à 5000/], [{ attendre: '5' }, /0 à 5000/],
    [{ capture: 'a b' }, /lettres, chiffres/], [{ remplir: '#x' }, /valeur manquante/], [{ cliquer: '' }, /non vide/], [{ cliquer: 'x'.repeat(2001) }, /2000/], ['cliquer', /un objet/],
  ]) { const r = validateStep(s, 3); assert.ok(r.error, JSON.stringify(s)); assert.match(r.error, why); assert.ok(!r.error.includes('\n')); }
  assert.deepEqual(validateStep({ remplir: '#x', valeur: '' }, 1), { kind: 'remplir', target: '#x', value: '' });
  assert.deepEqual(validateStep({ touche: 'Enter' }, 1), { kind: 'touche', key: 'Enter' }); assert.ok(KEYS.Enter.text === '\r');
  assert.deepEqual(parseTarget('button[aria-haspopup="menu"] >> nth=1'), { spec: 'button[aria-haspopup="menu"]', nth: 1 });
  assert.deepEqual(parseTarget('Se connecter >> visible'), { spec: 'Se connecter', nth: 0 });
  assert.match(parseTarget('a >> has-text(x)').error, /seul >> nth=N/);
});

test('values: the holes of an account or the environment, nothing else; a hole left open is said', () => {
  const ctx = { account: { identifiant: 'eleve.test', motDePasse: 'sesame' }, env: { DASHBOARD_TOKEN: 't0k' } };
  assert.deepEqual(resolveValue('{compte.identifiant}', ctx), { value: 'eleve.test', secret: false });
  assert.deepEqual(resolveValue('{compte.motDePasse}', ctx), { value: 'sesame', secret: true });
  assert.deepEqual(resolveValue('Bearer {DASHBOARD_TOKEN}', ctx), { value: 'Bearer t0k', secret: true });
  assert.deepEqual(resolveValue('{env.DASHBOARD_TOKEN}', ctx), { value: 't0k', secret: true });
  assert.match(resolveValue('{AUTRE}', ctx).error, /valeur à résoudre \(\{AUTRE\}\)/);
  assert.match(resolveValue('{compte.motDePasse}', { account: null }).error, /valeur à résoudre/);
  assert.deepEqual(resolveValue('texte sans trou {pas un trou', ctx), { value: 'texte sans trou {pas un trou', secret: false });
});

test('a journey is prepared: its login routine first, the account resolved, the unknown refused in one line', () => {
  const E = readEnvironment(environment);
  const list = journeys;
  const connecte = prepareParcours(list.find((p) => p.id === 'connecte'), 5, list, E);
  assert.equal(connecte.error, undefined);
  assert.deepEqual(connecte.steps.filter((s) => s.routine).map((s) => s.kind), ['aller', 'remplir', 'remplir', 'cliquer', 'attendre_texte']); // the routine's capture dropped
  assert.equal(connecte.steps[1].value, 'eleve.test'); assert.equal(connecte.steps[2].value, 'sesame'); assert.equal(connecte.steps[2].secret, true);
  assert.deepEqual(connecte.steps.filter((s) => !s.routine).map((s) => s.kind), ['aller', 'attendre_texte', 'capture']);
  // the pilot's routines wrote « password » in clear: reused for an account, that field takes the account's password
  const pilotStyle = [{ id: 'base-login-prof', app: 'prof', compte: 'eleve.test', etapes: [{ aller: `${base}/auth.html` }, { remplir: '#login-username', valeur: 'eleve.test' }, { remplir: '#login-password', valeur: 'password' }, { cliquer: 'Se connecter' }] }];
  const reused = prepareParcours({ id: 'x', app: 'prof', compte: 'eleve.test', etapes: [{ aller: `${base}/app.html` }] }, 0, pilotStyle, E);
  assert.equal(reused.steps[1].value, 'eleve.test'); assert.equal(reused.steps[2].value, 'sesame'); assert.equal(reused.steps[2].secret, true);
  // from the environment's logins when the file has no routine for the app
  const fromEnv = prepareParcours({ id: 'x', app: 'autre', compte: 'eleve.test', etapes: [{ aller: `${base}/app.html` }] }, 0, [], E);
  assert.deepEqual(fromEnv.steps.map((s) => s.kind), ['aller', 'remplir', 'remplir', 'cliquer', 'attendre_texte', 'aller']);
  assert.equal(fromEnv.steps[0].url, `${base}/auth.html`); assert.equal(fromEnv.steps[2].value, 'sesame');
  assert.match(prepareParcours({ id: 'x', compte: 'eleve.test', etapes: [{ aller: 'http://localhost:1/' }] }, 0, [], E).error, /aucune routine de connexion pour http:\/\/localhost:1/);
  assert.match(prepareParcours(list.find((p) => p.id === 'compte-inconnu'), 6, list, E).error, /compte « prof.inconnu » inconnu/);
  assert.match(prepareParcours(list.find((p) => p.id === 'inconnue'), 2, list, E).error, /^étape 2 : étape inconnue « executer »/);
  assert.match(prepareParcours({ id: 'x', etapes: [{ aller: `${base}/` }], script: 'x' }, 0, [], E).error, /clé inconnue « script »/);
  assert.match(prepareParcours({ id: 'x', etapes: [] }, 0, [], E).error, /liste non vide/);
  assert.match(prepareParcours({ etapes: [{ aller: `${base}/` }] }, 0, [], E).error, /id manquant/);
  assert.match(prepareParcours({ id: 'x', largeur: 100, etapes: [{ aller: `${base}/` }] }, 0, [], E).error, /largeur/);
  assert.equal(prepareParcours({ id: 'x', largeur: 390, etapes: [{ aller: `${base}/` }] }, 0, [], E).width, 390);
  assert.match(prepareParcours({ id: 'x', etapes: [{ aller: `${base}/` }, { remplir: '#t', valeur: '{DASHBOARD_TOKEN}' }] }, 0, [], E).error, /étape 2 : non joué : valeur à résoudre \(\{DASHBOARD_TOKEN\}\)/);
  // « aucun » and « jeton » accounts, and connexion: incluse, get no routine
  assert.equal(prepareParcours({ id: 'x', compte: 'aucun (écran de connexion)', etapes: [{ aller: `${base}/` }] }, 0, [], E).steps.length, 1);
  assert.equal(prepareParcours({ id: 'x', compte: 'eleve.test', connexion: 'incluse', etapes: [{ aller: `${base}/` }] }, 0, [], E).steps.length, 1);
  assert.match(prepareFile(path.join(project, 'qa', 'p.json'), E).error, /aucun parcours/);
  writeFileSync(path.join(wt, 'double.json'), JSON.stringify([{ id: 'a', etapes: [{ aller: `${base}/` }] }, { id: 'a', etapes: [{ aller: `${base}/` }] }]));
  assert.match(prepareFile(path.join(wt, 'double.json'), E).error, /id en double/);
  writeFileSync(path.join(wt, 'cassé.json'), '{');
  assert.match(prepareFile(path.join(wt, 'cassé.json'), E).error, /illisible/);
});

// A fake driver: plays the prepared journeys over the fixture site with fetch and text matching, no browser. Each
// `aller` fetches the page and scans its src= for hosts outside the Mac; a text step looks into the page's text.
const PNG = Buffer.from('89504e470d0a1a0a', 'hex');
const fakeDriver = async ({ prepared, hosts, captures, secrets }) => {
  const results = []; let blocked = 0; const blockedHosts = new Set();
  for (const p of prepared) {
    const r = { id: p.id, sprint: p.sprint, ticket: p.ticket, app: p.app, compte: p.compte, titre: p.titre, attendu: p.attendu, incertain: p.incertain, ok: false, echec: null, console: [], http: [], cles: [], captures: [], bloquees: 0, hotesBloques: [], ms: 1 };
    if (p.error) { results.push({ ...r, echec: p.error }); continue; }
    let text = ''; let logged = false;
    try {
      for (const s of p.steps) {
        if (s.kind === 'aller') {
          const html = await (await fetch(s.url)).text();
          for (const [, src] of html.matchAll(/src="(http[^"]+)"/g)) { const h = new URL(src).hostname; if (!allowedHost(h, hosts)) { blocked++; r.bloquees++; blockedHosts.add(new URL(src).host); if (!r.hotesBloques.includes(h)) r.hotesBloques.push(h); } }
          for (const [, m] of html.matchAll(/console\.error\('([^']*)'\)/g)) r.console.push(m);
          text = html.replace(/<script[\s\S]*?<\/script>/g, '').replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ');
          if (/app\.html/.test(s.url) && logged) text += ' Bienvenue eleve.test Choisis ton mode de jeu pages.play.title';
        } else if (s.kind === 'attendre_texte') { if (!text.includes(s.text)) throw new Error(`étape ${s.n} : attendre_texte « ${s.text} » : absent`); }
        else if (s.kind === 'remplir') { if (/Mot de passe/.test(s.spec) && !s.secret) throw new Error(`étape ${s.n} : mot de passe en clair dans le parcours`); if (s.secret && s.value === 'sesame') logged = true; text += ' Recherche : ' + s.value; }
        else if (s.kind === 'choisir') text += ' Niveau : ' + s.value;
        else if (s.kind === 'touche') text += ' Échap reçu';
        else if (s.kind === 'cliquer') { if (!text.includes(s.spec)) throw new Error(`étape ${s.n} : cliquer « ${s.spec} » introuvable ou caché`); if (s.spec === 'Proposer une question') text += ' Question proposée'; if (s.spec === 'Se connecter' && logged) text += ' Choisis ton mode de jeu'; }
        else if (s.kind === 'capture') { const f = `${p.id}-${s.name}.png`; writeFileSync(path.join(captures, f), PNG); r.captures.push(f); for (const k of text.match(/\b[a-z]+(\.[a-zA-Z]+){2,}\b/g) || []) if (!/\.html$/.test(k) && !r.cles.includes(k)) r.cles.push(k); }
      }
      r.ok = true;
    } catch (e) { r.echec = e.message + (secrets.some((x) => e.message.includes(x)) ? '' : ''); }
    results.push(r);
  }
  return { results, blocked, blockedHosts: [...blockedHosts] };
};

test('runQa with the fake driver: results and board written, failures first, the note in one line', async () => {
  const r = await runQa({ file: 'parcours.json', worktree: wt, environment, name: '0-parcours', chromePath: '/fake/shell', driver: fakeDriver });
  assert.equal(r.ok, true, r.error);
  assert.equal(r.dir, path.join(wt, '.calmdev', 'qa', '0-parcours'));
  assert.deepEqual([r.total, r.passed, r.failed], [8, 4, 4]);
  const by = Object.fromEntries(r.results.map((x) => [x.id, x]));
  assert.equal(by.passe.ok, true); assert.deepEqual(by.passe.captures, ['passe-accueil.png']);
  assert.match(by.echoue.echec, /^étape 2 : attendre_texte « Texte qui ne vient jamais »/);
  assert.match(by.inconnue.echec, /^étape 2 : étape inconnue « executer »/);
  assert.equal(by.externe.ok, true); assert.equal(by.externe.bloquees, 2); assert.deepEqual(by.externe.hotesBloques, ['example.com', '203.0.113.9']); assert.deepEqual(by.externe.console, ['erreur de test']);
  assert.equal(by.connecte.ok, true); assert.deepEqual(by.connecte.cles, ['pages.play.title']);
  assert.match(by['compte-inconnu'].echec, /compte « prof.inconnu » inconnu/);
  assert.match(by['mdp-clair'].echec, /mot de passe en clair/);
  assert.equal(r.blocked, 2); assert.deepEqual(r.blockedHosts, ['example.com', '203.0.113.9']);
  const saved = JSON.parse(readFileSync(r.files.results, 'utf8'));
  assert.equal(saved.length, 8); assert.ok(!JSON.stringify(saved).includes('sesame'), 'no password in the results');
  const board = readFileSync(r.files.board, 'utf8');
  assert.ok(!board.includes('sesame'));
  const order = [...board.matchAll(/<article class="(ok|ko)"><h2>([a-z-]+)/g)].map((m) => [m[1], m[2]]);
  assert.deepEqual(order.slice(0, 4).map((o) => o[0]), ['ko', 'ko', 'ko', 'ko']); assert.deepEqual(order.slice(4).map((o) => o[0]), ['ok', 'ok', 'ok', 'ok']);
  assert.ok(board.includes('8 parcours · 4 joués · 4 en échec')); assert.ok(board.includes('<summary>1 erreurs console</summary>')); assert.ok(board.includes('captures/passe-accueil.png'));
  assert.ok(board.includes('2 requête(s) hors Mac bloquée(s) : example.com, 203.0.113.9'));
  assert.ok(existsSync(path.join(r.dir, 'captures', 'passe-accueil.png')));
  assert.equal(qaNote(r, 'parcours.json'), `QA parcours.json : 4/8 ok, 4 échecs, 2 requêtes hors Mac bloquées : ${r.files.results} et ${r.files.board}`);
  assert.equal(qaNote({ ok: false, error: 'QA refusée : x' }, 'p.json'), 'QA p.json : QA refusée : x');
});

test('a refused file or environment never reaches the driver; a missing browser is one line', async () => {
  let called = false; const driver = () => { called = true; };
  assert.match((await runQa({ file: 'lien.json', worktree: wt, environment, chromePath: '/x', driver })).error, /sort du worktree/);
  assert.match((await runQa({ file: 'parcours.json', worktree: wt, environment: { lanHosts: ['example.com'] }, chromePath: '/x', driver })).error, /environment : hôte example\.com refusé/);
  assert.match((await runQa({ file: 'cassé.json', worktree: wt, environment, chromePath: '/x', driver })).error, /illisible/);
  assert.equal(called, false);
  const empty = tmp('qarun-pw-');
  const r = await runQa({ file: 'parcours.json', worktree: wt, environment, env: { PLAYWRIGHT_BROWSERS_PATH: empty } });
  assert.equal(r.missing, true); assert.match(r.error, /chrome-headless-shell introuvable/);
  rmSync(empty, { recursive: true });
});

test('a driver that throws: one line, the secret hidden, the profile removed', async () => {
  let profile;
  const r = await runQa({ file: 'parcours.json', worktree: wt, environment, name: 'x-fail', chromePath: '/fake/shell', driver: (o) => { profile = o.profile; throw new Error('mot de passe sesame refusé par le navigateur'); } });
  assert.equal(r.ok, false); assert.equal(r.error, 'QA impossible : mot de passe ••• refusé par le navigateur');
  assert.equal(existsSync(profile), false);
});

test('the board alone: failures first, details folded, raw keys listed', () => {
  const html = renderBoard({ title: 'QA t', results: [
    { id: 'a', titre: 'A', ok: true, echec: null, console: [], http: ['401 GET /auth/user-data'], cles: [], captures: ['a-1.png'], bloquees: 0, hotesBloques: [] },
    { id: 'b', titre: 'B <x>', sprint: 'R01', ticket: 'ORC-37', app: 'prof', compte: 'prof.lemon-active', incertain: true, ok: false, echec: 'étape 3 : cliquer « Ok » introuvable ou caché (8 s)', console: ['boom'], http: [], cles: ['home.tasks.title'], captures: ['b-echec.png'], bloquees: 1, hotesBloques: ['example.com'] },
  ] });
  assert.ok(html.indexOf('<h2>b ·') < html.indexOf('<h2>a ·'));
  assert.ok(html.includes('B &lt;x&gt;') && html.includes('R01 · ORC-37 · prof · prof.lemon-active · incertain'));
  assert.ok(html.includes('<summary>1 réponses ≥ 400</summary>') && html.includes('<summary>1 clés brutes</summary><pre>home.tasks.title</pre>'));
  assert.ok(html.includes('✗ étape 3 : cliquer « Ok » introuvable ou caché (8 s)') && html.includes('✓ joué'));
});

test('a connected capture with a fake driver: light and dark at two widths, the account only by name', async () => {
  let seen;
  const driver = async (o) => { seen = o; return { shots: [['1440.png', PNG], ['390.png', PNG], ['1440-sombre.png', Buffer.concat([PNG, Buffer.from('d')])], ['390-sombre.png', Buffer.concat([PNG, Buffer.from('d')])]], dark: true, errors: ['sesame visible'], warnings: [], http: ['401 GET /auth/user-data'], blocked: 1, blockedHosts: ['example.com'] }; };
  const r = await captureConnected({ target: `${base}/app.html`, account: 'eleve.test', worktree: wt, environment, name: '0-app', chromePath: '/fake/shell', driver });
  assert.equal(r.ok, true, r.error);
  assert.deepEqual(seen.steps.map((s) => s.kind), ['aller', 'remplir', 'remplir', 'cliquer', 'attendre_texte']);
  assert.equal(seen.steps[2].value, 'sesame'); assert.equal(seen.steps[2].secret, true); assert.equal(seen.url, `${base}/app.html`); assert.deepEqual(seen.hosts, [`${ip('192.168.1', 2)}`]);
  assert.equal(r.dir, path.join(wt, '.calmdev', 'captures', '0-app'));
  for (const f of ['1440.png', '390.png', '1440-sombre.png', '390-sombre.png', 'console.json']) assert.ok(existsSync(path.join(r.dir, f)), f);
  const report = JSON.parse(readFileSync(path.join(r.dir, 'console.json'), 'utf8'));
  assert.equal(report.account, 'eleve.test'); assert.equal(report.dark, true); assert.deepEqual(report.errors, ['••• visible']);
  assert.equal(connectedCaptureNote(r, `${base}/app.html`, 'eleve.test'), `CAPTURE ${base}/app.html (compte eleve.test) : ${r.dir} (1 erreur de console, sombre : oui, 1 requête hors Mac bloquée)`);
  assert.equal(existsSync(seen.profile), false);
  // refusals, in one line, before any browser
  let called = false; const no = () => { called = true; };
  assert.match((await captureConnected({ target: `${base}/app.html`, account: 'inconnu', worktree: wt, environment, chromePath: '/x', driver: no })).error, /compte « inconnu » inconnu/);
  assert.match((await captureConnected({ target: 'http://localhost:9/x', account: 'eleve.test', worktree: wt, environment, chromePath: '/x', driver: no })).error, /aucune routine de connexion pour http:\/\/localhost:9/);
  assert.match((await captureConnected({ target: 'http://example.com/', account: 'eleve.test', worktree: wt, environment, chromePath: '/x', driver: no })).error, /hôte example\.com hors du Mac/);
  assert.match((await captureConnected({ target: 'https://localhost:3050/', account: 'eleve.test', worktree: wt, environment, chromePath: '/x', driver: no })).error, /seul http/);
  assert.equal(called, false);
});

test('the queue: one run at a time per project, a line per job, one idle call with every line', async () => {
  let active = 0; let maxActive = 0;
  const run = async (job) => { active++; maxActive = Math.max(maxActive, active); await new Promise((r) => setTimeout(r, 10)); active--; return job.kind === 'capture' ? { ok: false, error: 'capture refusée : test' } : runQa({ ...job, chromePath: '/fake/shell', driver: fakeDriver }); };
  const notes = []; const idle = [];
  const q = createQaQueue({ run, onNote: (k, job, line) => notes.push([k, line]), onIdle: (k, lines) => idle.push([k, lines]) });
  q.enqueue('/proj', [{ kind: 'qa', file: 'parcours.json', target: 'parcours.json', worktree: wt, environment, name: 'q1' }, { kind: 'capture', target: 'http://localhost:1/', account: 'a' }, { kind: 'qa', file: 'parcours.json', target: 'parcours.json', worktree: wt, environment, name: 'q2' }]);
  assert.equal(q.busy('/proj'), true); assert.equal(q.pending('/proj'), 2);
  while (q.busy('/proj')) await new Promise((r) => setTimeout(r, 10));
  assert.equal(maxActive, 1); assert.equal(notes.length, 3);
  assert.match(notes[0][1], /^QA parcours\.json : 4\/8 ok/); assert.equal(notes[1][1], 'CAPTURE http://localhost:1/ (compte a) : capture refusée : test');
  assert.equal(idle.length, 1); assert.equal(idle[0][1].length, 3);
  assert.ok(existsSync(path.join(wt, '.calmdev', 'qa', 'q2', 'planche.html')));
});

test('the real browser over the fixture site: the visible button, the login, the refusal of a clear password, the blocked hosts', async (t) => {
  if (!findHeadlessShell()) return t.skip('chrome-headless-shell absent : npx playwright install chromium-headless-shell');
  const r = await runQa({ file: 'parcours.json', worktree: wt, environment, name: 'reel' });
  if (!r.ok && /QA impossible/.test(r.error)) return t.skip('le navigateur ne démarre pas dans ce bac à sable : ' + r.error.slice(0, 120));
  assert.equal(r.ok, true, r.error);
  const by = Object.fromEntries(r.results.map((x) => [x.id, x]));
  assert.equal(by.passe.ok, true, by.passe.echec);
  assert.equal(readFileSync(path.join(r.dir, 'captures', 'passe-accueil.png')).subarray(0, 8).toString('hex'), '89504e470d0a1a0a');
  assert.match(by.echoue.echec, /attendre_texte « Texte qui ne vient jamais » : absent/);
  assert.match(by.inconnue.echec, /étape inconnue « executer »/);
  assert.equal(by.externe.ok, true); assert.ok(by.externe.bloquees >= 2, JSON.stringify(by.externe)); assert.ok(by.externe.console.some((c) => /erreur de test/.test(c)));
  assert.ok(by.externe.http.some((h) => /^404 GET .*manquante\.json$/.test(h)), JSON.stringify(by.externe.http));
  assert.equal(by['base-login-eleve'].ok, true, by['base-login-eleve'].echec);
  assert.equal(by.connecte.ok, true, by.connecte.echec); assert.deepEqual(by.connecte.cles, ['pages.play.title']);
  assert.match(by['mdp-clair'].echec, /mot de passe en clair/);
  const c = await captureConnected({ target: `${base}/app.html`, account: 'eleve.test', worktree: wt, environment, name: 'reel-app' });
  assert.equal(c.ok, true, c.error); assert.equal(c.dark, true); assert.equal(c.files.length, WIDTHS.length * 2 + 1);
});
