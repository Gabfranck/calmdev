#!/usr/bin/env node
// Finds the personal traces left in the files git tracks, before the repository goes public.
//
//   node scripts/trace-scan.mjs            one line per trace (file:line kind sample), exit 1 when there is one
//   node scripts/trace-scan.mjs --words public-manifest.json   adds the manifest's traceWords (the public export's scan)
//   node scripts/trace-scan.mjs --fixtures   the files of EXEMPT (traces on purpose) are checked for the words only (CI)
//   node scripts/trace-scan.mjs --living   rewrites docs/decisions.md and docs/backlog.md in place (home paths to ~,
//                                          other projects to « un projet client »), then scans
//   import { scanTracked } from './trace-scan.mjs'; scanTracked({ root, exempt }) -> [{ file, line, kind, sample }]
//
// Every detection rule lives in lib/privacy.mjs (scan for secrets, home folders, phones and LAN addresses; redact for
// e-mails, the developer's name and the other projects): nothing is copied here. The developer's name comes from git
// config, the other projects from the machine (~/.config/escadrille/projects.json, ESCADRILLE_PROJECTS, and
// .escadrille/trace-names.txt, one name per line, never tracked): a list of clients is never committed.
import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import * as privacy from '../lib/privacy.mjs';
import { vars, configDir, projectDir } from '../lib/names.mjs';

// The explicit allowlist (Dev, 2 November). Anything else that looks like a trace is one.
export const ALLOW_WORDS = [
  'Orchard', // Dev's public project: the launch story rests on it
  'Gabfranck', // Dev's public GitHub account, in the repository URL
  'orchard-studio', // Orchard's avatar studio, the first escadrilles' project: public with it (Dev, 3 November)
];
export const ALLOW_DOMAINS = [
  'example.com', 'example.org', 'example.invalid', 'host.example', // reserved by RFC 2606 (subdomains too): an e-mail there belongs to nobody
  'b.io', // 'a@b.io', the e-mail redactUsage must blank in test/status-usage.test.mjs
  'host.com', // 'user@host.com', a rejected network domain in test/running.test.mjs
  'github.com', // git@github.com (the SSH user of every GitHub remote) and user:pw@github.com in remote-normalization tests
];
// Fake values the redaction tests feed to the masks on purpose: each one is a fixture, none was ever a real secret.
export const ALLOW_FAKES = [
  /ExponentPushToken\[(?:…|xxx|test|dead|d1|ok)\]/g, // placeholders in docs/phone.md and the phone tests (a real one has 22 characters)
  /sk-ant-api03-AbCdEfGh12345678IjKlMnOp/g, // test/mainchat.test.mjs, test/fixtures/transcript.jsonl: maskSecrets fixture
  /Bearer abcdefgh12345678/g, // test/stories.test.mjs: clean() fixture
  /sk-abcdefghijklmnop/g, // test/status-usage.test.mjs: redactUsage fixture
  /tok-(?:gab|lea)-\d{10}/g, // test/team.test.mjs: relay tokens of the two fake members
  /prof\.martin@college\.fr/g, // test/playbooks.test.mjs: the e-mail a playbook must refuse
  /ghp_abcdefghijklmnopqrstuvwxyz0123/g, // test/fake-gh.mjs: the token the GitHub relay must never show (phase 16 GH)
  /\/Users\/x(?![\w.-])/g, // test/testapps.test.mjs: the one-letter fake home of its worktree paths (a real user is longer)
  /@[1-9]x\.(?:png|jpe?g|webp|gif|svg)\b/gi, // retina image names (128x128@2x.png in desktop/): a scale suffix, no e-mail
];
export const ALLOW_LINES = [
  { file: 'LICENSE', re: /^Copyright (?:\(c\) )?\d{4} / }, // the copyright line (FSL notice, formerly MIT) names its author on purpose
  { file: 'team/LICENSE', re: /^Copyright \d{4} / }, // the team licence's copyright line, the same author on purpose
  { file: 'site/public/mentions-legales.html', re: /^\s*<dd>G\w+ F\w+<\/dd>$/ }, // the publisher, required by law on the public site
  { file: 'scripts/site-public.mjs', re: /^export const CONTACT = 'contact@calmdev\.ai';$/ }, // the public contact box of calmdev.ai, to confirm by Dev
];
// Written live on main by the server (POST /api/memory) and the pilot: cleaned by --living just before the push.
export const LIVING = ['docs/decisions.md', 'docs/backlog.md'];
// Files whose traces are there on purpose (test/trace-scan.test.mjs, and --fixtures for the public CI, docs/ci.md):
// the test skips them, --fixtures checks only the extra words in them.
export const EXEMPT = [
  ...LIVING, // docs/decisions.md and docs/backlog.md are written live on main (POST /api/memory, the pilot): cleaned by --living before the push
  'site/docs/decisions.html', 'site/docs/backlog.html', // generated from those two: clean once they are, by node scripts/site.mjs
  // Frozen for this branch, decided by Dev (2 November, night): the privacy guardrail, its own fixtures, its export script,
  // the page generated from docs/publication.md (session V writes it), and session C's fresh-install test.
  'lib/privacy.mjs', 'test/privacy.test.mjs', 'scripts/research-export.mjs',
  'site/docs/publication.html', 'test/fresh-install.test.mjs',
  'test/mergeprivacy.test.mjs', // session B's merge refusal: its fixtures plant traces on purpose
  'LICENSE', 'team/LICENSE', // the copyright holder's legal name, required by the licence text (Dev, 5 November)
  'lib/readonly.mjs', 'test/readonly.test.mjs', // the read-only guard names home paths and its glob forms on purpose
  // the public export's own list of words to hunt (client names, home paths): private on main, never exported
  'public-manifest.json', 'test/public-export.test.mjs',
];

