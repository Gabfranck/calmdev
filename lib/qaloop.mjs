// Phase 13 PIL, the QA loop (docs/flot.md, « La boucle de QA »; docs/qarun.md). When the server plays a QA: line and
// some journeys fail, the failures go back once to the session that wrote them, so that it fixes the badly written
// journeys; a journey is sent back once, then stops. When only true defects remain, the board and defauts.md go to
// « À toi » with a « Voir la planche » button. Pure: the server keeps the ids already sent back per session.
import path from 'node:path';

export const DEFECTS_FILE = 'defauts.md';

const failed = (results = []) => results.filter((r) => r && r.ok !== true);
// results: lib/qarun.mjs results; sent: the ids already sent back to the session → { toFix, defects, sent }
export const splitFailures = (results = [], sent = []) => {
  const was = new Set(sent); const toFix = []; const defects = [];
  for (const r of failed(results)) (was.has(r.id) ? defects : toFix).push(r);
  return { toFix, defects, sent: [...new Set([...sent, ...toFix.map((r) => r.id)])] };
};

const cut = (s, n) => { const t = String(s ?? '').replace(/\s+/g, ' ').trim(); return t.length > n ? t.slice(0, n - 1) + '…' : t; };
const line = (r) => `- ${r.id}${r.titre ? ' « ' + cut(r.titre, 60) + ' »' : ''} : ${cut(r.echec || r.erreur || 'échec', 200)}`;

// The message that leads the session's next turn: fix the journeys, once
export const fixMessage = (file, toFix, defects = []) => [
  `QA ${file} : ${toFix.length} parcours en échec, renvoyés une fois pour que tu corriges ceux qui sont mal écrits (cible invisible, ordre des étapes, mot de passe en clair, compte inconnu). Un parcours corrigé se rejoue par une nouvelle ligne QA: ; un parcours juste qui échoue est un vrai défaut : laisse-le et dis-le.`,
  ...toFix.map(line),
  ...(defects.length ? ['', `Déjà renvoyés une fois, tenus pour de vrais défauts : ${defects.map((r) => r.id).join(', ')}.`] : []),
].join('\n');

// defauts.md: one section per true defect, with its captures
export const defectsMarkdown = ({ file, defects = [], dir = '' }) => {
  const L = [`# Défauts réels · ${path.basename(String(file))}`, '', `${defects.length} parcours rejoué${defects.length > 1 ? 's' : ''} après correction et toujours en échec. Planche : ${path.join(dir, 'planche.html')}`, ''];
  for (const r of defects) {
    L.push(`## ${r.id}${r.titre ? ' · ' + r.titre : ''}`, '');
    if (r.ticket || r.sprint) L.push(`- ticket : ${r.ticket || '—'} · sprint : ${r.sprint || '—'}`);
    if (r.attendu) L.push(`- attendu : ${r.attendu}`);
    L.push(`- échec : ${r.echec || r.erreur || 'échec'}`);
    if (Array.isArray(r.console) && r.console.length) L.push(`- console : ${r.console.slice(0, 3).map((c) => cut(c.text || c, 160)).join(' · ')}`);
    if (Array.isArray(r.captures) && r.captures.length) L.push(`- captures : ${r.captures.join(', ')}`);
    L.push('');
  }
  return L.join('\n');
};

// The « À toi » entry: kind 'qa', the board and the defects file as links the page builds (never a text of the session)
export const qaPending = ({ id, file, defects = [], dir, at = new Date().toISOString() }) => ({
  id, kind: 'qa', text: `QA ${path.basename(String(file))} : ${defects.length} vrai${defects.length > 1 ? 's' : ''} défaut${defects.length > 1 ? 's' : ''} à regarder`,
  board: path.join(dir, 'planche.html'), defects: path.join(dir, DEFECTS_FILE), ids: defects.map((r) => r.id), at,
});
