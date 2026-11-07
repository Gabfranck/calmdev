// « Avant de signer » (docs/apprendre-en-signant.md): a few leads (« pistes ») in plain words at the moment of
// approving, the most important first, the rest folded; outside the developer's domains a lead is marked « à faire
// valider » and a short question to a peer is prepared with its evidence. Pure but for the profile file
// (~/.config/calmdev/signing.json: the domains the developer signs alone, the detectors they said they know).
// No network, no model: local detectors on added lines, broken rules, green checks, and the session's own
// assumptions (`assume` of its last state block).
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import path from 'node:path';
import { envVar, configDir } from './names.mjs';

// ---------- the developer's profile ----------

// The domains a developer declares once (Accès, or the line above the leads), as shown: Front · Back · Données ·
// Infra · Sécurité · Juridique.
export const DOMAINS = ['front', 'back', 'data', 'infra', 'security', 'legal'];
export const DOMAIN_LABEL = { front: 'Front', back: 'Back', data: 'Données', infra: 'Infra', security: 'Sécurité', legal: 'Juridique' };
// a lead's domain -> the declared domain that covers it; tests and null are never « hors domaine »
const COVER = { privacy: 'security', security: 'security', payments: 'security', data: 'data', infra: 'infra', legal: 'legal' };
// the recommendation pre-checked the first time: the code domains, the rest asked to a peer
export const RECOMMENDED = ['front', 'back'];

export const profileFile = (env = process.env) => envVar('SIGNING', env) || configDir('signing.json');
export const readProfile = (file = profileFile()) => {
  try { const p = JSON.parse(readFileSync(file, 'utf8')); return { domains: Array.isArray(p.domains) ? p.domains.filter((d) => DOMAINS.includes(d)) : null, known: Array.isArray(p.known) ? p.known.map(String) : [] }; }
  catch { return { domains: null, known: [] }; }
};
// patch: { domains?: string[] | null, know?: string, unknow?: string }
export const writeProfile = (patch = {}, file = profileFile()) => {
  const p = readProfile(file);
  if ('domains' in patch) p.domains = Array.isArray(patch.domains) ? [...new Set(patch.domains.filter((d) => DOMAINS.includes(d)))] : null;
  if (patch.know && !p.known.includes(patch.know)) p.known.push(String(patch.know));
  if (patch.unknow) p.known = p.known.filter((k) => k !== patch.unknow);
  mkdirSync(path.dirname(file), { recursive: true });
  writeFileSync(file, JSON.stringify(p, null, 2) + '\n', { mode: 0o600 });
  return p;
};

// The session's assumptions (`assume` of its state block), kept in its worktree (.calmdev/ is never committed)
// until the review reads them; the last state that names some replaces the earlier ones.
export const assumeFile = (dir) => path.join(dir, '.calmdev', 'assume.json');
export const saveAssume = (dir, list) => {
  if (!dir || !Array.isArray(list) || !list.length) return;
  try { mkdirSync(path.dirname(assumeFile(dir)), { recursive: true }); writeFileSync(assumeFile(dir), JSON.stringify(list.slice(0, 3)) + '\n'); } catch {}
};
export const readAssume = (dir) => { try { const a = JSON.parse(readFileSync(assumeFile(dir), 'utf8')); return Array.isArray(a) ? a.slice(0, 3) : []; } catch { return []; } };

// ---------- detectors ----------

const added = (f) => (f.hunks ?? []).flatMap((h) => h.lines).filter((l) => l.kind === 'add');
const base = (p) => p.split('/').pop();
const PII = '(email|e_mail|phone|telephone|password|passwd|iban|birth|birthdate|address)';
const isAuthPath = (p) => /(auth|login|session|token|password|jwt|oauth|security)/i.test(p);
const isMigrationPath = (p) => /(^|\/)migrations?\//i.test(p) || /migrat/i.test(base(p)) || /(^|\/)db\/.*\.sql$/i.test(p);
const isDoc = (p) => /\.(md|mdx|txt|rst)$/i.test(p);

