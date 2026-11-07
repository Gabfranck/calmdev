// Playbooks: a chain of plans with assets, a config form, ready-to-test criteria and metrics.
// validatePlaybook enforces playbooks/format/playbook.schema.json by hand (no dependency) plus the
// rules a schema cannot say: unique keys, known references, no cycle, placeholders in the config,
// defaults that fit their kind, local-only URLs and no leak (secrets, e-mails, absolute home paths).
// Docs: docs/playbooks.md. Usage: node lib/playbooks.mjs <playbook.json> [--root <dir>]

import { readFileSync, existsSync, readdirSync } from 'node:fs';
import { join, dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const SLUG = /^[a-z0-9]+(-[a-z0-9]+)*$/;
const CONFIG_KEY = /^[a-z][a-zA-Z0-9]*$/;
const METRIC_KEY = /^[a-z][a-z0-9_]*$/;
const TOP = ['$schema', 'id', 'version', 'status', 'license', 'title', 'promise', 'audience', 'price', 'config', 'plans', 'assets', 'ready', 'metrics'];
const REQUIRED = ['id', 'title', 'promise', 'audience', 'price', 'config', 'plans', 'assets', 'ready', 'metrics'];
const KINDS = ['text', 'choice', 'lang', 'money', 'color', 'domain', 'number', 'bool'];
const ASSET_KINDS = ['app-skeleton', 'schema', 'page', 'copy', 'tickets', 'checklist', 'dashboard', 'seed', 'doc'];
const CHECK_KINDS = { file: ['path'], command: ['run'], url: ['url'], count: ['path', 'min'] };
const UNITS = ['count', 'percent', 'money', 'seconds', 'days'];
const PRICE_MODELS = ['one-time', 'subscription', 'revenue-share', 'free'];
const LOCAL_URL = /^http:\/\/(localhost|127\.0\.0\.1)(:\d+)?(\/.*)?$/;
const PLACEHOLDER = /\{\{\s*([^}\s]+)\s*\}\}/g;

