// The pilot never dies in silence (Dev, 6 November 21:10: a wake on his message sent its request, stopped with no answer at
// 0 $, two watchdog restarts did nothing, and « À toi » stayed empty).
//   exitLine({ project, code, signal, stderr, answered, cost }) → the line for server.log: the exit code, the signal, the last
//                                     error output (three lines), whether the turn answered
//   createRestartGuard({ max })      → { restarted(project) → { n, cut }, answered(project), reset(project), count(project) }:
//                                     past `max` restarts without an answer between them, the next restart cuts the pilot instead
//   unanswered({ pending, stall, cut }) → the developer's messages to show in « À toi »: those still pending once the watchdog
//                                     handed the pilot's requests over (stall) or the pilot was cut; [] otherwise
export const MAX_RESTARTS = 2;

const last = (s, n = 3) => String(s || '').trim().split('\n').map((l) => l.trim()).filter(Boolean).slice(-n).join(' / ').slice(0, 600);
export const exitLine = ({ project = '', code = null, signal = null, stderr = '', answered = false, cost = 0 } = {}) =>
  `pilot ${project}: exit code ${code ?? 'none'}${signal ? `, signal ${signal}` : ''}, ${answered ? 'answered' : 'no answer'}, ${Number(cost || 0).toFixed(4)} $${last(stderr) ? `, stderr: ${last(stderr)}` : ', stderr empty'}`;

export const createRestartGuard = ({ max = MAX_RESTARTS } = {}) => {
  const n = new Map();
  return {
    restarted: (project) => { const k = (n.get(project) || 0) + 1; if (k > max) { n.set(project, 0); return { n: k, cut: true }; } n.set(project, k); return { n: k, cut: false }; },
    answered: (project) => { n.delete(project); },
    reset: (project) => { n.delete(project); },
    count: (project) => n.get(project) || 0,
  };
};

export const unanswered = ({ pending = [], stall = null, cut = false } = {}) => (stall || cut ? pending.map((m) => ({ seq: m.seq, text: m.text, at: m.at })) : []);
