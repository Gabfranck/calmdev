// The QA plan of a run (phase 10, session H; docs/qa.md). When every session of a plan is merged, however it was
// (the button, the merge if tests are green, the automatic merge), the server adds one short session to the plan,
// QA, that writes docs/qa/<plan>.md: the simplest plan of QA that is still exhaustive, modelled on docs/qa/phase-9.md
// (session Q of phase 9). This module writes that session from the plan alone: its sessions, their stops, their
// summaries, the journal and the merges; the server adds it once per plan, launches it, and the Review shows it first.
//
//   needsQa(plan, state)                 → true when the plan is merged whole and has no QA yet
//   qaFile(planId)                       → 'docs/qa/<plan>.md', relative to the project's root
//   qaBrief({ plan, state, log, merges, port }) → the prompt of the QA session (French, as every prompt)
//   qaSession({ plan, state, log, merges, root, port, model, budget }) → the session to append
//   withQa(plan, session, at)            → the plan with the session appended and plan.qa = { session, at }
import { isFinished } from './queue.mjs';
import { stopTitle } from './blocks.mjs';

export const QA_SESSION = 'QA';
export const QA_MODEL = 'claude-sonnet-5-5';
export const QA_BUDGET = 3;
export const qaFile = (planId) => `docs/qa/${planId}.md`;

// A plan of kits never merges, so it never gets here; a plan that already has its QA (plan.qa, or a session named QA
// written by hand or by the planner) gets nothing more
export const needsQa = (plan, state) => !!plan && !plan.qa && plan.delivery !== 'kit' && Array.isArray(plan.sessions)
  && !plan.sessions.some((s) => s.id === QA_SESSION) && isFinished(plan, state);

const cut = (s, n) => { const t = String(s ?? '').replace(/\s+/g, ' ').trim(); return t.length > n ? t.slice(0, n - 1) + '…' : t; };
const usd = (n) => (Number.isFinite(n) ? `${n.toFixed(2)} $` : '—');

// One block per session: its name, where it worked, its stops (crossed or not), its last summary, what it said at
// each stop (the distinct `claude` lines of the journal, the last five), its merge
const sessionBlock = (s, row, log, merges) => {
  const crossed = new Set(row?.stops || []);
  const stops = (s.stops || []).map((t, i) => `  - [${crossed.has(i) ? 'x' : ' '}] ${stopTitle(t)}`).join('\n') || '  - (aucun arrêt)';
  const said = [...new Set(log.filter((l) => l.session === s.id && l.claude).map((l) => cut(l.claude, 220)))].slice(-5);
  const merge = row?.worktree ? (row.worktree.merged ? `fusionnée (${row.worktree.branch})` : `pas fusionnée (${row.worktree.branch})`) : 'sans worktree';
  const commit = merges.find((m) => row?.worktree?.branch && m.includes(row.worktree.branch));
  return [
    `### ${s.id} · ${s.name}`,
    `- Modèle : ${s.model || '—'} · coût : ${usd(row?.usage?.cost)} · ${merge}${commit ? ` · ${commit.split(' ')[0]}` : ''}`,
    s.where ? `- Où : ${cut(s.where, 300)}` : '',
    '- Arrêts :', stops,
    row?.summary ? `- Résumé de fin :\n${String(row.summary).split('\n').map((l) => '  > ' + cut(l, 300)).join('\n')}` : '- Résumé de fin : (aucun)',
    said.length ? `- Ce qu'elle a dit aux arrêts :\n${said.map((l) => '  - ' + l).join('\n')}` : '',
  ].filter(Boolean).join('\n');
};

