// GET /api/pilot/brief?project= : the state of a project in a few lines for the pilot (docs/sessions.md, « Résumé du pilote »).
// One line per live session (a process runs, not merged), then « À toi : n ». Pure: the server hands over the data it already
// computes for /api/projectflow (nodes) and /api/asks (asks, kept, count); nothing is read here, nothing heavy is added.
export const STOP_MAX = 120;

const clip = (s, n = STOP_MAX) => { const t = String(s || '').replace(/\s+/g, ' ').trim(); return t.length > n ? t.slice(0, n - 1) + '…' : t; };

// The last stop in one sentence: the first sentence of what was done (« Fait : … »), else what the session does now
export const stopLine = (node) => {
  let s = String(node?.summary || '').split('\n').map((l) => l.trim()).find(Boolean) || String(node?.now || '');
  s = s.replace(/^(fait|done)\s*:\s*/i, '');
  const m = /^(.+?[.!?])(\s|$)/.exec(s); // a first sentence short enough wins over the whole line
  return clip(m && m[1].length >= 12 ? m[1] : s);
};

const usd = (n) => (Math.round((Number(n) || 0) * 100) / 100).toString();

// nodes: flow nodes; alive(plan, session) → true while a process runs; permissions: [{ plan, session, tool?, line? }] pending
// (the developer's and the ones kept for the pilot); count: the developer's « À toi » number
export const briefOf = ({ nodes = [], alive = () => false, permissions = [], count = 0 } = {}) => {
  const sessions = [];
  for (const n of nodes || []) {
    if (!n || n.status === 'merged' || !alive(n.plan, n.session)) continue;
    const perm = (permissions || []).find((p) => p.plan === n.plan && p.session === n.session) || null;
    const permission = perm ? clip(perm.line || perm.tool || 'autorisation', 80) : null;
    const stop = stopLine(n);
    const line = `${n.plan}/${n.session} · ${n.status} · ${stop || '—'}${permission ? ` · autorisation : ${permission}` : ''} · ${usd(n.cost)}/${usd(n.budget)} $`;
    sessions.push({ plan: n.plan, session: n.session, id: n.id || `${n.plan}/${n.session}`, status: n.status, stop, permission, cost: Number(n.cost) || 0, budget: Number(n.budget) || 0, line });
  }
  const n = Number.isFinite(count) ? count : 0;
  const todo = `À toi : ${n}`;
  return { sessions, count: n, text: [...sessions.map((s) => s.line), todo].join('\n') + '\n' };
};

// The pending permissions of the rows of asksNow: those for the developer (asks) and those kept for the pilot (kept)
export const permissionsOf = (listed = {}) => [
  ...(listed.asks || []).map((a) => ({ plan: a.plan, session: a.session, tool: a.tool, line: a.explain?.line })),
  ...(listed.kept || []).filter((k) => k.kind === 'permission').map((k) => ({ plan: k.plan, session: k.session })),
];
