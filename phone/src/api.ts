// The Escadrille server's API, as the phone uses it (contract in phone/README.md).
// Every request carries `Authorization: Bearer <token>`; a 401 anywhere sends the app back to pairing.
import { t } from './i18n';

export type Pending =
  | { id: string; kind: 'permission'; tool?: string; input?: unknown; text: string; network?: boolean; at?: string }
  | { id: string; kind: 'reply'; stop?: number; text: string; summary?: string | null; at?: string }
  | { id: string; kind: 'alert'; what?: 'budget' | 'context'; pct?: number; text: string; at?: string }
  | { id: string; kind: 'info'; text: string; at?: string };

export type SessionState = {
  id: string; status: string; stops: number[]; health: string; why?: string; claude?: string;
  summary?: string | null; pending?: Pending[]; usage?: { cost?: number; context?: number } | null;
};
export type PlanSession = { id: string; name: string; wave: number; stops?: string[]; after?: string[]; model?: string };
export type Plan = { id: string; title: string; goal?: string; waves?: { n?: number; name?: string; title?: string }[]; sessions: PlanSession[] };
export type LogRow = { at: string; session: string; status: string; health?: string; claude?: string; why?: string; stops?: number[] };
export type PlanView = { plan: Plan; state: SessionState[]; log: LogRow[] };
export type Message = { seq: number; role: 'claude' | 'dev' | 'activity' | 'ask' | 'system'; text: string; data?: unknown; at: string };
export type PhoneInfo = { device: { id: string; name: string }; plans: { id: string; title: string; created: string; project?: string | null }[]; now: string };

// The progression (docs/game.md); { off: true } when the project switched it off
export type Game = { off?: boolean; xp: number; level: number; rank: string; next: { rank: string; xp: number } | null; week: { quests: { done: number; of: number }[] } };
export class Unauthorized extends Error {}

export const makeApi = (base: string, token: string | null, onUnauthorized: () => void) => {
  const call = async <T,>(path: string, body?: unknown): Promise<T> => {
    const headers: Record<string, string> = { Accept: 'application/json' };
    if (token) headers.Authorization = `Bearer ${token}`;
    if (body !== undefined) headers['Content-Type'] = 'application/json';
    const res = await fetch(base.replace(/\/+$/, '') + path, { method: body === undefined ? 'GET' : 'POST', headers, body: body === undefined ? undefined : JSON.stringify(body) });
    if (res.status === 401) { onUnauthorized(); throw new Unauthorized('401'); }
    const data = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error((data && data.error) || `HTTP ${res.status}`);
    return data as T;
  };
  const s = (plan: string, sid: string) => `/api/plan/${encodeURIComponent(plan)}/session/${encodeURIComponent(sid)}`;
  return {
    phone: (project?: string | null) => call<PhoneInfo>('/api/phone' + (project ? `?project=${encodeURIComponent(project)}` : '')),
    plan: (id: string) => call<PlanView>(`/api/plan/${encodeURIComponent(id)}`),
    messages: (plan: string, sid: string) => call<{ messages: Message[] }>(`${s(plan, sid)}/messages`),
    answer: (plan: string, sid: string, b: { id: string; allow: boolean; always?: boolean; message?: string }) => call<{ ok: boolean }>(`${s(plan, sid)}/answer`, b),
    message: (plan: string, sid: string, text: string) => call<{ ok: boolean }>(`${s(plan, sid)}/message`, { text }),
    dismiss: (plan: string, sid: string, id: string) => call<{ ok: boolean }>(`${s(plan, sid)}/dismiss`, { id }),
    pushToken: (expoPushToken: string) => call<{ ok: boolean }>('/api/phone/push-token', { expoPushToken }),
    game: (project?: string | null) => call<Game>('/api/game' + (project ? `?project=${encodeURIComponent(project)}` : '')),
    forget: () => call<{ ok: boolean }>('/api/phone/forget', {}),
  };
};
export type Api = ReturnType<typeof makeApi>;

// Pairing is the one call without a token.
export const pair = async (base: string, code: string, name: string) => {
  let res: Response;
  try {
    res = await fetch(base.replace(/\/+$/, '') + '/api/pair', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ code, name }) });
  } catch {
    throw new Error(t('pair.noAnswer'));
  }
  const data = await res.json().catch(() => ({}));
  if (res.status === 401) throw new Error(data.error || t('pair.refused'));
  if (!res.ok || !data.token) throw new Error(data.error || t('pair.status', { status: res.status }));
  return data as { token: string; device: { id: string; name: string; created: string } };
};
