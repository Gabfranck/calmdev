// What the click robot must never click (phase 10, session F). Two layers, because a label alone is not enough:
//  - the label (English and French, whatever the language of the page): anything that launches, merges, answers, stops,
//    sends, deletes, notifies or opens a window or a folder;
//  - the element itself: a submit button, a data-* attribute or an id that only exists on an acting button, a switch,
//    a link that leaves the app. This one holds when a label is renamed or translated.
// Every non-GET request is aborted by the robot anyway; this list is the first wall, that block the second. Tested in
// test/click-robot.test.mjs against every button of public/ in both languages.

// A letter before the word is not a boundary in French ("Relancer" must not hide behind "lancer"), so no \b.
const START = '(?<![\\p{L}])';
const label = (words) => new RegExp(`${START}(?:${words.join('|')})`, 'iu');

export const DENY_LABEL = label([
  'launch', 'lancer', 'lancée', 'lancé',
  'merge', 'fusionn',
  'stop(?!s)', 'arrêt(?!s)', 'arrêter', 'tout arrêter', 'pause',
  'send', 'envoy',
  'allow', 'autoris', 'always', 'toujours',
  'refus', 'deny', 'reject', 'rejet',
  'accept', 'approv', 'approuv', 'validate', 'valider',
  'retry', 'réessay', 'relanc', 'resume', 'reprendre',
  'rewrite', 'réécri', 'tell(?![\\p{L}])', 'raconter', 'harden', 'durcir', 'raise(?![\\p{L}])', 'relever',
  'continue', 'continuer', 'seen, ', 'vu, ',
  'save', 'enregistr', 'replace', 'remplacer', 'erase', 'effacer', 'delete', 'supprim', 'remove', 'retirer', 'retire', 'rouvrir', 'reopen',
  'forget', 'oublier', 'new code', 'nouveau code', 'confirm',
  'add(?![\\p{L}])', 'ajouter', 'activate', 'activer',
  'notify', 'prévenir', 'remind', 'dictat', 'dicter',
  'finish the review', 'terminer la revue', 'until the limit', 'jusqu.à la limite',
  'open the project', 'open the pr', 'open in a terminal', 'open folder', 'open the folder', 'ouvrir le projet', 'ouvrir le dossier',
  'ouvrir la pr', 'ouvrir dans un terminal', 'terminal', 'dev server', 'start', 'démarrer',
  'run the tests', 'run tests', 'les tests', 'install', 'pair', 'appair', 'disconnect', 'déconnecter', 'reset', 'réinitialiser',
  'pull request', 'pr(?![\\p{L}])', 'copy', 'copier',
]);

// An element that only exists to act. data-* names (any value) and ids found on buttons of public/.
export const DENY_DATA = [
  'data-allow', 'data-accept', 'data-answer', 'data-act', 'data-open', 'data-run-tests', 'data-continue-budget', 'data-dismiss',
  'data-pr', 'data-reviewed', 'data-net-remove', 'data-install-all', 'data-stop', 'data-stop-all', 'data-forget', 'data-new',
  'data-linear', 'data-decide', 'data-resolve', 'data-del', 'data-yes', 'data-burst-create', 'data-import', 'data-tpl',
  'data-mic', 'data-copy', 'data-copycmd', 'data-note', 'data-skill', 'data-why', 'data-launch',
  'data-go', 'data-retire', 'data-retire-plan', 'data-reopen', 'data-reopen-plan', // « Retirer le plan » (public/retire.js)
  'data-ask-answer', 'data-ask-deny', // « À toi » (public/asks.js): Autoriser, Refuser, Toujours autoriser ce type, Refuser avec ce motif
];
export const DENY_IDS = [
  'send', 'answerAll', 'notify', 'story', 'launchAll', 'burstSend', 'burstToggle', 'burstStop', 'plRetry', 'save', 'finish',
  'mic', 'mcPilot', 'plPilot', 'burstAutoOn', 'addBtn', 'resumeAll',
];

// A link that leaves the app, opens a window, or calls the API directly.
export const isOutsideLink = (href, target, base = '') => {
  if (target && target !== '_self') return true;
  if (!href) return false;
  if (/^(mailto|tel|javascript|data|blob|file):/i.test(href)) return true;
  if (/^[a-z][a-z0-9+.-]*:\/\//i.test(href) || href.startsWith('//')) return !base || !href.startsWith(base);
  return /^\/?api\//.test(href) || href.includes('/api/');
};

// el: { label, tag, attrs: { name: value }, href, target, type, role } as read from the page (or parsed from the source).
// Returns the reason (a short string) when the element must not be clicked, else null.
export const denyReason = (el, { base = '' } = {}) => {
  const attrs = el.attrs || {};
  if (attrs.disabled !== undefined) return 'disabled';
  if ((el.tag === 'button' || el.type) && (el.type || attrs.type) === 'submit') return 'submit';
  if ((el.role || attrs.role) === 'switch') return 'switch';
  for (const d of DENY_DATA) if (attrs[d] !== undefined) return d;
  if (attrs.id && DENY_IDS.includes(attrs.id)) return `#${attrs.id}`;
  if (el.tag === 'a' || el.href !== undefined) if (isOutsideLink(el.href ?? attrs.href, el.target ?? attrs.target, base)) return 'link';
  const text = [el.label, attrs['aria-label']].filter(Boolean).join(' ');
  const m = DENY_LABEL.exec(text);
  return m ? `label « ${m[0]} »` : null;
};
export const isDenied = (el, opts) => denyReason(el, opts) !== null;