export const qaBrief = ({ plan, state = [], log = [], merges = [], port = 3078 }) => {
  const by = new Map(state.map((r) => [r.id, r]));
  const base = `http://localhost:${port}`;
  const file = qaFile(plan.id);
  const sessions = plan.sessions.filter((s) => s.id !== QA_SESSION);
  const blocks = sessions.map((s) => sessionBlock(s, by.get(s.id), log, merges)).join('\n\n');
  return `Tu es la session QA du plan « ${plan.title} » (${plan.id}), lancée seule par calmdev quand toutes ses sessions ont été fusionnées. Résultat attendu : ${file}, un plan de QA unique, le plus simple mais exhaustif, que le développeur déroule sans réfléchir à ce qu'il doit tester, et qui couvre tout ce que le plan a changé, une seule fois chacun. Tu as peu de budget : lis, écris le fichier, commite, c'est tout.

À lire avant d'écrire, dans cet ordre et sans plus : le CLAUDE.md du projet s'il existe, les sessions ci-dessous (arrêts, résumés, fusions), puis le diff de chaque fusion (\`git log --merges --oneline --since=${plan.created || '1 day ago'}\`, puis \`git show --stat <commit>\` ; ouvre un fichier seulement quand le diff ne dit pas ce qui se voit). Le modèle de forme, s'il existe dans le dépôt : docs/qa/phase-9.md.

Périmètre : tu n'écris que ${file}. Aucun autre fichier, aucun code, aucun test lancé hors du bac à sable, aucun réseau.

Le fichier :
1. Un titre « # La QA de ${plan.title} », une ligne qui dit sur quoi on le lit (la branche principale fusionnée, le serveur lancé), puis la durée totale estimée.
2. En tête, « ## Les cinq qui comptent » : les cinq vérifications qui disent si le plan a marché (moins s'il a changé moins de cinq choses), les plus risquées d'abord.
3. Puis une section par écran touché, dans l'ordre de la navigation de l'app (ou des commandes, pour ce qui ne se voit pas dans une page), avec sa durée.
4. Chaque ligne : \`- [ ] [<chemin>](${base}<chemin>) — <geste> → <ce qui doit se voir> · <session d'origine>\`. Une case par comportement, pas par commit ; pas de doublon ; un comportement que tu ne peux pas vérifier dans une page se vérifie par une commande écrite en entier.
5. Chaque section finit par une ligne \`[Signaler un défaut](${base}/signaler.html?ecran=<écran encodé>)\`.
6. Ce qu'une session dit n'avoir pas pu vérifier (bac à sable, navigateur, git) devient une case, sans exception.

Le plan, ses sessions et ce qu'elles ont dit :

${blocks}

${merges.length ? `Les fusions vues dans git :\n${merges.map((m) => '- ' + m).join('\n')}` : 'Aucune fusion trouvée par le message : cherche-les dans git log.'}

Arrêt : le chemin du fichier, le nombre de cases, la durée estimée, en trois lignes au plus ; commite le fichier, puis done.`;
};

export const qaSession = ({ plan, state, log, merges, root, port, model = QA_MODEL, budget = QA_BUDGET }) => {
  const others = plan.sessions.filter((s) => s.id !== QA_SESSION);
  const wave = Math.max(1, ...others.map((s) => s.wave || 1)) + 1;
  return {
    id: QA_SESSION, name: 'Le plan de QA du run', wave, after: others.map((s) => s.id), path: root, model, budget,
    where: qaFile(plan.id), when: 'Quand toutes les sessions sont fusionnées.',
    stops: [`Le plan de QA écrit dans ${qaFile(plan.id)}`],
    prompt: qaBrief({ plan, state, log, merges, port }),
  };
};

