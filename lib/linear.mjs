// The Linear connector (docs/connectors.md): Linear's GraphQL API (https://api.linear.app/graphql, or
// ESCADRILLE_LINEAR_URL for the tests), native fetch, the project's personal key in the Authorization header.
// Called on the developer's click only; the key is never logged, never part of an error.
//
//   viewer(key)                                       → { id, name, email }        tests a key
//   listIssues({ key, project })                      → [{ identifier, title }]
//   issueByIdentifier({ key, identifier })            → { id, identifier, title, state, stateType, team: { id, key } }
//   searchIssues({ key, q, first })                  → [{ identifier, title, state, url }]  open ones, or title holds q; 50 at most
//   issueDetail({ key, identifier, comments })       → { identifier, title, description, state, url, comments: [{ author, body, at }] }
//   moveToState({ key, identifier, stateName })       → { identifier, state }      the state found by name in the issue's team
//   moveToStarted({ key, identifier })                → { identifier, state, moved } the team's first « started » state, from
//                                                        backlog or unstarted only; never a completed state (lib/linearsync.mjs)
//   comment({ key, identifier, body })                → { ok, id }
import { vars } from './names.mjs';
export const DEFAULT_STATE = 'À revoir';
const FALLBACK_STATE = 'In Review';
export const IDENTIFIER = /^[A-Z][A-Z0-9]+-\d+$/;
// The types Linear gives its workflow states: a ticket moves to « started » only from these two (docs/connectors.md)
export const FROM_TYPES = ['backlog', 'unstarted'];
export const NEVER_TYPES = ['completed', 'canceled'];

const urlOf = () => vars.LINEAR_URL || 'https://api.linear.app/graphql';

const gql = async (key, query, variables = {}) => {
  if (!key) throw new Error('Linear : aucune clé pour ce projet (Réglages du projet)');
  let r;
  try { r = await fetch(urlOf(), { method: 'POST', headers: { 'content-type': 'application/json', authorization: key }, body: JSON.stringify({ query, variables }), signal: AbortSignal.timeout(20000) }); } catch (e) { throw new Error('Linear injoignable : ' + (e.cause?.code || e.message)); }
  const body = await r.json().catch(() => null);
  if (r.status === 401 || body?.errors?.some((x) => /auth/i.test(x.extensions?.type || x.message || ''))) throw new Error('Linear : clé refusée');
  if (!r.ok || body?.errors?.length) throw new Error('Linear : ' + (body?.errors?.[0]?.message || `HTTP ${r.status}`));
  return body.data;
};

const checkId = (identifier) => { const id = String(identifier || '').trim(); if (!IDENTIFIER.test(id)) throw new Error(`ticket ${id || '(vide)'} : un identifiant comme ORC-88`); return id; };
const norm = (s) => String(s).normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase().trim();

export const viewer = async (key) => (await gql(key, 'query { viewer { id name email } }')).viewer;

export const listIssues = async ({ key, project }) => {
  const d = project
    ? await gql(key, 'query($p: String!) { issues(first: 100, filter: { project: { name: { eq: $p } } }) { nodes { identifier title } } }', { p: String(project) })
    : await gql(key, 'query { viewer { assignedIssues(first: 100) { nodes { identifier title } } } }');
  return (project ? d.issues : d.viewer.assignedIssues).nodes.map((n) => ({ identifier: n.identifier, title: n.title }));
};

export const issueByIdentifier = async ({ key, identifier }) => {
  const id = checkId(identifier);
  const d = await gql(key, 'query($id: String!) { issue(id: $id) { id identifier title state { id name type } team { id key } } }', { id });
  if (!d?.issue) throw new Error(`Linear : ticket ${id} introuvable`);
  return { id: d.issue.id, identifier: d.issue.identifier, title: d.issue.title, state: d.issue.state?.name ?? null, stateType: d.issue.state?.type ?? null, team: d.issue.team };
};

// The workflow states of a team: [{ id, name, type, position }], in Linear's order
export const teamStates = async ({ key, teamId }) => {
  const d = await gql(key, 'query($t: ID!) { workflowStates(first: 100, filter: { team: { id: { eq: $t } } }) { nodes { id name type position } } }', { t: teamId });
  return [...d.workflowStates.nodes].sort((a, b) => (a.position ?? 0) - (b.position ?? 0));
};