// a line detector: id, kind, domain, the regex on an added line, an optional path filter, the sentence, the detail,
// and what the peer is asked. Templates, not free text: a concrete subject, its consequence in one sentence.
export const DETECTORS = [
  { id: 'pii-log', kind: 'fragile', domain: 'privacy', re: new RegExp(`(console\\.\\w+|\\blog(ger)?\\.\\w+|\\bprint)\\s*\\(.*\\b${PII}`, 'i'),
    title: 'Une donnée personnelle part en clair dans le journal. Quiconque lit les journaux la voit.',
    detail: 'En clair : lisible par qui a accès aux journaux. D\'habitude on masque le champ (a***@x.fr) ou on ne journalise que son identifiant.',
    ask: 'Les journaux partent-ils ailleurs que sur nos machines ? Faut-il masquer ce champ ?' },
  { id: 'http-url', kind: 'fragile', domain: 'privacy', re: /['"`]http:\/\/(?!localhost|127\.0\.0\.1|0\.0\.0\.0|\[::1\])/i,
    title: 'Une adresse en http:// sans chiffrement : ce qui y passe se lit sur le réseau.',
    detail: 'http:// envoie tout en clair ; https:// chiffre. Hors machine locale, on prend https://.',
    ask: 'Ce service a-t-il une adresse https:// ? Des données personnelles y passent-elles ?' },
  { id: 'cookie-flags', kind: 'fragile', domain: 'privacy', re: /(set-cookie|\.cookie\s*\(|cookies?\.set\s*\()/i, unless: /secure/i,
    title: 'Un cookie posé sans « secure » : il peut partir sur une connexion non chiffrée.',
    detail: 'Les options secure et httpOnly empêchent l\'envoi en clair et la lecture par un script de la page.',
    ask: 'Ce cookie doit-il être secure et httpOnly ?' },
  { id: 'tls-off', kind: 'fragile', domain: 'security', re: /rejectUnauthorized\s*:\s*false|NODE_TLS_REJECT_UNAUTHORIZED|verify\s*=\s*False|InsecureSkipVerify\s*:\s*true/,
    title: 'La vérification du certificat est coupée : n\'importe qui sur le réseau peut se faire passer pour le serveur.',
    detail: 'Utile en local, dangereux ailleurs. D\'habitude on la coupe seulement sous une variable de dev.',
    ask: 'Cette coupure de vérification TLS peut-elle atteindre la production ?' },
  { id: 'eval', kind: 'fragile', domain: 'security', re: /\beval\s*\(|new Function\s*\(/,
    title: 'Du texte exécuté comme du code : si ce texte vient d\'un utilisateur, il exécute ce qu\'il veut.',
    detail: 'eval et new Function exécutent une chaîne. On préfère JSON.parse ou une table de fonctions.',
    ask: 'La chaîne exécutée peut-elle venir d\'une saisie ou d\'un service externe ?' },
  { id: 'sql-concat', kind: 'fragile', domain: 'security', re: /\b(select|insert|update|delete)\b.*(['"`]\s*\+\s*\w|\$\{)/i, skipDocs: true,
    title: 'Une requête SQL assemblée avec une valeur : une saisie bien choisie peut la détourner.',
    detail: 'Injection SQL. On passe les valeurs en paramètres (?, $1) au lieu de les coller dans le texte.',
    ask: 'La valeur insérée dans cette requête peut-elle venir d\'un utilisateur ?' },
  { id: 'cors-star', kind: 'fragile', domain: 'security', re: /Access-Control-Allow-Origin['"]?\s*[:,]\s*['"]\*|origin\s*:\s*['"]\*['"]/i,
    title: 'Tout site peut appeler cette API depuis le navigateur d\'un utilisateur.',
    detail: 'CORS « * » ouvre l\'API à toutes les origines. On liste les origines permises.',
    ask: 'Cette API doit-elle vraiment répondre à toutes les origines ?' },
  { id: 'secret-literal', kind: 'fragile', domain: 'security', re: /(api[_-]?key|secret|token|passw(or)?d)['"]?\s*[:=]\s*['"][A-Za-z0-9_\-\/+=]{12,}['"]/i,
    title: 'Un secret écrit en dur dans le code : il part avec chaque copie du dépôt.',
    detail: 'On le lit d\'une variable d\'environnement ou du trousseau, et on change celui qui a fuité.',
    ask: 'Ce secret est-il réel ? Faut-il le révoquer ?' },
  { id: 'empty-catch-auth', kind: 'fragile', domain: 'security', re: /catch\s*(\([^)]*\))?\s*\{\s*\}/, path: isAuthPath,
    title: 'Une erreur avalée en silence dans du code d\'authentification : un échec peut passer pour un succès.',
    detail: 'Un catch vide autour d\'une vérification laisse continuer comme si elle avait réussi.',
    ask: 'Si ce bloc échoue, l\'accès doit-il être refusé ?' },
  { id: 'drop-column', kind: 'learn', domain: 'data', re: /DROP\s+COLUMN|dropColumn|removeColumn|DROP\s+TABLE/i,
    title: 'Une colonne ou une table supprimée : ses données partent avec, sans retour arrière.',
    detail: 'Avant de supprimer, on vérifie qu\'aucun code ne la lit plus et qu\'une sauvegarde existe.',
    ask: 'Ces données doivent-elles être gardées ou migrées avant suppression ?' },
  { id: 'not-null', kind: 'learn', domain: 'data', re: /NOT NULL/i, unless: /DEFAULT|CREATE TABLE/i, path: isMigrationPath,
    title: 'Une colonne obligatoire sans valeur par défaut : sur une base déjà remplie, la migration échoue.',
    detail: 'Les lignes existantes n\'ont pas de valeur. On donne un DEFAULT, ou on remplit puis on rend obligatoire.',
    ask: 'La table est-elle déjà remplie en production ?' },
  { id: 'env-var', kind: 'learn', domain: 'infra', re: /process\.env\.([A-Z][A-Z0-9_]{2,})|os\.environ|getenv\s*\(|ENV\[/, skipDocs: true,
    title: 'Une variable d\'environnement lue : chaque machine qui lance le code doit la définir.',
    detail: 'Sans elle, le code prend sa valeur de repli ou plante. On la note dans l\'exemple de configuration.',
    ask: 'Cette variable est-elle définie sur les machines de déploiement ?' },
  { id: 'analytics', kind: 'learn', domain: 'legal', re: /\b(gtag|google-analytics|googletagmanager|segment\.(com|io)|mixpanel|posthog|hotjar|amplitude|matomo)\b/i,
    title: 'Un traceur ou un outil de mesure ajouté : il demande en général le consentement de l\'utilisateur.',
    detail: 'Les traceurs non essentiels demandent un consentement explicite (RGPD, ePrivacy).',
    ask: 'Ce traceur est-il couvert par le bandeau de consentement ?' },
];

// path detectors: one lead per file
const PATH_DETECTORS = [
  { id: 'infra-file', kind: 'learn', domain: 'infra', test: (p) => base(p) === 'Dockerfile' || /^docker-compose.*\.ya?ml$/.test(base(p)) || /^\.github\//.test(p) || /\.tf$/.test(p) || /(^|\/)(k8s|kubernetes|helm)\//.test(p) || /nginx/i.test(base(p)),
    title: 'Un fichier d\'infrastructure modifié : il change la façon dont le code est construit ou déployé.',
    detail: 'Une erreur ici casse le déploiement de tout le monde, pas seulement cette fonction.',
    ask: 'Ce changement de construction ou de déploiement est-il attendu ?' },
  { id: 'license', kind: 'learn', domain: 'legal', test: (p) => /^(LICEN[CS]E|COPYING)(\.|$)/i.test(base(p)) || /(cgu|terms|privacy-policy|mentions-legales)/i.test(base(p)),
    title: 'Un texte juridique modifié : licence ou conditions engagent le projet.',
    detail: 'Ces textes se relisent par qui peut engager le projet.',
    ask: 'Ce changement de texte juridique est-il validé ?' },
];

const KIND_W = { fragile: 100, learn: 50, reliable: 0 };
const DOMAIN_W = { privacy: 60, security: 50, payments: 50, data: 40, infra: 30, legal: 20, tests: 10 };

const evidenceOf = (f, line, span = 3) => {
  const all = (f.hunks ?? []).flatMap((h) => h.lines).filter((l) => l.kind !== 'del');
  const i = all.findIndex((l) => l.new === line);
  if (i < 0) return [];
  return all.slice(Math.max(0, i - span), i + span + 1).map((l) => ({ path: f.path, line: l.new, text: l.text }));
};

const trim = (s, n = 120) => { const t = String(s ?? '').trim(); return t.length > n ? t.slice(0, n - 1) + '…' : t; };

// files: the normalized files of the pre-review; violations: its rules; checks: its run checks;
// assume: up to three things the session supposed without proof; profile: { domains, known }; readFirst: its list
export const buildPistes = ({ files = [], violations = [], checks = [], assume = [], profile = { domains: null, known: [] }, readFirst = [], branch = null } = {}) => {
  const out = [];
  const push = (p) => out.push({ outside: false, ask: null, line: null, path: null, source: 'check', ...p });
  for (const f of files) {
    if (f.status === 'deleted' || f.generated) continue;
    for (const d of PATH_DETECTORS) if (d.test(f.path)) push({ id: `${d.id}:${f.path}`, detector: d.id, kind: d.kind, domain: d.domain, path: f.path, title: d.title, detail: d.detail, question: d.ask, evidence: [] });
    const seen = new Set();
    for (const l of added(f)) {
      for (const d of DETECTORS) {
        if (seen.has(d.id) || (d.path && !d.path(f.path)) || (d.skipDocs && isDoc(f.path)) || !d.re.test(l.text) || (d.unless && d.unless.test(l.text))) continue;
        seen.add(d.id); // one lead per detector and file: the first line, the others are the same thing
        push({ id: `${d.id}:${f.path}:${l.new}`, detector: d.id, kind: d.kind, domain: d.domain, path: f.path, line: l.new, title: d.title, detail: d.detail, question: d.ask, code: trim(l.text), evidence: evidenceOf(f, l.new) });
      }
    }
  }
  for (const v of violations) if (v.level === 'error' && v.path)
    push({ id: `rule:${v.path}:${v.line ?? ''}:${v.rule}`, detector: `rule:${v.rule}`, kind: 'fragile', domain: null, path: v.path, line: v.line, source: 'rule', title: `Règle du projet enfreinte : ${trim(v.rule, 90)}`, detail: v.text, evidence: [] });
  for (const a of (Array.isArray(assume) ? assume : []).slice(0, 3)) if (a && String(a).trim())
    push({ id: `assume:${trim(a, 60)}`, detector: 'assume', kind: 'learn', domain: null, source: 'session', title: `Supposé par la session : ${trim(String(a).replace(/^supposé\s*:\s*/i, ''), 140)}`, detail: 'Dit par la session qui a écrit le code : elle signale un angle mort, elle ne juge pas son travail.', evidence: [] });
  // « À lire d'abord » joins the leads: a file to read first without a lead becomes « fichier à risque »
  for (const r of readFirst) if (!out.some((p) => p.path === r.path))
    push({ id: `risk:${r.path}`, detector: 'risk-file', kind: 'learn', domain: null, path: r.path, title: `Fichier à risque : ${r.why}`, detail: 'Classé par la pré-revue d\'après son chemin et ce qui le touche.', evidence: [] });
  const ran = checks.filter((c) => c && c.name);
  if (ran.length && ran.every((c) => c.ok)) push({ id: 'checks-green', detector: 'checks-green', kind: 'reliable', domain: 'tests', title: `${ran.length > 1 ? `Les ${ran.length} vérifications du projet passent` : 'La vérification du projet passe'}.`, detail: ran.map((c) => c.name).join(' · '), evidence: [] });
  const tests = files.filter((f) => f.status !== 'deleted' && /(^|\/)(test|tests|__tests__|spec)\/|[._-](test|spec)\.[a-z]+$/i.test(f.path));
  if (tests.length) push({ id: 'tests-added', detector: 'tests-added', kind: 'reliable', domain: 'tests', path: tests[0].path, title: `${tests.length > 1 ? `${tests.length} fichiers de test touchés` : 'Un fichier de test touché'} à côté du code.`, detail: tests.map((t) => t.path).join(' · '), evidence: [] });

  const declared = Array.isArray(profile.domains) ? profile.domains : null;
  const known = new Set(profile.known ?? []);
  for (const p of out) {
    const cover = COVER[p.domain];
    p.outside = !!(declared && cover && p.kind !== 'reliable' && !declared.includes(cover));
    p.known = known.has(p.detector);
    p.weight = KIND_W[p.kind] + (DOMAIN_W[p.domain] ?? 25) + (p.outside ? 30 : 0) - (p.known ? 80 : 0);
  }
  out.sort((a, b) => b.weight - a.weight || String(a.path).localeCompare(String(b.path)) || (a.line ?? 0) - (b.line ?? 0));

  // open: three at most; a « learn » in the developer's domain and a known lead stay folded; a reliable one opens
  // only when nothing else does. A fragile lead never disappears: folded, it still counts.
  const inDomain = (p) => declared && COVER[p.domain] && declared.includes(COVER[p.domain]);
  const openable = out.filter((p) => p.kind !== 'reliable' && !p.known && !(p.kind === 'learn' && inDomain(p)));
  const open = (openable.length ? openable : out.filter((p) => p.kind === 'reliable')).slice(0, 3);
  for (const p of out) { p.open = open.includes(p); if (inDomain(p) && p.kind === 'learn') p.detail = trim(p.detail, 80); }

  // the question to a peer, one per domain outside the developer's, with its evidence
  const asks = [];
  for (const cover of [...new Set(out.filter((p) => p.outside).map((p) => COVER[p.domain]))]) {
    const ps = out.filter((p) => p.outside && COVER[p.domain] === cover);
    const lead = ps[0];
    const where = lead.path ? `\`${lead.path}${lead.line ? ':' + lead.line : ''}\`` : '';
    const ev = lead.evidence.slice(0, 10);
    const question = [`Question ${DOMAIN_LABEL[cover].toLowerCase()}${branch ? ` sur \`${branch}\`` : ''} : ${lead.title.replace(/\.$/, '')} (${where}${lead.code ? `, \`${lead.code}\`` : ''}).`,
      lead.question, ps.length > 1 ? `${ps.length - 1} autre${ps.length > 2 ? 's' : ''} point${ps.length > 2 ? 's' : ''} du même domaine : ${ps.slice(1, 4).map((p) => `${p.path}${p.line ? ':' + p.line : ''}`).join(', ')}.` : null,
      ev.length ? `Diff : ${ev.length} lignes ci-dessous.\n\n\`\`\`\n${ev.map((e) => `${e.line}  ${e.text}`).join('\n')}\n\`\`\`` : null].filter(Boolean).join(' ');
    const ask = { to: cover, label: DOMAIN_LABEL[cover], question, evidence: ev };
    for (const p of ps) p.ask = ask;
    asks.push(ask);
  }

  const fragileUnread = out.filter((p) => p.kind === 'fragile').length;
  const folded = out.filter((p) => !p.open);
  const reliable = folded.filter((p) => p.kind === 'reliable').length;
  return {
    pistes: out.map(({ question, code, ...p }) => p),
    asks,
    // the numbers of the three one-line texts (the rest, the line near « Approuver », the header line); the words are
    // the page's, in its language (public/i18n, keys sign.*): outside lists the domain keys
    counts: { open: open.length, folded: folded.length, foldedReliable: reliable, fragile: fragileUnread, outside: asks.map((a) => a.to) },
    // the domains are asked once, the first time a lead falls in one
    declare: !declared && out.some((p) => COVER[p.domain]) ? { domains: DOMAINS, recommended: RECOMMENDED } : null,
  };
};
