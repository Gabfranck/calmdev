// The words of public/plan.html, for the same things on the phone.
import { Pending, Plan, PlanSession, SessionState } from './api';
import { has, money, percent, t } from './i18n';

// A status or health the server invents is shown as it comes.
export const statusLabel = (status: string) => (has(`status.${status}`) ? t(`status.${status}`) : status);
export const healthLabel = (health: string) => (has(`health.${health}`) ? t(`health.${health}`) : health);

export const askLine = (sid: string, tool?: string) => t('ask.line', { sid, verb: has(`tool.${tool}`) ? t(`tool.${tool}`) : t('ask.use') });

export const stateFor = (state: SessionState[], s: PlanSession): SessionState =>
  state.find((x) => x.id === s.id) || { id: s.id, status: s.wave > 1 ? 'later' : 'todo', stops: [], health: 'ok', pending: [] };

export const launched = (x: SessionState) => !['todo', 'later'].includes(x.status);
export const inFlight = (state: SessionState[]) => state.filter((x) => x.status === 'running' || x.status === 'waiting').length;

const pct = (v?: number) => (Number.isFinite(v) ? percent(v as number) : '');
export const alertText = (sid: string, x: SessionState, p: Extract<Pending, { kind: 'alert' }>) => {
  if (p.what === 'context') return t('alert.context', { sid, pct: pct(p.pct ?? x.usage?.context) });
  if (p.what === 'budget') return Number.isFinite(x.usage?.cost) ? t('alert.budget', { sid, cost: money(x.usage!.cost as number), pct: pct(p.pct) }) : t('alert.budgetPct', { sid, pct: pct(p.pct) });
  return p.text || t('alert.attention', { sid });
};

// Whether a permission leaves localhost, and where to (the same reading as plan.html)
export const netOf = (p: Extract<Pending, { kind: 'permission' }>) => {
  const input = (p.input || {}) as { url?: string; command?: string };
  const text = `${p.text || ''} ${input.url || input.command || ''}`;
  if (p.tool === 'WebSearch') return t('net.search');
  const hosts = (text.match(/\b[a-z][\w+.-]*:\/\/[^\s'"`)]+/gi) || []).map((u) => { try { return new URL(u).hostname; } catch { return ''; } })
    .filter((h) => h && !/^(localhost|127\.|0\.0\.0\.0$|\[::1\]$)/.test(h));
  if (hosts.length) return [...new Set(hosts)].join(', ');
  if (/\bgit\s+(fetch|pull|push|clone|ls-remote)\b/.test(text)) return t('net.remote');
  if (/\b(npm\s+(i|install|publish|view)|npx|pnpm\s+(add|install)|yarn\s+add|pip3?\s+install|brew\s+install|ssh|scp|rsync)\b/.test(text)) return t('net.outside');
  return p.network ? t('net.outside') : '';
};
export const reasonOf = (p: Extract<Pending, { kind: 'permission' }>) => ((p.input || {}) as { description?: string }).description || '';

export const wavesOf = (plan: Plan) => {
  const waves = plan.waves && plan.waves.length ? plan.waves : [{ n: 1, title: t('plan.waveDefault') }];
  return waves.map((w, i) => {
    const n = w.n ?? i + 1;
    return { n, title: w.title || w.name || t('plan.wave', { n }), items: plan.sessions.filter((s) => (s.wave || 1) === n) };
  }).filter((w) => w.items.length);
};

// An escadrille:state block, in one line: "Stops 1, 2 · Look at …"
export const STATE_RE = /```escadrille:state\s*([\s\S]*?)```/g;
export const stateLine = (json: string) => {
  try {
    const s = JSON.parse(json);
    const list = (s.stops || []).map((i: number) => i + 1).join(', ');
    const stops = (s.stops || []).length ? t(s.stops.length > 1 ? 'state.stops' : 'state.stop', { list }) : t('state.none');
    return [stops, s.done ? t('state.done') : '', has(`health.${s.health}`) ? t(`health.${s.health}`) : '', s.claude || ''].filter(Boolean).join(' · ');
  } catch { return t('state.unreadable'); }
};
