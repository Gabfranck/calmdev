// A fake `gh` for the tests (docs/connectors.md): an executable Node script given to the server as ESCADRILLE_GH.
// Each call appends its arguments (one JSON line) to calls.jsonl next to it, and answers plausibly:
//   pr create → the URL of PR 7 on stdout          pr list → [{ url, number }]
//   pr view   → { state, mergedAt, url, reviewDecision }
// The file mode.txt next to it (or FAKE_GH_MODE) changes the answers: 'exists' makes pr create fail as gh does
// when a PR is already open, 'unauth' answers as a gh signed out, 'merged' gives a merged PR to pr view.
// Phase 16 GH: pr list (open PRs), pr view (full), pr checks, run view --log-failed, api graphql (review threads) and
// pr merge; modes combine with commas: red, pending, conflict, changes-requested (setHead, setBranch, setComments).
import { writeFileSync, readFileSync, existsSync, mkdtempSync, realpathSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { createServer } from 'node:http';
import path from 'node:path';

export const PR_URL = 'https://github.com/acme/demo/pull/7';

export const fakeGh = () => {
  const dir = realpathSync(mkdtempSync(path.join(tmpdir(), 'escadrille-gh-')));
  const file = path.join(dir, 'gh');
  writeFileSync(file, `#!/usr/bin/env node
const fs = require('node:fs'); const path = require('node:path');
const dir = ${JSON.stringify(dir)}; const args = process.argv.slice(2);
fs.appendFileSync(path.join(dir, 'calls.jsonl'), JSON.stringify({ args, cwd: process.cwd() }) + '\\n');
const modeFile = path.join(dir, 'mode.txt');
const mode = process.env.FAKE_GH_MODE || (fs.existsSync(modeFile) ? fs.readFileSync(modeFile, 'utf8').trim() : '');
const url = ${JSON.stringify(PR_URL)};
if (mode === 'unauth') { process.stderr.write('You are not logged into any GitHub hosts. To log in, run: gh auth login\\n'); process.exit(4); }
const [a, b] = args;
if (a === 'pr' && b === 'create') {
  if (mode === 'exists') { const head = args[args.indexOf('--head') + 1]; process.stderr.write('a pull request for branch "' + head + '" into branch "main" already exists:\\n' + url + '\\n'); process.exit(1); }
  process.stdout.write('\\nCreating pull request for ' + args[args.indexOf('--head') + 1] + '\\n\\n' + url + '\\n'); process.exit(0);
}
if (a === 'pr' && b === 'list' && args.includes('--head')) { process.stdout.write(JSON.stringify([{ url, number: 7 }])); process.exit(0); }
if (a === 'pr' && b === 'view' && args[3] === '--json' && args[4] === 'state,mergedAt,url,reviewDecision') { process.stdout.write(JSON.stringify(mode === 'merged' ? { state: 'MERGED', mergedAt: '2026-11-01T10:00:00Z', url, reviewDecision: 'APPROVED' } : { state: 'OPEN', mergedAt: null, url, reviewDecision: 'REVIEW_REQUIRED' })); process.exit(0); }
const issueUrl = (n) => 'https://github.com/acme/demo/issues/' + n;
if (a === 'issue' && b === 'list') { const q = args.includes('--search') ? args[args.indexOf('--search') + 1] : ''; const all = [12, 13, 14].map((n) => ({ number: n, title: 'Issue ' + n + (n === 13 ? ' export' : ''), state: 'OPEN', url: issueUrl(n) })); process.stdout.write(JSON.stringify(q ? all.filter((i) => i.title.includes(q)) : all)); process.exit(0); }
if (a === 'issue' && b === 'view') {
  const n = Number(args[2]); if (![12, 13, 14].includes(n)) { process.stderr.write('GraphQL: Could not resolve to an issue with the number of ' + n + '.\\n'); process.exit(1); }
  process.stdout.write(JSON.stringify({ number: n, title: 'Issue ' + n, body: n === 14 ? 'x'.repeat(5000) : 'Corps de l’issue ' + n, state: 'OPEN', url: issueUrl(n),
    comments: [1, 2, 3, 4].map((k) => ({ author: { login: 'u' + k }, body: 'commentaire ' + k + ' ' + 'y'.repeat(k === 4 ? 900 : 0), createdAt: '2026-10-0' + k + 'T10:00:00Z' })) }));
  process.exit(0);
}
// Phase 16 GH: modes may be combined with commas (red, pending, conflict, changes-requested, merged); head.txt and
// branch.txt next to the script set the PR's head commit and branch; comments.json its unresolved threads
const modes = mode.split(',').map((m) => m.trim());
const file = (n, d) => (fs.existsSync(path.join(dir, n)) ? fs.readFileSync(path.join(dir, n), 'utf8').trim() : d);
const head = file('head.txt', 'abc1234def5678'); const branch = file('branch.txt', 'feature');
const red = modes.includes('red'), pending = modes.includes('pending'), cr = modes.includes('changes-requested');
const rollup = red ? [{ __typename: 'CheckRun', name: 'test', status: 'COMPLETED', conclusion: 'FAILURE' }, { __typename: 'CheckRun', name: 'lint', status: 'COMPLETED', conclusion: 'SUCCESS' }]
  : pending ? [{ __typename: 'CheckRun', name: 'test', status: 'IN_PROGRESS', conclusion: '' }] : [{ __typename: 'CheckRun', name: 'test', status: 'COMPLETED', conclusion: 'SUCCESS' }];
const pr = { number: 7, title: 'Demo', headRefName: branch, headRefOid: head, baseRefName: 'main', author: { login: 'gab' }, reviewDecision: cr ? 'CHANGES_REQUESTED' : 'REVIEW_REQUIRED', statusCheckRollup: rollup, mergeable: modes.includes('conflict') ? 'CONFLICTING' : 'MERGEABLE', url, state: modes.includes('merged') ? 'MERGED' : 'OPEN' };
const out = (v, code = 0) => { process.stdout.write(typeof v === 'string' ? v : JSON.stringify(v)); process.exit(code); };
if (a === 'pr' && b === 'list') out(modes.includes('merged') ? [] : [pr]);
if (a === 'pr' && b === 'view') { if (args[2] !== '7') { process.stderr.write('GraphQL: Could not resolve to a PullRequest with the number of ' + args[2] + '.\\n'); process.exit(1); } out(pr); }
if (a === 'pr' && b === 'checks') {
  const run = 'https://github.com/acme/demo/actions/runs/42/job/4242';
  if (red) out([{ name: 'test', state: 'FAILURE', bucket: 'fail', link: run, workflow: 'CI' }, { name: 'lint', state: 'SUCCESS', bucket: 'pass', link: run, workflow: 'CI' }], 1);
  if (pending) out([{ name: 'test', state: 'IN_PROGRESS', bucket: 'pending', link: run, workflow: 'CI' }], 8);
  out([{ name: 'test', state: 'SUCCESS', bucket: 'pass', link: run, workflow: 'CI' }]);
}
if (a === 'run' && b === 'view') {
  const lines = []; for (let i = 1; i <= 300; i++) lines.push('test\\tstep\\tline ' + i);
  lines.push('test\\tstep\\tGITHUB_TOKEN=ghp_abcdefghijklmnopqrstuvwxyz0123 password=hunter22 Authorization: Bearer abc.def.ghi', 'test\\tstep\\tError: expected 2, got 3');
  out(lines.join('\\n') + '\\n');
}
if (a === 'api' && b === 'graphql') {
  const threads = file('comments.json', '') ? JSON.parse(file('comments.json', ''))
    : cr ? [{ id: 'PRRT_1', isResolved: false, isOutdated: false, path: 'lib/a.mjs', line: 12, comments: { nodes: [{ author: { login: 'alice' }, body: 'Renomme cette variable.', url: url + '#r1', createdAt: '2026-11-02T20:00:00Z' }] } },
      { id: 'PRRT_2', isResolved: true, isOutdated: false, path: 'lib/b.mjs', line: 3, comments: { nodes: [{ author: { login: 'alice' }, body: 'Déjà fait.', url: url + '#r2', createdAt: '2026-11-02T20:01:00Z' }] } }] : [];
  out({ data: { repository: { pullRequest: { reviewThreads: { nodes: threads }, reviews: { nodes: cr ? [{ id: 'PRR_9', author: { login: 'alice' }, body: 'Deux points à reprendre.', url: url + '#rv', submittedAt: '2026-11-02T20:02:00Z' }] : [] } } } } });
}
if (a === 'pr' && b === 'merge') { process.stdout.write('✓ Merged pull request #7\\n'); process.exit(0); }
process.stderr.write('fake gh: unknown command ' + args.join(' ') + '\\n'); process.exit(2);
`, { mode: 0o755 });
  const calls = () => (existsSync(path.join(dir, 'calls.jsonl')) ? readFileSync(path.join(dir, 'calls.jsonl'), 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l)) : []);
  const setMode = (m) => writeFileSync(path.join(dir, 'mode.txt'), m || '');
  const put = (name) => (v) => writeFileSync(path.join(dir, name), typeof v === 'string' ? v : JSON.stringify(v));
  return { dir, file, calls, setMode, setHead: put('head.txt'), setBranch: put('branch.txt'), setComments: put('comments.json') };
};

