// What a launched session reads again at every call, cut to its task (LEV, 7 November; mesure CTX: 24 % of a week's
// cost was context read again). Three levers:
//   (a) READ_RULE: the session reads what its task cites, nothing by default (CLAUDE.md's « Lis docs/flot.md, ROADMAP.md
//       et docs/ » is for the planning and the pilot); PLANNER_DOCS_RULE asks the planner to cite the useful docs;
//   (b) skillSettings: a session only sees the skills of its kind, by enabledPlugins in the --settings of its launch
//       (front: taste-skill and frontend-design; back, qa, tests, migration: no design, video or logo plugin);
//   (c) decisionsSection: a prompt that cites docs/decisions.md gets the sections of its domain instead of the file.
//
//   import { READ_RULE, skillSettings, withSkills, decisionsExcerpt, decisionsSection } from './sessionctx.mjs';
//   withSkills(settings, 'back')                      settings with the design/video/logo plugins turned off
//   decisionsExcerpt(text, 'front')                  → { text, titles, chars, total } | null
//   decisionsSection({ prompt, cwd, kind })          → '' | the excerpt as a prompt section
import { existsSync, readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import path from 'node:path';

const fold = (s) => String(s ?? '').toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, '').trim();

// ---------------------------------------------------------------- (a) read what the task cites
export const READ_RULE = "Lecture : lis ce que ta tâche cite, rien d'autre d'office. Un document que ton prompt ne nomme pas (feuille de route, docs/flot.md, docs/decisions.md, le dossier docs/ en entier) ne se lit pas par principe, même si CLAUDE.md le demande : cette consigne-là vaut pour la planification et le pilote. Un doute sur une règle : Grep le mot dans docs/ et lis la seule section trouvée.";
// Sourced context (Dev, 7 Nov.): checked at the pre-review (lib/prereview.mjs checkSources), an unsourced claim becomes « supposé »
export const SOURCE_RULE = "Source : toute affirmation sur l'infra ou les outils d'une équipe cite le fichier qui la prouve (chemin, ligne si possible) ; sans fichier, écris « supposé » devant.";
export const PLANNER_DOCS_RULE = "Chaque prompt de session cite les fichiers de docs utiles à sa tâche (chemin, et section quand le fichier est long) : une session ne lit d'office que ce que son prompt cite, ni docs/flot.md, ni ROADMAP.md, ni docs/ en entier. Citer docs/decisions.md lui joint les sections de son domaine, pas le fichier.";

// ---------------------------------------------------------------- (b) the skills of its kind
// The plugins by family, by name (the part before @marketplace): the developer's ids differ, the names do not
export const PLUGIN_FAMILY = { 'frontend-design': 'design', 'taste-skill': 'design', 'logo-design': 'logo', hyperframes: 'video' };
// What each kind keeps (lib/learning.mjs kindOf). null: unchanged (docs and other may make a video or a mark)
export const KEEP = {
  front: ['frontend-design', 'taste-skill'],
  design: ['frontend-design', 'taste-skill', 'logo-design', 'hyperframes'],
  back: [], migration: [], qa: [], tests: [],
  docs: null, other: null,
};
// The plugins installed for this user: ~/.claude/plugins/installed_plugins.json (CLAUDE_CONFIG_DIR when set)
export const installedPlugins = ({ home = homedir(), env = process.env } = {}) => {
  const dir = env.CLAUDE_CONFIG_DIR || path.join(home, '.claude');
  try { const j = JSON.parse(readFileSync(path.join(dir, 'plugins', 'installed_plugins.json'), 'utf8')); return Object.keys(j.plugins || {}); } catch { return []; }
};
// → { enabledPlugins: { id: false } } for the design/video/logo plugins the kind does not keep; never turns one on
export const skillSettings = (kind, { installed = installedPlugins() } = {}) => {
  const keep = Object.prototype.hasOwnProperty.call(KEEP, kind) ? KEEP[kind] : null;
  if (!keep) return {};
  const off = installed.filter((id) => { const name = String(id).split('@')[0]; return PLUGIN_FAMILY[name] && !keep.includes(name); });
  return off.length ? { enabledPlugins: Object.fromEntries(off.map((id) => [id, false])) } : {};
};
export const withSkills = (settings = {}, kind, opts) => {
  const s = skillSettings(kind, opts);
  return s.enabledPlugins ? { ...settings, enabledPlugins: { ...(settings.enabledPlugins || {}), ...s.enabledPlugins } } : settings;
};

