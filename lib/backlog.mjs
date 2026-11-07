// The backlog page (docs/backlog-page.md): docs/backlog.md read as a document of sections and lines, edited line by
// line so that a read then a write gives back the file byte for byte; and the « Ajouter à un plan » gesture.
//   parseDoc(text)                        { sections: [{ line, level, text, link }], items: [{ line, end, md, text, done, section, link, attached }] }
//   toggle(text, line, md) / add(text, t) / move(text, line, dir) / attach(text, line, md, { plan, session }) → new text
//   tickAttached(text, plan, session)     → new text, every open line attached to that session checked
//   nearestPlans(item, plans)             [{ id, title, score, why }] best first
//   sessionFor(plan, rows, item, { retired }) → { session, next }: the session to add in the wave after those running
// Every edit names the line by its number and its current text: if the file moved under the page, the edit is refused
// (409) and the page reloads, never writes over a line it did not see.
const BULLET = /^([-*])\s+(.*)$/;
const HEADING = /^(#{2,3})\s+(.*)$/;
const LINK = /`(plans\/retired\/[^`]+\.json)`/;
const ATTACHED = / · session `([^`]+)` du plan `([^`]+)`/;
const clean = (s) => String(s).replace(/\*\*/g, '').replace(/\s+/g, ' ').trim();
const conflict = (m) => Object.assign(new Error(m), { code: 409 });
const bad = (m) => Object.assign(new Error(m), { code: 400 });

export const parseDoc = (text) => {
  const lines = String(text ?? '').split('\n');
  const sections = []; const items = [];
  let section = -1; let link = null; let h2Link = null;
  for (let i = 0; i < lines.length; i++) {
    const l = lines[i];
    const h = HEADING.exec(l);
    if (h) {
      const lk = LINK.exec(h[2]); const t = clean(h[2].replace(/\s*·\s*`plans\/retired\/[^`]+`\s*$/, ''));
      sections.push({ line: i, level: h[1].length, text: t, link: lk ? lk[1] : null }); section = sections.length - 1;
      if (h[1].length === 2) { h2Link = lk ? lk[1] : null; link = h2Link; } else link = lk ? lk[1] : h2Link;
      continue;
    }
    const b = BULLET.exec(l); if (!b) continue;
    let end = i + 1; while (end < lines.length && /^\s+\S/.test(lines[end])) end++; // a wrapped or nested line stays with its bullet
    let t = [b[2], ...lines.slice(i + 1, end).map((x) => x.trim())].join(' '); let done = false;
    const box = /^\[([ xX])\]\s*(.*)$/.exec(t); if (box) { done = box[1] !== ' '; t = box[2]; }
    if (/^~~.*~~\s*$/.test(t)) { done = true; t = t.replace(/^~~|~~\s*$/g, ''); }
    const a = ATTACHED.exec(t);
    items.push({ line: i, end, md: l, text: clean(t.replace(ATTACHED, '')), done, section, link, attached: a ? { session: a[1], plan: a[2] } : null });
    i = end - 1;
  }
  return { sections, items };
};

const itemAt = (text, line, md) => {
  const doc = parseDoc(text); const it = doc.items.find((x) => x.line === Number(line));
  if (!it || (md != null && it.md !== md)) throw conflict('le backlog a changé : recharge la page');
  return { doc, it, lines: String(text).split('\n') };
};

export const toggle = (text, line, md) => {
  const { it, lines } = itemAt(text, line, md);
  const l = lines[it.line];
  lines[it.line] = /^([-*]\s+)\[([ xX])\]/.test(l) ? l.replace(/^([-*]\s+)\[([ xX])\]/, (_, p, c) => `${p}[${c === ' ' ? 'x' : ' '}]`) : l.replace(/^([-*]\s+)/, '$1[x] ');
  return lines.join('\n');
};

