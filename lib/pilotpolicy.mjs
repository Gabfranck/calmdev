// Phase 13 PIL, the permission policy of a project (docs/pilot.md, « La politique de permission »). What the pilot's
// private script did from a terminal on 2026-11-01 and 02: answer the sessions' permission requests with a fixed
// policy, local yes; network, push, writes outside the worktree and windows never. Off by default, per project
// (project_settings.pilotPolicy: true). It builds on the local rule of lib/policy.mjs (suggest) and never widens it:
// a request the rule cannot read waits for a human, and the four refusals hold even if a rule said yes.
//   decidePolicy({ on, suggest, ask })  → { answer: 'allow' | 'deny' | 'wait', reason, rule }
//   refusalLine(d)                      → the one line told to the session when refused
//   logText(ask, d)                     → the text of the pilot's journal row (lib/pilotlog.mjs)
export const NEVER = Object.freeze(['git-push', 'real-host', 'write-outside', 'open-window', 'sandbox-off', 'deny-settings']);
const PUSH = /\bgit\s+push\b|\bgh\s+(pr\s+create|release\s+create|repo\s+create)\b|\bnpm\s+publish\b|\bexpo\s+publish\b|\beas\s+(build|submit|update)\b/;

export const policyOn = (settings) => settings?.pilotPolicy === true;

export const decidePolicy = ({ on = false, suggest = null, ask = {} } = {}) => {
  if (!on) return { answer: 'wait', reason: 'politique éteinte', rule: null };
  const cmd = String(ask.input?.command || ask.text || '');
  // The four things never accepted, whatever the rule said (defence in depth over lib/policy.mjs)
  if (ask.network) return { answer: 'deny', reason: 'accès réseau : jamais par la politique, demande au développeur', rule: 'network' };
  if (PUSH.test(cmd)) return { answer: 'deny', reason: 'push ou publication : jamais par la politique', rule: 'git-push' };
  if (ask.input?.dangerouslyDisableSandbox === true) return { answer: 'deny', reason: 'hors bac à sable : jamais par la politique', rule: 'sandbox-off' };
  if (!suggest || suggest.allow === null || suggest.allow === undefined) return { answer: 'wait', reason: 'la règle locale ne sait pas : à une personne', rule: null };
  if (suggest.allow === false) return { answer: 'deny', reason: suggest.reason || 'refusé par la règle locale', rule: suggest.rule || null };
  if (NEVER.includes(suggest.rule)) return { answer: 'deny', reason: suggest.reason || 'refusé', rule: suggest.rule };
  return { answer: 'allow', reason: suggest.reason || 'local', rule: suggest.rule || null };
};

export const refusalLine = (d) => `Refusé par la politique du projet : ${d.reason}.`;
export const logText = (ask, d) => `${d.answer === 'allow' ? 'Autorisé' : 'Refusé'} par la politique : ${String(ask.tool || 'outil')}\n${String(ask.text || ask.input?.command || '').slice(0, 300)}\n${d.reason}`;
