// The tickets a plan starts from (phase 16 TIX, docs/connectors.md « Partir des tickets »): Linear issues by the
// project's key, GitHub issues by the gh of this Mac, read only. Nothing here changes a state or writes a comment.
//
//   listTickets({ source, project, key, q })      → [{ id, title, state, url, source }], 50 at most
//   ticketsBlock(tickets)                         → the « ## Les tickets » section the planner reads
//   ideaFromTickets({ project, ids, idea, key })  → { idea, ids }: the first message of the planning, the tickets in it
//
// A GitHub issue is GH-<n>; any other identifier is a Linear one (^[A-Z][A-Z0-9]+-\d+$).
import * as linear from './linear.mjs';
import * as github from './github.mjs';

export const MAX_LIST = 50;
export const MAX_TICKETS = 8;
export const MAX_CHARS = 2000; // per ticket, its title line and its comments included
export const MAX_COMMENTS = 3;
export const COMMENT_CHARS = 300;
export const GH_ID = /^GH-(\d+)$/;
export const ID = /^[A-Z][A-Z0-9]+-\d+$/;
// The one line that asks the planner to carry the tickets on its sessions
export const CONSIGNE = 'Mets dans `tickets` de chaque session les identifiants qu’elle traite ; lecture seule : ne change ni statut ni commentaire.';

// The sentence and the gesture, when a source cannot be read
const NO_KEY = 'Linear : aucune clé pour ce projet ; colle ta clé personnelle dans Réglages du projet, ligne Linear.';
const linearKey = (key) => { if (!key) throw new Error(NO_KEY); return key; };

const oneLine = (s) => String(s ?? '').replace(/\s+/g, ' ').trim();
const cut = (s, n) => (s.length <= n ? s : s.slice(0, Math.max(0, n - 1)).trimEnd() + '…');

export const listTickets = async ({ source, project, key, q = '' }) => {
  if (source === 'linear') return (await linear.searchIssues({ key: linearKey(key), q, first: MAX_LIST })).slice(0, MAX_LIST).map((i) => ({ id: i.identifier, title: i.title, state: i.state, url: i.url, source: 'linear' }));
  if (source === 'github') return (await github.issueList({ cwd: project, q, limit: MAX_LIST })).slice(0, MAX_LIST).map((i) => ({ id: `GH-${i.number}`, title: i.title, state: i.state, url: i.url, source: 'github' }));
  throw new Error('source : linear ou github');
};

const fetchTicket = async ({ id, project, key }) => {
  const gh = GH_ID.exec(id);
  if (gh) { const v = await github.issueView({ cwd: project, number: Number(gh[1]) }); return { id, title: v.title, state: v.state, url: v.url, description: v.body, comments: v.comments.slice(-MAX_COMMENTS) }; }
  const v = await linear.issueDetail({ key: linearKey(key), identifier: id, comments: MAX_COMMENTS });
  return { id: v.identifier, title: v.title, state: v.state, url: v.url, description: v.description, comments: v.comments };
};

// One ticket in MAX_CHARS at most: the title line and the URL whole, the last comments cut to COMMENT_CHARS, the
// description gets what is left (the comments say where the ticket is now, the description where it started)
export const ticketText = (t) => {
  const head = `### ${t.id} · ${oneLine(t.title)}${t.state ? ` (${oneLine(t.state)})` : ''}${t.url ? `\n${t.url}` : ''}`;
  const comments = (t.comments || []).slice(-MAX_COMMENTS).map((c) => `- ${oneLine(c.author)}${c.at ? `, ${String(c.at).slice(0, 10)}` : ''} : ${cut(oneLine(c.body), COMMENT_CHARS)}`);
  const tail = comments.length ? `\nDerniers commentaires :\n${comments.join('\n')}` : '';
  const desc = String(t.description || '').replace(/\r/g, '').replace(/\n{3,}/g, '\n\n').trim();
  const room = MAX_CHARS - head.length - tail.length - 1;
  const body = desc && room > 40 ? `\n${cut(desc, room)}` : '';
  return cut(head + body + tail, MAX_CHARS);
};

export const ticketsBlock = (tickets) => `## Les tickets\n\n${CONSIGNE}\n\n${tickets.map(ticketText).join('\n\n')}`;

// ids checked, deduplicated, MAX_TICKETS at most; each ticket read; the developer's idea first, the block after
export const ideaFromTickets = async ({ project, ids, idea = '', key, fetchOne = fetchTicket }) => {
  if (!Array.isArray(ids) || !ids.length) throw new Error('ids : au moins un ticket, comme ORC-88 ou GH-12');
  const list = [...new Set(ids.map((x) => String(x ?? '').trim().toUpperCase()))];
  const bad = list.filter((x) => !ID.test(x)); if (bad.length) throw new Error(`ticket ${bad[0] || '(vide)'} mal formé : un identifiant comme ORC-88 ou GH-12`);
  if (list.length > MAX_TICKETS) throw new Error(`${MAX_TICKETS} tickets au plus par planification (${list.length} choisis)`);
  const tickets = [];
  for (const id of list) tickets.push(await fetchOne({ id, project, key }));
  const first = oneLine(idea) ? String(idea).trim() : `Planifie le travail des tickets ${list.join(', ')}.`;
  return { idea: `${first}\n\n${ticketsBlock(tickets)}`, ids: list };
};