// What must never ship in a playbook: keys, tokens, personal addresses, a home path.
const LEAKS = [
  [/\b(sk|pk|rk)_(live|test)_[A-Za-z0-9]{8,}/, 'a Stripe key'],
  [/-----BEGIN [A-Z ]*PRIVATE KEY-----/, 'a private key'],
  [/\b(ghp|gho|github_pat)_[A-Za-z0-9_]{20,}/, 'a GitHub token'],
  [/\bsk-ant-[A-Za-z0-9-]{10,}/, 'an Anthropic key'],
  [/\blin_api_[A-Za-z0-9]{10,}/, 'a Linear key'],
  [/\bxox[abp]-[A-Za-z0-9-]{10,}/, 'a Slack token'],
  [/[A-Za-z0-9._%+-]+@(?!example\.(com|org|net)\b)[A-Za-z0-9.-]+\.[A-Za-z]{2,}/, 'an e-mail address'],
  [/\/(Users|home)\/[A-Za-z0-9._-]+\//, 'an absolute home path'],
];

const isObj = (v) => v !== null && typeof v === 'object' && !Array.isArray(v);
const isStr = (v, min = 1) => typeof v === 'string' && v.trim().length >= min;

function defaultFits(item) {
  const d = item.default;
  switch (item.kind) {
    case 'text': return typeof d === 'string';
    case 'choice': return Array.isArray(item.options) && item.options.includes(d);
    case 'lang': return typeof d === 'string' && /^[a-z]{2}(-[A-Z]{2})?$/.test(d);
    case 'money': return typeof d === 'number' && d >= 0;
    case 'number': return typeof d === 'number' && Number.isFinite(d);
    case 'color': return typeof d === 'string' && /^#[0-9a-fA-F]{6}$/.test(d);
    case 'domain': return typeof d === 'string' && (d === '' || /^([a-z0-9-]+\.)+[a-z]{2,}$/.test(d));
    case 'bool': return typeof d === 'boolean';
    default: return false;
  }
}

function strings(value, path = '', out = []) {
  if (typeof value === 'string') out.push([path, value]);
  else if (Array.isArray(value)) value.forEach((v, i) => strings(v, `${path}[${i}]`, out));
  else if (isObj(value)) for (const [k, v] of Object.entries(value)) strings(v, path ? `${path}.${k}` : k, out);
  return out;
}

/** Leaks found anywhere in a value: [{ path, what }]. */
export function scanLeaks(value) {
  const found = [];
  for (const [path, s] of strings(value)) {
    for (const [re, what] of LEAKS) if (re.test(s)) found.push({ path, what });
  }
  return found;
}

/**
 * Validates a playbook. Options: templates (known template ids; unknown ones are then errors),
 * root (the playbook folder; assets marked ready must then exist there).
 * Returns { ok, errors: [string] }.
 */
export function validatePlaybook(pb, { templates, root } = {}) {
  const errors = [];
  const err = (m) => errors.push(m);
  if (!isObj(pb)) return { ok: false, errors: ['a playbook is a JSON object'] };

  for (const k of REQUIRED) if (!(k in pb)) err(`${k}: missing`);
  for (const k of Object.keys(pb)) if (!TOP.includes(k)) err(`${k}: unknown field`);

  if ('id' in pb && !(typeof pb.id === 'string' && SLUG.test(pb.id))) err('id: lowercase words joined by dashes');
  if ('version' in pb && !/^\d+\.\d+\.\d+$/.test(pb.version ?? '')) err('version: x.y.z');
  if ('status' in pb && !['draft', 'ready', 'retired'].includes(pb.status)) err('status: draft, ready or retired');
  if ('license' in pb && !['example', 'proprietary', 'MIT'].includes(pb.license)) err('license: example, proprietary or MIT');
  if ('title' in pb && !(isStr(pb.title, 3) && pb.title.length <= 120)) err('title: 3 to 120 characters');
  if ('promise' in pb) {
    const p = pb.promise;
    if (!(isStr(p, 10) && p.length <= 200)) err('promise: 10 to 200 characters');
    else if (/\n/.test(p) || /[.!?]\s+\S/.test(p.trim())) err('promise: one sentence');
  }
  if ('audience' in pb && !(isStr(pb.audience, 3) && pb.audience.length <= 300)) err('audience: 3 to 300 characters');

  if ('price' in pb) {
    const pr = pb.price;
    if (!isObj(pr)) err('price: an object { amount, currency, model }');
    else {
      if (!(typeof pr.amount === 'number' && pr.amount >= 0)) err('price.amount: a number >= 0');
      if (!/^[A-Z]{3}$/.test(pr.currency ?? '')) err('price.currency: ISO code, e.g. EUR');
      if (!PRICE_MODELS.includes(pr.model)) err(`price.model: one of ${PRICE_MODELS.join(', ')}`);
      for (const k of Object.keys(pr)) if (!['amount', 'currency', 'model', 'note'].includes(k)) err(`price.${k}: unknown field`);
    }
  }

  const configKeys = new Set();
  if ('config' in pb) {
    if (!Array.isArray(pb.config) || pb.config.length === 0) err('config: a non-empty list');
    else pb.config.forEach((c, i) => {
      const at = `config[${i}]`;
      if (!isObj(c)) return err(`${at}: an object`);
      if (!CONFIG_KEY.test(c.key ?? '')) err(`${at}.key: camelCase`);
      else if (configKeys.has(c.key)) err(`${at}.key: duplicate "${c.key}"`);
      else configKeys.add(c.key);
      if (!isStr(c.label)) err(`${at}.label: missing`);
      if (!KINDS.includes(c.kind)) err(`${at}.kind: one of ${KINDS.join(', ')}`);
      else if (!('default' in c)) err(`${at}.default: missing`);
      else if (!defaultFits(c)) err(`${at}.default: does not fit kind ${c.kind}`);
      if (c.kind === 'choice' && !(Array.isArray(c.options) && c.options.length >= 2)) err(`${at}.options: at least two`);
      for (const k of Object.keys(c)) if (!['key', 'label', 'kind', 'default', 'options', 'help'].includes(k)) err(`${at}.${k}: unknown field`);
    });
  }

  const usePlaceholders = (text, at) => {
    for (const m of String(text).matchAll(PLACEHOLDER)) {
      if (!configKeys.has(m[1])) err(`${at}: {{${m[1]}}} is not a config key`);
    }
  };

  if ('plans' in pb) {
    if (!Array.isArray(pb.plans) || pb.plans.length === 0) err('plans: a non-empty list');
    else {
      const ids = new Set();
      pb.plans.forEach((p, i) => {
        const at = `plans[${i}]`;
        if (!isObj(p)) return err(`${at}: an object`);
        if (!SLUG.test(p.id ?? '')) err(`${at}.id: lowercase words joined by dashes`);
        else if (ids.has(p.id)) err(`${at}.id: duplicate "${p.id}"`);
        else ids.add(p.id);
        const hasT = 'template' in p, hasI = 'idea' in p;
        if (hasT === hasI) err(`${at}: exactly one of template or idea`);
        if (hasT) {
          if (!SLUG.test(p.template ?? '')) err(`${at}.template: a template id`);
          else if (templates && !templates.has(p.template)) err(`${at}.template: unknown template "${p.template}"`);
        }
        if (hasI) { if (!isStr(p.idea, 10)) err(`${at}.idea: at least 10 characters`); else usePlaceholders(p.idea, `${at}.idea`); }
        if ('fields' in p) {
          if (!isObj(p.fields) || !hasT) err(`${at}.fields: an object, with a template only`);
          else for (const [k, v] of Object.entries(p.fields)) {
            if (typeof v !== 'string') err(`${at}.fields.${k}: a string`); else usePlaceholders(v, `${at}.fields.${k}`);
          }
        }
        if (!Array.isArray(p.after)) err(`${at}.after: a list (empty for the first wave)`);
        if (!(typeof p.budget === 'number' && p.budget > 0)) err(`${at}.budget: dollars, > 0`);
        if ('domains' in p && !(Array.isArray(p.domains) && p.domains.every((d) => typeof d === 'string'))) err(`${at}.domains: a list of strings`);
        for (const k of Object.keys(p)) if (!['id', 'title', 'template', 'fields', 'idea', 'after', 'budget', 'domains'].includes(k)) err(`${at}.${k}: unknown field`);
      });
      // References, then cycles (depth-first, three colours).
      const byId = new Map(pb.plans.filter(isObj).map((p) => [p.id, p]));
      for (const p of byId.values()) for (const a of Array.isArray(p.after) ? p.after : []) {
        if (a === p.id) err(`plans.${p.id}.after: depends on itself`);
        else if (!byId.has(a)) err(`plans.${p.id}.after: unknown plan "${a}"`);
      }
      const colour = new Map();
      const visit = (id, trail) => {
        if (colour.get(id) === 2) return false;
        if (colour.get(id) === 1) { err(`plans: cycle ${[...trail, id].join(' -> ')}`); return true; }
        colour.set(id, 1);
        for (const a of byId.get(id)?.after ?? []) if (byId.has(a) && a !== id && visit(a, [...trail, id])) return true;
        colour.set(id, 2);
        return false;
      };
      for (const id of byId.keys()) if (visit(id, [])) break;
    }
  }

  if ('assets' in pb) {
    if (!Array.isArray(pb.assets)) err('assets: a list');
    else {
      const paths = new Set();
      pb.assets.forEach((a, i) => {
        const at = `assets[${i}]`;
        if (!isObj(a)) return err(`${at}: an object`);
        const p = a.path;
        if (typeof p !== 'string' || !/^[A-Za-z0-9._/-]+$/.test(p) || p.startsWith('/') || p.split('/').includes('..')) err(`${at}.path: relative to the playbook, no ..`);
        else if (paths.has(p)) err(`${at}.path: duplicate "${p}"`);
        else {
          paths.add(p);
          if (root && a.state === 'ready' && !existsSync(join(root, p))) err(`${at}.path: "${p}" is marked ready but missing`);
        }
        if (!ASSET_KINDS.includes(a.kind)) err(`${at}.kind: one of ${ASSET_KINDS.join(', ')}`);
        if ('state' in a && !['todo', 'draft', 'ready'].includes(a.state)) err(`${at}.state: todo, draft or ready`);
        for (const k of Object.keys(a)) if (!['path', 'kind', 'state', 'note'].includes(k)) err(`${at}.${k}: unknown field`);
      });
    }
  }

  if ('ready' in pb) {
    if (!Array.isArray(pb.ready) || pb.ready.length === 0) err('ready: a non-empty list of checkable criteria');
    else {
      const ids = new Set();
      pb.ready.forEach((r, i) => {
        const at = `ready[${i}]`;
        if (!isObj(r)) return err(`${at}: an object`);
        if (!SLUG.test(r.id ?? '')) err(`${at}.id: lowercase words joined by dashes`);
        else if (ids.has(r.id)) err(`${at}.id: duplicate "${r.id}"`);
        else ids.add(r.id);
        if (!isStr(r.label)) err(`${at}.label: missing`);
        const c = r.check;
        if (!isObj(c) || !(c.kind in CHECK_KINDS)) return err(`${at}.check.kind: one of ${Object.keys(CHECK_KINDS).join(', ')} (a criterion must be checkable)`);
        for (const k of CHECK_KINDS[c.kind]) if (!(k in c)) err(`${at}.check.${k}: missing for ${c.kind}`);
        if (c.kind === 'url' && !LOCAL_URL.test(c.url ?? '')) err(`${at}.check.url: localhost only (nothing in production)`);
        if (c.kind === 'count' && !(Number.isInteger(c.min) && c.min >= 1)) err(`${at}.check.min: an integer >= 1`);
        if ((c.kind === 'file' || c.kind === 'count') && typeof c.path === 'string' && (c.path.startsWith('/') || c.path.split('/').includes('..'))) err(`${at}.check.path: relative to the generated project`);
      });
    }
  }

  if ('metrics' in pb) {
    if (!Array.isArray(pb.metrics) || pb.metrics.length === 0) err('metrics: a non-empty list');
    else {
      const keys = new Set();
      pb.metrics.forEach((m, i) => {
        const at = `metrics[${i}]`;
        if (!isObj(m)) return err(`${at}: an object`);
        if (!METRIC_KEY.test(m.key ?? '')) err(`${at}.key: snake_case`);
        else if (keys.has(m.key)) err(`${at}.key: duplicate "${m.key}"`);
        else keys.add(m.key);
        if (!isStr(m.label)) err(`${at}.label: missing`);
        if (!UNITS.includes(m.unit)) err(`${at}.unit: one of ${UNITS.join(', ')}`);
        for (const k of Object.keys(m)) if (!['key', 'label', 'unit', 'source', 'target'].includes(k)) err(`${at}.${k}: unknown field`);
      });
    }
  }

  for (const { path, what } of scanLeaks(pb)) err(`${path}: looks like ${what}`);
  return { ok: errors.length === 0, errors };
}

/** Plans in waves: wave n holds the plans whose dependencies are all in earlier waves. */
export function playbookWaves(pb) {
  const left = new Map(pb.plans.map((p) => [p.id, new Set(p.after)]));
  const waves = [];
  while (left.size) {
    const wave = [...left].filter(([, deps]) => deps.size === 0).map(([id]) => id);
    if (!wave.length) throw new Error('playbook plans have a cycle');
    for (const id of wave) left.delete(id);
    for (const deps of left.values()) for (const id of wave) deps.delete(id);
    waves.push(wave);
  }
  return waves;
}

/** Template ids found in a plans/templates folder. */
export function templateIds(dir) {
  if (!existsSync(dir)) return new Set();
  return new Set(readdirSync(dir).filter((n) => n.endsWith('.json')).map((n) => n.slice(0, -5)));
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const file = process.argv[2];
  if (!file) { console.error('usage: node lib/playbooks.mjs <playbook.json> [--root <dir>]'); process.exit(2); }
  const i = process.argv.indexOf('--root');
  const root = i > 0 ? process.argv[i + 1] : dirname(resolve(file));
  const { ok, errors } = validatePlaybook(JSON.parse(readFileSync(file, 'utf8')), { root });
  if (ok) console.log(`ok: ${file}`);
  else { for (const e of errors) console.error(`- ${e}`); process.exit(1); }
}
