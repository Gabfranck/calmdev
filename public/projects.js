// The multiproject on the page side (docs/multiproject.md), shared by index.html and plan.html:
//   escadrilleProjects.current({ search, stored, escadrilles })  the current project: ?project=, else localStorage, else the last escadrille
//   escadrilleProjects.group({ projects, escadrilles, plans, current })  [{ path, name, escadrilles, plans, last, current }],
//     the current one first, then by last movement; plans without a project end in a group of path null
//   escadrilleProjects.withProject(href, project)  the link with ?project= kept
//   escadrilleProjects.ago(iso)  « il y a 3 h »
//   escadrilleProjects.memoryLine(text, esc)  a memory line as HTML: bold, code, dates
//   escadrilleProjects.reviewed(r), toReview(list)  a review approved on its last commit; the ones still to read
// and the keyboard of lists: j / k move the focus between [data-jk] rows that are visible, Enter opens
// (a link follows, a row clicks its [data-jk-open]), Escape closes the open <details> it sits in.
(function (root) {
  const T = (k, v) => (root.T ? root.T(k, v) : k);
  const folder = (p) => String(p).split('/').filter(Boolean).pop() || p;
  // Free display names (docs/multiproject.md): the last list loaded (GET /api/projects, `name`), then the names kept on
  // this device while the server has no POST /api/projects/name; the folder's last segment when neither has one.
  const LOCAL = 'escadrille.projectNames';
  const names = new Map(); let local = {};
  try { local = JSON.parse(root.localStorage.getItem(LOCAL) || '{}') || {}; } catch {}
  const clean = (v) => [...String(v ?? '').replace(/[\u0000-\u001f\u007f-\u009f]/g, ' ').replace(/\s+/g, ' ').trim()].slice(0, 60).join('').trim();
  const name = (p) => (p ? (names.get(p) || clean(local[p]) || folder(p)) : T('projects.none'));
  // the list as the server gave it: an entry whose name is only its folder has no free name
  const setNames = (list) => { names.clear(); for (const x of Array.isArray(list) ? list : []) if (x && x.path && x.name && x.name !== folder(x.path)) names.set(x.path, x.name); };
  const setLocal = (p, v) => { const n = clean(v); if (n) local[p] = n; else delete local[p]; try { root.localStorage.setItem(LOCAL, JSON.stringify(local)); } catch {} return n; };
  const time = (iso) => { const t = Date.parse(iso); return Number.isFinite(t) ? t : 0; };

  const current = ({ search = '', stored = null, escadrilles = [] } = {}) => {
    const q = new URLSearchParams(search).get('project');
    if (q) return q;
    if (stored) return stored;
    const last = [...escadrilles].sort((a, b) => time(b.at || b.created) - time(a.at || a.created))[0];
    return last ? last.project : null;
  };

  const group = ({ projects = [], escadrilles = [], plans = [], current: cur = null } = {}) => {
    const by = new Map();
    const get = (p) => { const k = p || null; if (!by.has(k)) by.set(k, { path: k, name: name(k), escadrilles: [], plans: [], last: 0 }); return by.get(k); };
    for (const p of projects) get(p.path);
    if (cur) get(cur);
    for (const e of escadrilles) { const g = get(e.project); g.escadrilles.push(e); g.last = Math.max(g.last, time(e.at || e.created)); }
    for (const p of plans) { const g = get(p.project); g.plans.push(p); g.last = Math.max(g.last, time(p.created)); }
    const list = [...by.values()].filter((g) => g.path === cur || g.escadrilles.length || g.plans.length);
    return list.map((g) => ({ ...g, current: g.path === cur, last: g.last ? new Date(g.last).toISOString() : null }))
      .sort((a, b) => (b.current - a.current) || ((a.path === null) - (b.path === null)) || (time(b.last) - time(a.last)));
  };

  const withProject = (href, project) => { if (!project) return href; const [p, h] = String(href).split('#'); return `${p}${p.includes('?') ? '&' : '?'}project=${encodeURIComponent(project)}${h !== undefined ? '#' + h : ''}`; };

  const ago = (iso, now = Date.now()) => { const t = time(iso); if (!t) return T('time.never'); const m = Math.max(0, Math.round((now - t) / 60000));
    return m < 1 ? T('time.now') : m < 60 ? T('time.agoMin', { n: m }) : m < 48 * 60 ? T('time.agoH', { n: Math.floor(m / 60) }) : T('time.agoD', { n: Math.floor(m / 1440) }); };

  const memoryLine = (text, esc) => esc(String(text).replace(/^\s*[-*]\s+/, ''))
    .replace(/`([^`]+)`/g, '<code>$1</code>')
    .replace(/\*\*(\d{4}-\d{2}-\d{2}(?: \(\d{2}:\d{2}\))?)\*\*/g, '<time>$1</time>')
    .replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>')
    .replace(/(^|[\s(])(\d{4}-\d{2}-\d{2})(?=[\s),.:;]|$)/g, '$1<time>$2</time>');

  // a review is read (« Relues ») once approved on its last commit: a session of a plan delivered as a kit is never merged,
  // so its review stays listed by the server; it leaves « À relire » and the counts all the same (phase 11, G). An approval
  // the branch moved past (stale) is to read again.
  const reviewed = (r) => { const v = r && r.verdict; return !!v && (v.verdict || v) === 'approve' && !v.stale; };
  const toReview = (list) => (Array.isArray(list) ? list : []).filter((r) => !reviewed(r));

  root.escadrilleProjects = { name, clean, setNames, setLocal, current, group, withProject, ago, memoryLine, reviewed, toReview };

  const doc = root.document; if (!doc || !doc.addEventListener) return;
  const typing = (t) => t && (t.isContentEditable || /^(INPUT|TEXTAREA|SELECT)$/.test(t.tagName));
  doc.addEventListener('keydown', (e) => {
    if (e.metaKey || e.ctrlKey || e.altKey || e.isComposing) return;
    const t = e.target;
    if (e.key === 'Escape' && !typing(t)) { const d = t.closest && t.closest('details[open]'); if (d) { d.open = false; const s = d.querySelector('summary'); if (s) s.focus(); e.preventDefault(); } return; }
    if (typing(t)) return;
    if (e.key === 'j' || e.key === 'k') {
      const rows = [...doc.querySelectorAll('[data-jk]')].filter((el) => el.offsetParent !== null || el.getClientRects().length);
      if (!rows.length) return; e.preventDefault();
      const i = rows.indexOf(t.closest ? t.closest('[data-jk]') : null);
      const next = rows[i < 0 ? 0 : Math.min(rows.length - 1, Math.max(0, i + (e.key === 'j' ? 1 : -1)))];
      if (!next.hasAttribute('tabindex') && !/^(A|BUTTON|SUMMARY)$/.test(next.tagName)) next.setAttribute('tabindex', '-1');
      next.focus(); next.scrollIntoView({ block: 'nearest' }); return;
    }
    if (e.key === 'Enter' && t.matches && t.matches('[data-jk]') && !/^(A|BUTTON|SUMMARY)$/.test(t.tagName)) { const o = t.querySelector('[data-jk-open]'); if (o) { e.preventDefault(); o.click(); } }
  });
})(typeof window !== 'undefined' ? window : globalThis);