// ---------------------------------------------------------------- (c) the excerpt of docs/decisions.md
// The `##` sections of each domain, by the start of their title (accents and case folded); `# Nouvelles décisions` and
// `# À trancher` always go (the recent lines, not yet sorted). A file without these titles: every section whose title
// holds a word of the domain, else null (the session reads the file as before).
export const DOMAINS = {
  front: ['interface', 'theme', 'accueil', 'flot, plans', 'revue (ecran)', 'telephone', 'captures', 'vision'],
  design: ['interface', 'theme', 'accueil', 'flot, plans', 'revue (ecran)', 'telephone', 'captures', 'vision', 'nom et identite'],
  back: ['sessions et worktrees', 'tests et fusion', 'pilote', 'budget', 'projets et installation', 'produit et moteur', 'architecture', 'plans, planificateur', 'modeles et memoire', 'reseau', 'secrets', 'garde-fous', 'connecteurs'],
  migration: ['sessions et worktrees', 'tests et fusion', 'produit et moteur', 'architecture', 'secrets'],
  qa: ['tests et fusion', 'captures', 'revue', 'interface : principes', 'garde-fous'],
  tests: ['tests et fusion', 'captures', 'revue', 'interface : principes'],
  docs: ['vision', 'nom', 'licence', 'commercial', 'comm', 'projets tiers'],
  other: ['vision', 'produit et moteur', 'tests et fusion', 'garde-fous'],
};
const ALWAYS = ['nouvelles decisions', 'a trancher'];
// The file cut in sections: the lines before the first heading, then one per `#` or `##` heading
const sectionsOf = (text) => {
  const out = []; let cur = { level: 0, title: '', lines: [] };
  for (const line of String(text).split('\n')) {
    const m = /^(#{1,2})\s+(.*)$/.exec(line);
    if (m) { out.push(cur); cur = { level: m[1].length, title: m[2].trim(), lines: [line] }; } else cur.lines.push(line);
  }
  out.push(cur);
  return out;
};
export const decisionsExcerpt = (text, kind) => {
  const keys = DOMAINS[kind] || DOMAINS.other;
  const all = sectionsOf(text); const total = String(text).length;
  const picked = []; const titles = []; let h1 = null; let h1Used = false; let head = true;
  for (const sec of all) {
    const t = fold(sec.title);
    if (sec.level === 1 && head) { head = false; picked.push(sec.lines.join('\n')); continue; } // the file's title and what it says it is
    if (sec.level === 1) {
      h1 = sec; h1Used = false;
      if (ALWAYS.some((k) => t.startsWith(k))) { picked.push(sec.lines.join('\n')); titles.push(sec.title); h1Used = true; h1 = null; }
      continue;
    }
    if (sec.level === 0) { picked.push(sec.lines.join('\n')); continue; } // the file's head: what it is
    const underAlways = h1 === null && h1Used;
    if (underAlways || keys.some((k) => t.startsWith(k))) {
      if (h1 && !h1Used) { picked.push(h1.lines.join('\n')); h1Used = true; }
      picked.push(sec.lines.join('\n')); if (!underAlways) titles.push(sec.title);
    }
  }
  if (!titles.length) return null;
  const out = picked.join('\n').replace(/\n{3,}/g, '\n\n').trim() + '\n';
  return { text: out, titles, chars: out.length, total };
};
const CITES = /(?:^|[^\w/.-])(?:\.\/)?docs\/decisions\.md\b/;
export const citesDecisions = (prompt) => CITES.test(String(prompt || ''));
// The section the server joins to a prompt that cites docs/decisions.md: '' when it does not, or the file is missing
export const decisionsSection = ({ prompt, cwd, kind }) => {
  if (!cwd || !citesDecisions(prompt)) return '';
  const file = path.join(cwd, 'docs', 'decisions.md');
  if (!existsSync(file)) return '';
  let text; try { text = readFileSync(file, 'utf8'); } catch { return ''; }
  const ex = decisionsExcerpt(text, kind); if (!ex) return '';
  const ko = (n) => Math.max(1, Math.round(n / 1024));
  return `\n\n## Extrait de docs/decisions.md (domaine ${kind || 'other'})\n\nLes sections utiles à ta tâche, jointes à la place du fichier (${ko(ex.chars)} Ko sur ${ko(ex.total)}) : ne relis pas docs/decisions.md en entier ; une règle d'un autre domaine se trouve par Grep.\n\n${ex.text}`;
};