// A new line goes at the end of the first list (the top of the backlog, before the first « ## »), else at the end
export const add = (text, t) => {
  const v = clean(t ?? ''); if (!v) throw bad('texte vide');
  const lines = String(text ?? '').split('\n'); const doc = parseDoc(text);
  const firstH2 = doc.sections.find((s) => s.level === 2)?.line ?? Infinity;
  const top = doc.items.filter((x) => x.line < firstH2);
  if (top.length) { lines.splice(top[top.length - 1].end, 0, `- [ ] ${v}`); return lines.join('\n'); }
  const body = lines.join('\n'); const sep = body === '' || body.endsWith('\n') ? '' : '\n';
  return `${body}${sep}- [ ] ${v}\n`;
};

// Up or down within its section: swapped with the neighbour line of the same section, never across a heading
export const move = (text, line, dir, md) => {
  const { doc, it, lines } = itemAt(text, line, md);
  const same = doc.items.filter((x) => x.section === it.section);
  const k = same.indexOf(it); const o = same[dir === 'up' ? k - 1 : k + 1];
  if (!o) return text;
  const [a, b] = dir === 'up' ? [o, it] : [it, o];
  const blockA = lines.slice(a.line, a.end); const between = lines.slice(a.end, b.line); const blockB = lines.slice(b.line, b.end);
  lines.splice(a.line, b.end - a.line, ...blockB, ...between, ...blockA);
  return lines.join('\n');
};

export const attach = (text, line, md, { plan, session }) => {
  const { it, lines } = itemAt(text, line, md);
  lines[it.line] = lines[it.line].replace(ATTACHED, '').replace(/\s+$/, '') + ` · session \`${session}\` du plan \`${plan}\``;
  return lines.join('\n');
};

export const tickAttached = (text, plan, session) => {
  const lines = String(text ?? '').split('\n');
  for (const it of parseDoc(text).items) if (!it.done && it.attached?.plan === plan && it.attached?.session === session) lines[it.line] = lines[it.line].replace(/^([-*]\s+)\[ \]/, '$1[x]');
  return lines.join('\n');
};

// ---------------------------------------------------------------- the nearest plan
const FOLD = (s) => String(s || '').normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase();
const STOP = new Set('alors autre avant avec cette chaque comme dans depuis elle elles entre leur leurs mais meme moins nous plus pour quand sans sera sont tout toute toutes tous une plan session sessions escadrille ligne lignes gab novembre deux trois quatre cinq todo later waiting running'.split(' '));
const words = (s) => new Set((FOLD(s).match(/[a-z][a-z0-9-]{4,}/g) || []).map((w) => w.slice(0, 7)).filter((w) => !STOP.has(w)));
const FILES = /\b((?:lib|public|test|docs|scripts|site|phone|team)\/[\w./-]+\.\w+|server\.mjs)\b/g;
const files = (s) => new Set(String(s || '').match(FILES) || []);

// sectionText: the title of the line's section, a retired plan's own title for its lines, so it counts as the line's words
export const nearestPlans = (item, plans, sectionText = '') => {
  const iw = words(`${item.text} ${sectionText}`); const ifl = files(item.text);
  return (plans || []).map((p) => {
    const tw = words(`${p.title} ${p.goal || ''} ${(p.sessions || []).map((s) => s.name).join(' ')}`);
    const pf = files((p.sessions || []).map((s) => `${s.where || ''} ${s.prompt || ''}`).join(' '));
    const common = [...iw].filter((w) => tw.has(w)); const shared = [...ifl].filter((f) => pf.has(f));
    const st = FOLD(sectionText).replace(/^escadrille\s*:\s*/, '').trim(); const pt = FOLD(p.title).replace(/^escadrille\s*:\s*/, '').trim();
    const sameTitle = !!st && !!pt && (st === pt || st.startsWith(pt) || pt.startsWith(st)); // the line comes from this very plan
    const score = (sameTitle ? 10 : 0) + shared.length * 3 + common.length;
    const why = sameTitle ? 'le plan de la section de la ligne' : shared.length ? `fichiers communs : ${shared.slice(0, 3).join(', ')}` : common.length ? `mots communs : ${common.slice(0, 4).join(', ')}` : 'rien en commun';
    return { id: p.id, title: p.title, score, why };
  }).sort((a, b) => b.score - a.score || String(b.id).localeCompare(String(a.id)));
};

