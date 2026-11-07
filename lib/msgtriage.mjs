// Phase 13 PIL, the triage of the developer's messages (docs/pilot.md, « Le tri des messages »). Every message Dev
// writes to the pilot first goes through Haiku, without the pilot's context: the message, the plans in progress and
// the last ten memory lines. Haiku returns a closed block: {"route":"pilot"} when the message needs the pilot's context
// (a decision on a plan, a trade-off, what to do next, an answer to the pilot's question), or
// {"route":"delegate","model":"haiku|sonnet|opus","project":…,"question":…} when it stands alone (a question on the code
// or the data of a project, an explanation, a search, a check). A request for an action always goes to the pilot; in
// doubt, the pilot. The code keeps the last word: looksLikeAction forces the pilot whatever Haiku said.
// The conversation never blocks (Dev, 2026-11-02): a delegated question leaves at once; a pilot-routed message while
// the pilot is busy gets a line now (busyLine) and rides the head of the next wake.
export const ROUTE_MODEL = 'claude-haiku-5-5';
export const ROUTE_BUDGET = 0.05;
export const DELEGATE_BUDGET = 0.5; // dollars for a delegated question (setting pilotDelegateUsd)
export const MODELS = { haiku: 'claude-haiku-5-5', sonnet: 'claude-sonnet-5-5', opus: 'claude-opus-5-5' };
export const NAMES = { 'claude-haiku-5-5': 'Haiku 5.5', 'claude-sonnet-5-5': 'Sonnet 5.5', 'claude-opus-5-5': 'Opus 5.5', 'claude-fable-5-1': 'Fable 5.1' };