// The state update itself, refused towards a completed or canceled state: Done is the developer's word, never Escadrille's
const setState = async ({ key, issue, found }) => {
  if (NEVER_TYPES.includes(found.type)) throw new Error(`Linear : ${issue.identifier} ne passe jamais en « ${found.name} » par calmdev`);
  const u = await gql(key, 'mutation($id: String!, $s: String!) { issueUpdate(id: $id, input: { stateId: $s }) { success } }', { id: issue.id, s: found.id });
  if (!u.issueUpdate?.success) throw new Error(`Linear : ${issue.identifier} n’a pas changé de statut`);
  return { identifier: issue.identifier, state: found.name };
};

// The tickets a plan may start from (phase 16 TIX, read only): the workspace's open issues, or those whose title holds q
export const searchIssues = async ({ key, q = '', first = 50 }) => {
  const term = String(q || '').trim();
  const filter = term ? { title: { containsIgnoreCase: term } } : { state: { type: { nin: ['completed', 'canceled'] } } };
  const d = await gql(key, 'query($f: IssueFilter, $n: Int) { issues(first: $n, filter: $f, orderBy: updatedAt) { nodes { identifier title url state { name } } } }', { f: filter, n: Math.min(50, Math.max(1, Number(first) || 50)) });
  return d.issues.nodes.map((n) => ({ identifier: n.identifier, title: n.title, state: n.state?.name ?? null, url: n.url ?? null }));
};

// One ticket with what a planner reads: its description and its last comments (oldest first)
export const issueDetail = async ({ key, identifier, comments = 3 }) => {
  const id = checkId(identifier);
  const d = await gql(key, 'query($id: String!, $c: Int) { issue(id: $id) { identifier title description url state { name } comments(first: $c, orderBy: createdAt) { nodes { body createdAt user { name } } } } }', { id, c: comments });
  if (!d?.issue) throw new Error(`Linear : ticket ${id} introuvable`);
  const i = d.issue;
  const list = (i.comments?.nodes || []).map((c) => ({ author: c.user?.name || '?', body: c.body || '', at: c.createdAt || '' })).sort((a, b) => String(a.at).localeCompare(String(b.at)));
  return { identifier: i.identifier, title: i.title, description: i.description || '', state: i.state?.name ?? null, url: i.url ?? null, comments: list.slice(-comments) };
};

export const moveToState = async ({ key, identifier, stateName }) => {
  const issue = await issueByIdentifier({ key, identifier });
  const states = await teamStates({ key, teamId: issue.team.id });
  const wanted = [stateName, DEFAULT_STATE, FALLBACK_STATE].filter(Boolean);
  let found = null; for (const w of wanted) { found = states.find((s) => norm(s.name) === norm(w)); if (found) break; }
  if (!found) throw new Error(`Linear : aucun statut « ${wanted[0]} » dans l’équipe ${issue.team.key} ; statuts : ${states.map((s) => s.name).join(', ')}`);
  return setState({ key, issue, found });
};

// A session starts on the ticket: from backlog or unstarted, to the team's first « started » state (In Progress in most teams);
// a ticket already started, done or canceled keeps its state (moved: false)
export const moveToStarted = async ({ key, identifier }) => {
  const issue = await issueByIdentifier({ key, identifier });
  if (!FROM_TYPES.includes(issue.stateType)) return { identifier: issue.identifier, state: issue.state, moved: false };
  const states = await teamStates({ key, teamId: issue.team.id });
  const found = states.find((s) => s.type === 'started');
  if (!found) throw new Error(`Linear : aucun statut de type started dans l’équipe ${issue.team.key} ; statuts : ${states.map((s) => s.name).join(', ')}`);
  return { ...(await setState({ key, issue, found })), moved: true };
};

export const comment = async ({ key, identifier, body }) => {
  const issue = await issueByIdentifier({ key, identifier });
  const d = await gql(key, 'mutation($id: String!, $b: String!) { commentCreate(input: { issueId: $id, body: $b }) { success comment { id } } }', { id: issue.id, b: String(body || '') });
  if (!d.commentCreate?.success) throw new Error(`Linear : commentaire refusé sur ${issue.identifier}`);
  return { ok: true, id: d.commentCreate.comment?.id ?? null };
};