// ---------------------------------------------------------------- the session added to a plan
const LAUNCHED = (st) => !['todo', 'later'].includes(st);
const STATE_TAIL = /\n+## Suivi, obligatoire[\s\S]*$/;
const sidOf = (text, taken) => {
  const ws = (FOLD(text).match(/[a-z]{3,}/g) || []).filter((w) => !STOP.has(w));
  const base = (ws[0] || 'bkl').slice(0, 3).toUpperCase();
  let id = base; let n = 2; while (taken.has(id)) id = `${base}${n++}`;
  return id;
};
// The retired session a line comes from: « (session VEILLE, todo) … » under a heading that links plans/retired/<plan>.json
export const retiredSessionOf = (item, retired) => {
  const m = /^\(session ([^,)]+)/.exec(item.text); if (!m || !retired?.sessions) return null;
  return retired.sessions.find((s) => s.id === m[1].trim()) || null;
};
export const briefFor = (item, { sectionText = '', retiredSession = null, project = '' } = {}) => {
  if (retiredSession?.prompt) return String(retiredSession.prompt).replace(STATE_TAIL, '').trim();
  return [
    `LE RÉSULTAT. ${item.text}`,
    `LE POURQUOI. Une ligne du backlog${project ? ` de ${project}` : ''} (docs/backlog.md${sectionText ? `, section « ${sectionText} »` : ''}), rattachée à ce plan par le développeur pour qu'il ne la redemande jamais.`,
    'LES FAITS. Lis CLAUDE.md, docs/flot.md et la ligne complète dans docs/backlog.md ; elle dit souvent son test.',
    'LE TERRAIN. Ton worktree et ta branche ; aucun push, aucun réseau, aucune dépendance. Ne touche pas aux sessions déjà lancées du plan.',
    'LES EXIGENCES. Un test du comportement que décrit la ligne ; la suite existante verte.',
    "LES CRITÈRES DE FIN. Les tests verts (sortie lue ; « 0 test » est un échec), une capture si un écran change.",
    "LA LIVRAISON ET L'ARRÊT. Un arrêt : le résultat et les tests. En peu de mots.",
  ].join('\n\n');
};
export const sessionFor = (plan, rows, item, { retired = null, sectionText = '', budget = 5 } = {}) => {
  const by = new Map((rows || []).map((r) => [r.id, r.status]));
  const launched = (plan.sessions || []).filter((s) => LAUNCHED(by.get(s.id) || 'todo'));
  const wave = Math.max(0, ...launched.map((s) => Number(s.wave) || 1)) + 1;
  const rs = retiredSessionOf(item, retired);
  const taken = new Set((plan.sessions || []).map((s) => s.id));
  const id = rs && !taken.has(rs.id) ? rs.id : sidOf(item.text.replace(/^\([^)]*\)\s*/, ''), taken);
  const first = plan.sessions?.[0] || {};
  const name = (rs?.name || item.text.replace(/^\([^)]*\)\s*/, '')).slice(0, 80);
  const session = {
    id, wave, name, where: rs?.where || first.where?.replace(/branche \S+/, '').trim() || '', when: 'Après les sessions en cours.', path: first.path || plan.project || '',
    model: rs?.model || first.model || null, budget: Number(rs?.budget) > 0 ? Number(rs.budget) : budget,
    stops: rs?.stops?.length ? rs.stops : ['Le résultat et les tests'],
    prompt: briefFor(item, { sectionText, retiredSession: rs, project: plan.project ? String(plan.project).split('/').pop() : '' }),
  };
  if (!session.model) delete session.model;
  return { session, next: { ...plan, sessions: [...(plan.sessions || []), session] } };
};
