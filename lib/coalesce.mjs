// Messages and wakes in bursts (phase 14 RAF, docs/frugal.md « Les rafales »). Every model call reads the whole context
// again: three messages written during one turn cost three turns when they leave one by one, one turn when they leave
// together. The same goes for the pilot's wakes: stops, ends and alerts a minute apart are one wake, not three.
//   joinMessages(texts)                       one user turn from the messages written during a turn
//   createInbox({ send, busy, interrupt })    holds a session's messages while its turn runs, sends them together after;
//                                             sendNow cuts the turn and the whole batch leaves at once
//   replayMessages(messages, turns)           the paper replay: turns one by one against turns grouped
//   replayWakes(events, { windowMs, maxMs })  the paper replay of the pilot's wakes, debounce against the window
export const EVENT_WINDOW_MS = 150000; // events less than 2 min 30 apart: one wake (Dev, 2 November: « 2 à 3 minutes »)
export const EVENT_MAX_MS = 600000; // a stream of events never holds a wake more than 10 min after its first one
export const DEBOUNCE_MS = 1500; // the waker's debounce before phase 14, what every wake waited

// One turn from several messages: a single message stays as it is (nothing changes for the common case)
export const joinMessages = (texts) => {
  const t = (texts || []).map((x) => String(x ?? '').trim()).filter(Boolean);
  if (t.length <= 1) return t[0] || '';
  return `${t.length} messages arrivés pendant ton tour, envoyés ensemble : réponds à tous dans ce tour.\n\n`
    + t.map((x, i) => `### Message ${i + 1}\n${x}`).join('\n\n');
};

// A session's mailbox. send(text): to the process now if it is idle, else held. turnEnded(): what was held leaves in one
// turn. sendNow(text?): the developer does not want to wait, the turn is cut (interrupt) and the batch leaves when the cut
// turn ends; without interrupt the batch simply leaves at the end of the turn.
export const createInbox = ({ send, busy, interrupt = null }) => {
  let held = []; let cut = false;
  const flush = () => { if (!held.length) return 0; const n = held.length; const text = joinMessages(held); held = []; cut = false; send(text); return n; };
  return {
    send(text) { if (busy()) { held.push(String(text)); return { held: held.length }; } held.push(String(text)); flush(); return { held: 0 }; },
    sendNow(text) {
      if (text) held.push(String(text));
      if (!busy()) return { sent: flush(), cut: false };
      if (interrupt && !cut) { cut = true; interrupt(); }
      return { sent: 0, cut, held: held.length };
    },
    turnEnded() { return flush(); },
    held: () => [...held],
  };
};

// ---------------------------------------------------------------- the paper replays (scripts/measure-rafale.mjs)
const ms = (t) => (typeof t === 'number' ? t : Date.parse(t));

// messages: [{ at }] the times the developer wrote them; turns: [{ start, end }] the model's turns (start: its prompt, end:
// its last answer). A message written while a turn ran was queued: one by one it costs a turn each; grouped, every message
// written during the same turn rides one turn. Returns { messages, queued, groups: [k, …] (k ≥ 2 only), turnsBefore,
// turnsAfter, saved }.
export const replayMessages = (messages, turns) => {
  const T = turns.map((t) => ({ start: ms(t.start), end: ms(t.end) })).filter((t) => t.end > t.start).sort((a, b) => a.start - b.start);
  const during = new Map(); let queued = 0;
  for (const m of messages) {
    const at = ms(m.at); const i = T.findIndex((t) => t.start < at && at < t.end);
    if (i < 0) continue; queued++; during.set(i, (during.get(i) || 0) + 1);
  }
  const groups = [...during.values()].filter((k) => k >= 2);
  const saved = groups.reduce((s, k) => s + k - 1, 0);
  return { messages: messages.length, queued, groups, turnsBefore: messages.length, turnsAfter: messages.length - saved, saved };
};

// events: [{ at, urgent }] what would wake the pilot. Before: a wake per event, unless another came within the debounce.
// After: an urgent event (a message of Dev) wakes at once and carries what waits; the others wait for windowMs of quiet,
// never more than maxMs after the first of the group. Returns { events, before, after, avoided, waits: [ms held] }.
export const replayWakes = (events, { windowMs = EVENT_WINDOW_MS, maxMs = EVENT_MAX_MS, debounceMs = DEBOUNCE_MS } = {}) => {
  const E = events.map((e) => ({ at: ms(e.at), urgent: !!e.urgent })).filter((e) => Number.isFinite(e.at)).sort((a, b) => a.at - b.at);
  const groupCount = (win, max, urgentCuts) => {
    let n = 0; let first = null; let last = null; const waits = [];
    const close = (at) => { if (first === null) return; n++; waits.push(at - first); first = null; last = null; };
    for (const e of E) {
      if (first !== null) { const due = Math.min(last + win, first + max); if (e.at > due) close(due); }
      if (urgentCuts && e.urgent) { if (first === null) first = e.at; close(e.at); continue; }
      if (first === null) first = e.at; last = e.at;
    }
    if (first !== null) close(Math.min(last + win, first + max));
    return { n, waits };
  };
  const before = groupCount(debounceMs, Infinity, false).n;
  const after = groupCount(windowMs, maxMs, true);
  return { events: E.length, before, after: after.n, avoided: before - after.n, waits: after.waits };
};