// ---------------------------------------------------------------- FIAB 6: the QA grouped by project (Dev, 6 Nov. 22:55)
// One QA per project, never one per plan: it is ready when a merge came after the last QA and no plan of the project
// still runs; it covers every merge since the previous one, in one checklist docs/qa/<project>-<date>.md. It never starts
// alone: « À toi » shows it with « Commencer la QA » (lib/nextstep.mjs, kind 'projectQa'). The QA of a plan not launched
// yet is abandoned (Dev, 6 Nov. 22:05).
//   needsProjectQa({ plans, lastQaAt }) → bool    plans: [{ id, mergedAt, running }]
//   projectQaPlans({ plans, lastQaAt }) → the plans it covers (merged since lastQaAt)
//   projectQaFile(name, date) · projectQaBrief({ name, date, plans: [{ plan, state, log, merges }], since, port })
//   pendingPlanQa(plans, stateOf) → [{ plan, session }] the per-plan QA sessions never launched
const after = (a, b) => !!a && (!b || Date.parse(a) > Date.parse(b));
// Only a session that works holds the grouped QA back (7 November): a session `waiting` for the developer may wait for
// days (ARC, MOTS on the 6th), and the QA would never be ready; what it merges later goes into the next QA
export const blocksQa = (status) => status === 'running' || status === 'starting';
export const projectQaPlans = ({ plans = [], lastQaAt = null } = {}) => plans.filter((p) => after(p.mergedAt, lastQaAt));
export const needsProjectQa = ({ plans = [], lastQaAt = null } = {}) => !plans.some((p) => p.running) && projectQaPlans({ plans, lastQaAt }).length > 0;
const slug = (s) => String(s || 'projet').toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, '').replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '') || 'projet';
export const projectQaFile = (name, date) => `docs/qa/${slug(name)}-${String(date).slice(0, 10)}.md`;
export const projectQaBrief = ({ name, date, plans = [], since = null, port = 3078 }) => {
  const file = projectQaFile(name, date); const base = `http://localhost:${port}`;
  const parts = plans.map(({ plan, state = [], log = [], merges = [] }) => {
    const by = new Map(state.map((r) => [r.id, r]));
    const blocks = plan.sessions.filter((s) => s.id !== QA_SESSION).map((s) => sessionBlock(s, by.get(s.id), log, merges)).join('\n\n');
    return `## Plan « ${plan.title} » (${plan.id})\n\n${blocks}${merges.length ? `\n\nFusions vues dans git :\n${merges.map((m) => '- ' + m).join('\n')}` : ''}`;
  }).join('\n\n');
  return `Tu es la session QA du projet « ${name} », lancée par le développeur depuis « À toi ». Résultat attendu : ${file}, une seule liste à cocher qui couvre toutes les fusions ${since ? `depuis la QA précédente (${since.slice(0, 16).replace('T', ' ')})` : 'faites jusqu’ici'}, ${plans.length} plan${plans.length > 1 ? 's' : ''} : chaque comportement changé une seule fois, même s'il vient de deux plans. Tu as peu de budget : lis, écris le fichier, commite, c'est tout.

À lire, dans cet ordre et sans plus : le CLAUDE.md du projet s'il existe, les plans ci-dessous, puis \`git show --stat <commit>\` de chaque fusion (un fichier seulement quand le diff ne dit pas ce qui se voit). Modèle de forme s'il existe : docs/qa/phase-9.md.

Périmètre : tu n'écris que ${file}. Aucun autre fichier, aucun code, aucun réseau.

Le fichier : « # La QA de ${name} du ${String(date).slice(0, 10)} », la ligne de lecture (main fusionnée, serveur lancé) et la durée ; « ## Les cinq qui comptent » (les plus risquées d'abord) ; puis une section par écran touché, dans l'ordre de la navigation. Chaque ligne : \`- [ ] [<chemin>](${base}<chemin>) — <geste> → <ce qui doit se voir> · <plan/session>\`. Chaque section finit par \`[Signaler un défaut](${base}/signaler.html?ecran=<écran encodé>)\`. Ce qu'une session dit n'avoir pas pu vérifier devient une case.

${parts || 'Aucun plan : cherche les fusions dans git log.'}

Arrêt : le chemin du fichier, le nombre de cases, la durée estimée, en trois lignes au plus ; commite le fichier, puis done.`;
};
export const pendingPlanQa = (plans = [], stateOf = () => []) => plans.filter((p) => p?.qa && !p.qa.abandoned).flatMap((p) => {
  const sid = p.qa.session || QA_SESSION; const row = stateOf(p.id).find((r) => r.id === sid);
  return !row || ['todo', 'later', undefined, null].includes(row.status) ? [{ plan: p.id, session: sid }] : [];
});
export const abandonPlanQa = (plan, at = new Date().toISOString()) => ({ ...plan, sessions: plan.sessions.filter((s) => s.id !== (plan.qa?.session || QA_SESSION)), qa: { ...plan.qa, abandoned: at } });

export const withQa = (plan, session, at = new Date().toISOString()) => ({
  ...plan, sessions: [...plan.sessions, session], qa: { session: session.id, at },
  waves: [...(Array.isArray(plan.waves) ? plan.waves.filter((w) => w.n !== session.wave) : []), { n: session.wave, title: 'La QA du run', text: '' }],
});