const GENERIC = /^(api|web|app|apps|front|back|server|docs|mobile|site|test|tests|demo|work)$/i;
const git = (root, args) => { try { return execFileSync('git', args, { cwd: root, stdio: ['ignore', 'pipe', 'ignore'], maxBuffer: 64 << 20 }).toString(); } catch { return ''; } };
const readLines = (file) => { try { return readFileSync(file, 'utf8').split('\n').map((s) => s.trim()).filter((s) => s && !s.startsWith('#')); } catch { return []; } };

export const traceContext = (root) => {
  // the full name and the e-mail's local part (the address itself is caught as an e-mail; its domain is no name)
  const names = [git(root, ['config', 'user.name']).trim(), git(root, ['config', 'user.email']).trim().split('@')[0]].filter(Boolean);
  let projects = [];
  const reg = vars.PROJECTS || configDir('projects.json');
  try { projects = JSON.parse(readFileSync(reg, 'utf8')).projects.map((p) => p.path); } catch {}
  const common = path.resolve(root, git(root, ['rev-parse', '--git-common-dir']).trim() || '.git');
  for (const dir of new Set([root, path.dirname(common)])) projects.push(...readLines(projectDir(dir, 'trace-names.txt')).map((n) => '/' + n));
  const ctx = privacy.context({ home: '', names, projects, keep: [...privacy.PRODUCT_NAMES, ...ALLOW_WORDS.map((w) => w.toLowerCase())] });
  const allowed = (n) => ALLOW_WORDS.some((w) => n.toLowerCase().includes(w.toLowerCase()));
  ctx.names = ctx.names.filter((n) => !allowed(n));
  ctx.others = ctx.others.filter((n) => !allowed(n) && n.length > 3 && !GENERIC.test(n));
  ctx.home = '';
  return ctx;
};

const esc = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
const ALLOW_RE = new RegExp(`${ALLOW_WORDS.map(esc).join('|')}`, 'gi');
// Reserved names (RFC 2606, RFC 6761): example, example.com/.net/.org, *.example, *.test, *.invalid, localhost. An
// address or a URL's user:password there belongs to nobody, so the whole « user[:pw]@host » is blanked before the scan.
export const RESERVED = '(?:example(?:\\.(?:com|net|org))?|test|invalid|localhost)';
const DOMAIN_RE = new RegExp(`[A-Za-z0-9._%+-]+(?::[^\\s@/]*)?@(?:[A-Za-z0-9-]+\\.)*(?:${[...ALLOW_DOMAINS.map(esc), RESERVED].join('|')})(?![A-Za-z0-9-]|\\.[A-Za-z0-9])`, 'gi');
const PLACEHOLDERS = [['<email>', 'email'], ['<dev>', 'name'], ['<autre-projet>', 'project']];
const count = (s, w) => s.split(w).length - 1;

export const scanLine = (raw, ctx, home = homedir()) => {
  let text = raw.replace(ALLOW_RE, '').replace(DOMAIN_RE, '');
  for (const re of ALLOW_FAKES) text = text.replace(re, '');
  const out = privacy.scan(text, ctx).map((f) => ({ kind: f.kind, sample: f.sample }));
  if (home && home !== '/' && text.includes(home) && !out.some((f) => f.kind === 'home')) out.push({ kind: 'home', sample: home });
  const red = privacy.redact(text, ctx);
  for (const [ph, kind] of PLACEHOLDERS) if (count(red, ph) > count(text, ph)) out.push({ kind, sample: raw.trim().slice(0, 80) });
  return out;
};