// An order, a request for work or a reply to the pilot: the pilot, without a model
const ACTION = /^\s*(ok|oui|non|yes|go|vas-y|parfait|d'accord|let's go)\b|\b(tu peux|peux-tu|il faut|il faudra|je te laisse|laisse|pense|penses|garde|gardes|répondre|autoris\w*|prends|prendre|n[’']oublie)\b|\b(fais|fait|faites|ajoute|ajouter|crée|créer|lance|lancer|corrige|corriger|mets|mettre|planifie|planifier|prépare|préparer|change|changer|retire|retirer|supprime|enlève|déploie|pousse|push|commit|fusionne|merge|relance|arrête|stop|continue|reprends|note|garde|propose|écris|rédige|génère|installe|configure|active|désactive|passe|remets|réponds|répond|valide|accepte|refuse|annule|priorise|replanifie|teste|vérifie que tu|cramme|crame|avance)\b/i;
const PILOT_WORDS = /\b(plan|plans|session|sessions|escadrille|arrêt|arrêts|vague|budget|fusion|merge|revue|review|pilote|où en est|où en es|où en sommes|eta|avancement|quelle phase|prochaine étape|suite|que proposes|tu proposes|ton avis|décide|décision|arbitr|prioris|as-tu prévu|est-ce prévu|peux-tu me garantir|tu peux y aller|autoris|interdiction|règle)\b/i;
export const looksLikeAction = (text) => ACTION.test(String(text || ''));
export const looksLikePilot = (text) => looksLikeAction(text) || PILOT_WORDS.test(String(text || '')) || !/\?/.test(String(text || ''));

export const routeSystemPrompt = () => `Tu es l'aiguilleur des messages du développeur dans calmdev. Tu n'utilises aucun outil.
Un seul bloc fermé, rien d'autre :
\`\`\`escadrille:route
{"route":"pilot"}
\`\`\`
ou
\`\`\`escadrille:route
{"route":"delegate","model":"haiku|sonnet|opus","project":"<chemin du projet>","question":"<la question, reformulée seule>"}
\`\`\`
pilot : le message demande le contexte du pilote (une décision sur un plan, un arbitrage, la suite à donner, une réponse à une question du pilote, toute demande d'action : « fais », « ajoute », « lance »).
delegate : le message se suffit à lui-même : une question sur le code ou les données d'un projet, une explication, une recherche, une vérification en lecture seule. haiku pour une lecture simple, sonnet pour une question de code, opus pour une analyse.
Dans le doute : pilot.`;

const cut = (s, n) => { const t = String(s ?? '').replace(/\s+/g, ' ').trim(); return t.length > n ? t.slice(0, n - 1) + '…' : t; };
export const routePrompt = ({ project, text, plans = [], memory = [] }) => [
  `Projet : ${project}`, '', 'Message du développeur :', `<message>${cut(text, 1500)}</message>`, '',
  'Plans en cours :', ...(plans.length ? plans.slice(0, 8).map((p) => `- ${p.id} « ${cut(p.title, 60)} » : ${(p.sessions || []).map((s) => `${s.id} ${s.status}`).join(', ')}`) : ['- aucun']), '',
  ...(memory.length ? ['Mémoire (10 dernières lignes) :', ...memory.slice(-10).map((l) => '  ' + cut(l, 160))] : []),
].join('\n');

// The block, validated and bounded; project must be the project of the conversation (the server passes it)
export const validateRoute = (value, { project } = {}) => {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return { route: 'pilot', why: 'bloc illisible' };
  if (value.route === 'pilot') return { route: 'pilot', why: 'tri' };
  if (value.route !== 'delegate') return { route: 'pilot', why: 'route inconnue' };
  const model = MODELS[String(value.model || 'haiku').toLowerCase()] || MODELS.haiku;
  const question = cut(value.question || '', 2000); if (!question) return { route: 'pilot', why: 'question vide' };
  const p = String(value.project || project || '').trim();
  if (project && p && p !== project) return { route: 'pilot', why: 'projet différent' };
  return { route: 'delegate', model, project: project || p, question, why: 'tri' };
};
export const parseRoute = (text, opts) => {
  const m = /```escadrille:route\s*\n([\s\S]*?)```/.exec(String(text || '')) || /(\{[\s\S]*\})/.exec(String(text || ''));
  if (!m) return { route: 'pilot', why: 'aucun bloc' };
  try { return validateRoute(JSON.parse(m[1]), opts); } catch { return { route: 'pilot', why: 'JSON illisible' }; }
};
// The final route: the code's guard over Haiku's decision
export const routeOf = ({ text, decision }) => (looksLikeAction(text) ? { route: 'pilot', why: 'demande d’action' } : decision && decision.route === 'delegate' ? decision : { route: 'pilot', why: decision?.why || 'tri' });

export const delegateSystemPrompt = ({ project }) => `Tu réponds à une question du développeur sur le projet ${project}, en lecture seule, en français, en dix lignes au plus. Tu ne proposes aucun plan, tu ne lances rien, tu ne modifies rien. Si la question demande une décision ou une action, dis en une ligne qu'elle revient au pilote.`;
export const signature = (model) => `— ${NAMES[model] || model}, en lecture seule`;
// The one line the pilot reads at its next wake
export const noteLine = ({ question, answer, model }) => `Question déléguée (${NAMES[model] || model}) : ${cut(question, 200)} → ${cut(answer.split(/(?<=[.!?])\s/)[0] || answer, 240)}`;
// What Dev reads at once when the pilot is busy
export const busyLine = ({ doing = 'un tour', since = null } = {}) => `Le pilote est occupé (${doing}${since ? ', depuis ' + since : ''}) ; ton message part avec ceux qui attendent, en un seul réveil à la fin de ce tour.`;

// The tally: { messages, delegated, delegatedCost, pilotCost } → the share delegated and what it cost against the pilot's average wake
export const tallyMessage = (stats = {}, { delegated = false, cost = 0 } = {}) => { const s = { messages: 0, delegated: 0, delegatedCost: 0, ...stats }; s.messages++; if (delegated) { s.delegated++; s.delegatedCost = Math.round((s.delegatedCost + (Number(cost) || 0)) * 10000) / 10000; } return s; };
export const delegatedShare = (s = {}) => (s.messages ? Math.round((s.delegated || 0) / s.messages * 100) : null);
