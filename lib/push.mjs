// The notifications pushed to the phone through Expo's push service (docs/phone.md, « Le push »):
// which devices get one, what it says, and the one POST to the service. No retry, no queue: a push
// that fails is written to the console by the caller and forgotten.
import { noticeAllowed, inQuietHours } from './autonomy.mjs';
export const PUSH_URL = 'https://exp.host/--/api/v2/push/send';
export const QUIET_MS = 15000; // a device seen in the last 15 s has the app open: it refreshes itself

// The devices to notify: not revoked, not expired, with a push token, not seen in the last QUIET_MS
export const recipients = (devices, { now = Date.now(), quietMs = QUIET_MS, tokenDays = 90 } = {}) => devices.filter((d) => {
  if (d.revoked || !d.expo_push_token) return false;
  const created = Date.parse(d.created); if (Number.isFinite(created) && now - created > tokenDays * 864e5) return false;
  const seen = Date.parse(d.last_seen); return !Number.isFinite(seen) || now - seen > quietMs;
});

const cut = (s, n = 80) => { s = String(s ?? '').replace(/\s+/g, ' ').trim(); return s.length > n ? s.slice(0, n - 1) + '…' : s; };
const oneLine = (input) => { if (input && typeof input === 'object') { const v = input.command ?? input.file_path ?? input.url ?? input.pattern ?? Object.values(input)[0]; return typeof v === 'string' ? v : JSON.stringify(input); } return String(input ?? ''); };
// What the notification says, by kind: « A attend ta réponse », « A demande : Bash curl … », « A : 83 % du plafond »,
// « A : plafond atteint », « A : <why> », « Plan fini : <titre> »
export const noticeText = (kind, { session, tool, input, pct, why, title, cap, text } = {}) => {
  if (kind === 'waiting') return `${session} attend ta réponse`;
  if (kind === 'permission') return cut(`${session} demande : ${tool || ''} ${oneLine(input)}`);
  if (kind === 'budget') return cap ? `${session} : plafond atteint` : `${session} : ${Math.round((pct || 0) * 100)} % du plafond`;
  if (kind === 'error') return cut(`${session} : ${why || 'erreur'}`);
  if (kind === 'done') return `Plan fini : ${title}`;
  if (kind === 'burst-start' || kind === 'burst-end') return cut(text, 120); // the burst (docs/burst.md)
  if (kind === 'review') return `${session} : à relire`;
  if (kind === 'ask-budget') return `${session} : continuer au-delà du seuil ?`;
  throw new Error('unknown kind ' + kind);
};

// The title of a notification: the project's short name first (« Orchard · B attend ta réponse »), the text alone without a project
export const titleFor = (projectName, text) => (projectName ? `${projectName} · ${text}` : String(text));

// One message per device, the body Expo expects
export const messagesFor = (devices, { title, body, plan, session, kind, id }) =>
  devices.map((d) => ({ to: d.expo_push_token, title, body, sound: 'default', data: { plan, session: session ?? null, kind, id } }));

// POST the messages; rends Expo's tickets ([{ status: 'ok', id } | { status: 'error', message, details }]) in the order sent
export const pushMessages = async (url, messages) => {
  const r = await fetch(url, { method: 'POST', headers: { 'content-type': 'application/json', accept: 'application/json' }, body: JSON.stringify(messages) });
  if (!r.ok) throw new Error(`HTTP ${r.status}`);
  const j = await r.json();
  return Array.isArray(j?.data) ? j.data : [];
};
// The tokens Expo reports as DeviceNotRegistered, matched to the messages by position
export const unregistered = (messages, tickets) => messages.filter((m, i) => tickets[i]?.status === 'error' && tickets[i]?.details?.error === 'DeviceNotRegistered').map((m) => m.to);

// The project's autonomy (docs/autonomy.md): 'none' sends nothing, 'waiting' only what waits for a human, 'all' everything;
// nothing leaves during the quiet hours, and what was held back is not sent afterwards
export const shouldPush = ({ level = 'waiting', quietHours = null, kind, now = new Date() }) => noticeAllowed(level, kind) && !inQuietHours(quietHours, now);