// Tracked although .gitignore excludes them (plans/*.json committed before the rule): they leave the index on main
// (docs/publication.md, « Les plans »), never published; listed apart, not scanned line by line.
export const trackedIgnored = (root) => git(root, ['ls-files', '-z', '-c', '-i', '--exclude-standard']).split('\0').filter(Boolean);

// Extra words for a public export (public-manifest.json « traceWords », never exported): client and colleague names,
// ticket prefixes, words the allowlist keeps on main. Checked on the raw line, so ALLOW_WORDS does not hide them.
export const wordFinder = (words = []) => {
  const res = words.map((w) => new RegExp(w));
  return (raw) => res.flatMap((re) => { const m = raw.match(re); return m ? [{ kind: 'word', sample: m[0] }] : []; });
};

// fixtures: files whose fake homes, phones and secrets are there on purpose (the privacy guard's own tests, the same
// list as EXEMPT in test/trace-scan.test.mjs): only the extra words are checked in them.
export const scanTracked = ({ root = process.cwd(), exempt = [], words = [], fixtures = [] } = {}) => {
  const ctx = traceContext(root); const extra = wordFinder(words);
  const files = git(root, ['ls-files', '-z']).split('\0').filter(Boolean);
  const ignored = new Set(trackedIgnored(root));
  const found = [];
  for (const file of files) {
    if (exempt.includes(file) || ignored.has(file)) continue;
    let buf; try { buf = readFileSync(path.join(root, file)); } catch { continue; } // deleted or a directory (submodule)
    if (buf.includes(0)) continue; // binary
    const lines = buf.toString('utf8').split('\n');
    lines.forEach((l, i) => {
      if (ALLOW_LINES.some((a) => a.file === file && a.re.test(l))) return;
      for (const f of [...(fixtures.includes(file) ? [] : scanLine(l, ctx)), ...extra(l)]) found.push({ file, line: i + 1, ...f });
    });
  }
  return found;
};

// --living: only the lines that carry a trace are rewritten, so a sha or a quote elsewhere stays as written.
export const cleanLiving = ({ root = process.cwd() } = {}) => {
  const ctx = traceContext(root); const home = homedir(); let changed = 0;
  for (const file of LIVING) {
    const full = path.join(root, file); if (!existsSync(full)) continue;
    const lines = readFileSync(full, 'utf8').split('\n');
    const next = lines.map((l) => {
      if (!scanLine(l, ctx).length) return l;
      const kept = []; const masked = l.replace(ALLOW_RE, (m) => { kept.push(m); return `\u0000${kept.length - 1}\u0000`; });
      return privacy.redact(masked, { ...ctx, home })
        .replace(/<autre-projet>/g, 'un projet client').replace(/<dev>/g, 'le développeur')
        .replace(/\u0000(\d+)\u0000/g, (_, n) => kept[n]);
    });
    if (next.join('\n') !== lines.join('\n')) { writeFileSync(full, next.join('\n')); changed++; }
  }
  return changed;
};

if (process.argv[1] && fileURLToPath(import.meta.url) === path.resolve(process.argv[1])) {
  const root = git(process.cwd(), ['rev-parse', '--show-toplevel']).trim() || process.cwd();
  if (process.argv.includes('--living')) console.log(`--living : ${cleanLiving({ root })} fichier(s) réécrit(s)`);
  const wi = process.argv.indexOf('--words'); // --words <public-manifest.json>: its traceWords, for a public export
  const words = wi > 0 ? JSON.parse(readFileSync(process.argv[wi + 1], 'utf8')).traceWords || [] : [];
  // --fixtures: the files of EXEMPT are checked for the extra words only (the public CI, docs/ci.md)
  const found = scanTracked({ root, words, fixtures: process.argv.includes('--fixtures') ? EXEMPT : [] });
  for (const f of found) console.log(`${f.file}:${f.line} ${f.kind} ${f.sample}`);
  console.log(found.length ? `${found.length} trace(s) dans ${new Set(found.map((f) => f.file)).size} fichier(s)` : 'aucune trace');
  const stale = trackedIgnored(root);
  if (stale.length) console.log(`${stale.length} fichier(s) suivi(s) malgré .gitignore, à retirer de l'index sur main (git rm --cached) :\n  ${stale.join('\n  ')}`);
  process.exit(found.length || stale.length ? 1 : 0);
}