// A fake Linear: a node:http server on 127.0.0.1 answering the GraphQL the connector sends (viewer, issues, issue,
// workflowStates, issueUpdate, commentCreate) and keeping every request ({ auth, query, variables }) and every
// comment (comments[identifier] = [{ id, body }]). Each state has Linear's type (backlog, unstarted, started,
// completed) and its position. Team AGO has « À revoir », team OPS only « In Review », team RAW neither, and no
// started state at all. The good key is 'lin_api_GOOD'. issueState[identifier] = a state id presets a ticket.
export const LINEAR_KEY = 'lin_api_GOOD';
const TYPES = { Todo: 'unstarted', Backlog: 'backlog', 'In Progress': 'started', 'À revoir': 'started', 'In Review': 'started', Done: 'completed' };
const TEAMS = {
  t1: { key: 'AGO', states: ['Todo', 'In Progress', 'À revoir', 'Done'] },
  t2: { key: 'OPS', states: ['Todo', 'In Review', 'Done'] },
  t3: { key: 'RAW', states: ['Backlog', 'Done'] },
};
const ISSUES = { 'ORC-88': 't1', 'ORC-91': 't1', 'ORC-5': 't1', 'ORC-7': 't1', 'OPS-3': 't2', 'RAW-1': 't3' };
const SEARCHED = ['ORC-88', 'ORC-91', 'OPS-3', 'RAW-1']; // the first four of the search (TIX), whatever LIN adds to ISSUES
export const fakeLinear = async () => {
  const requests = []; const issueState = {}; const comments = {};
  const stateId = (t, name) => `${t}-${TEAMS[t].states.indexOf(name)}`;
  const stateOf = (t, id) => { const name = TEAMS[t].states[Number(id.split('-')[1])]; return { id, name, type: TYPES[name] }; };
  const server = createServer((req, res) => {
    let s = ''; req.on('data', (c) => { s += c; });
    req.on('end', () => {
      const { query = '', variables = {} } = JSON.parse(s || '{}'); requests.push({ auth: req.headers.authorization, query, variables });
      const send = (code, body) => { res.writeHead(code, { 'content-type': 'application/json' }); res.end(JSON.stringify(body)); };
      if (req.headers.authorization !== LINEAR_KEY) return send(401, { errors: [{ message: 'Authentication required, not authenticated', extensions: { type: 'authentication error' } }] });
      if (/viewer\s*\{\s*id/.test(query)) return send(200, { data: { viewer: { id: 'u1', name: 'Dev', email: 'dev@example.com' } } });
      if (/assignedIssues/.test(query)) return send(200, { data: { viewer: { assignedIssues: { nodes: Object.keys(ISSUES).map((k) => ({ identifier: k, title: 'Ticket ' + k })) } } } });
      if (/issues\(first: \$n/.test(query)) {
        const term = String(variables.f?.title?.containsIgnoreCase || '').toLowerCase();
        const all = Array.from({ length: 60 }, (_, i) => (i < 4 ? SEARCHED[i] : 'AGO-' + (100 + i))).map((k) => ({ identifier: k, title: 'Ticket ' + k, url: 'https://linear.app/acme/issue/' + k, state: { name: 'Todo' } }));
        return send(200, { data: { issues: { nodes: all.filter((n) => n.title.toLowerCase().includes(term)).slice(0, variables.n) } } });
      }
      if (/issues\(/.test(query)) return send(200, { data: { issues: { nodes: [{ identifier: 'ORC-88', title: 'Ticket ORC-88' }] } } });
      if (/issue\(id/.test(query)) {
        const t = ISSUES[variables.id]; if (!t) return send(200, { data: null, errors: [{ message: 'Entity not found: Issue' }] });
        const st = issueState[variables.id] || stateId(t, TEAMS[t].states[0]);
        return send(200, { data: { issue: { id: 'uuid-' + variables.id, identifier: variables.id, title: 'Ticket ' + variables.id, state: stateOf(t, st), team: { id: t, key: TEAMS[t].key },
          description: 'Description de ' + variables.id, url: 'https://linear.app/acme/issue/' + variables.id,
          comments: { nodes: [{ body: 'récent', createdAt: '2026-10-30T09:00:00Z', user: { name: 'Dev' } }, { body: 'ancien', createdAt: '2026-10-01T09:00:00Z', user: { name: 'Léa' } }] } } } });
      }
      if (/workflowStates/.test(query)) { const t = variables.t; return send(200, { data: { workflowStates: { nodes: (TEAMS[t]?.states || []).map((n, i) => ({ id: stateId(t, n), name: n, type: TYPES[n], position: i })) } } }); }
      if (/issueUpdate/.test(query)) { issueState[String(variables.id).replace(/^uuid-/, '')] = variables.s; return send(200, { data: { issueUpdate: { success: true } } }); }
      if (/commentCreate/.test(query)) { const id = 'c' + requests.length; const k = String(variables.id).replace(/^uuid-/, ''); (comments[k] ||= []).push({ id, body: variables.b }); return send(200, { data: { commentCreate: { success: true, comment: { id } } } }); }
      return send(400, { errors: [{ message: 'fake linear: unknown query' }] });
    });
  });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  // stateName(identifier): the name of a ticket's current state, as the fake holds it
  const stateName = (identifier) => { const t = ISSUES[identifier]; return stateOf(t, issueState[identifier] || stateId(t, TEAMS[t].states[0])).name; };
  return { url: `http://127.0.0.1:${server.address().port}/graphql`, requests, issueState, comments, stateName, stateId, close: () => server.close() };
};
