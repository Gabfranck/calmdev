// « Signaler un défaut » (public/signaler.html): the link that ends each section of docs/qa-semaine.md.
//   escadrilleSignaler.screen(search)            the screen named by ?ecran=, else « Escadrille »
//   escadrilleSignaler.backTo(screen, project)   { href, label }: the screen itself when it is known, else the home
//   escadrilleSignaler.added(tasks, text)        the backlog line the server just wrote for this text (the last match, else the last line)
// The page: one field, Enter sends POST /api/project/backlog { project, from: 'defect', text, screen }, Shift+Enter
// breaks the line; the line added shows under the field, the field empties for the next defect; an error is one line.
(function (root) {
  const T = (k, v) => (root.T ? root.T(k, v) : k);
  const SCREENS = {
    conversation: '/', ressources: '/resources', flot: '/flow', revue: '/review', architecture: '/architecture',
    'accès': '/#acces', acces: '/#acces', rafale: '/#rafale', 'mémoire': '/#memoire', memoire: '/#memoire', 'téléphone': '/#acces', telephone: '/#acces', // i18n-ok: ?ecran= ids
  };
  // ?ecran= holds the screen's French id (sidebar.js writes it, the backlog keeps it); the page names it in the language
  const NAMES = { conversation: 'nav.conversation', ressources: 'nav.resources', flot: 'nav.flow', revue: 'nav.review', architecture: 'nav.architecture', 'accès': 'nav.access', acces: 'nav.access', rafale: 'nav.burst', 'mémoire': 'nav.memory', memoire: 'nav.memory', pilote: 'nav.pilot', 'téléphone': 'nav.phone', telephone: 'nav.phone' }; // i18n-ok
  const label = (n) => { const k = NAMES[String(n || '').trim().toLowerCase()]; return k ? T(k) : n; };
  const screen = (search = '') => (new URLSearchParams(search).get('ecran') || '').trim() || 'calmdev';
  const withProject = (href, project) => {
    if (!project) return href; const [p, h] = String(href).split('#');
    return `${p}${p.includes('?') ? '&' : '?'}project=${encodeURIComponent(project)}${h !== undefined ? '#' + h : ''}`;
  };
  function backTo(name, project) {
    const href = SCREENS[String(name || '').trim().toLowerCase()];
    return href ? { href: withProject(href, project), label: T('signal.back', { name: label(name) }) } : { href: withProject('/', project), label: T('signal.backHome') };
  };
  const added = (tasks, text) => {
    const list = Array.isArray(tasks) ? tasks : []; const want = String(text || '').replace(/\s+/g, ' ').trim();
    const hit = [...list].reverse().find((t) => String(t.text || '').replace(/\s+/g, ' ').includes(want));
    return hit || list[list.length - 1] || null;
  };
  root.escadrilleSignaler = { screen, backTo, added };

  const doc = root.document; if (!doc || !doc.getElementById || !doc.getElementById('defect')) return;
  if (root.escadrilleI18n) root.escadrilleI18n.onChange(() => root.location.reload()); // a one-field page: drawn again whole
  const $ = (id) => doc.getElementById(id);
  const name = screen(root.location.search);
  const params = new URLSearchParams(root.location.search);
  const esc = (s) => String(s ?? '').replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
  const base = (p) => String(p || '').split('/').filter(Boolean).pop() || p;
  let project = params.get('project') || root.localStorage?.getItem('escadrille.project') || null;

  doc.title = T('signal.docTitle', { name: label(name) });
  $('screen').textContent = label(name);
  const field = $('defect'); const send = $('send'); const err = $('error'); const list = $('added');
  // the subtitle: the screen named, then the project; the breadcrumb's project is the sidebar's (#crumbProj)
  const showProject = () => {
    const pe = $('project'); const sep = $('projectSep');
    if (pe) { pe.textContent = project ? base(project) : T('signal.noProject'); pe.title = project || ''; pe.hidden = false; if (sep) sep.hidden = false; }
    const back = backTo(name, project); $('back').href = back.href; $('back').textContent = back.label;
    $('where').textContent = project ? `${project}/docs/backlog.md` : T('signal.noProjectFound');
  };
  showProject();
  if (!project) fetch('/api/escadrilles').then((r) => r.json()).then((escs) => {
    project = root.escadrilleProjects ? root.escadrilleProjects.current({ search: '', stored: null, escadrilles: Array.isArray(escs) ? escs : [] }) : null;
    showProject();
  }).catch(() => {});

  const grow = () => { field.style.height = 'auto'; field.style.height = Math.min(field.scrollHeight + 2, 140) + 'px'; };
  const fail = (msg) => { err.textContent = msg; err.hidden = false; };
  let busy = false;
  const submit = async () => {
    const text = field.value.trim();
    if (!text) { fail(T('signal.empty')); field.focus(); return; }
    if (!project) { fail(T('signal.noProjectFound')); return; }
    if (busy) return; busy = true; send.disabled = true; err.hidden = true;
    try {
      const r = await fetch('/api/project/backlog', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ project, from: 'defect', text, screen: name }) });
      const body = await r.json().catch(() => ({}));
      if (!r.ok || body.error) throw new Error(body.error || T('signal.status', { n: r.status }));
      const line = added(body.tasks, text);
      if (body.file) $('where').textContent = body.file;
      const li = doc.createElement('li');
      li.innerHTML = `<span class="line">${esc(line ? line.text : text)}</span>${line && line.n != null ? `<span class="n">${esc(T('signal.line', { n: line.n }))}</span>` : ''}`;
      list.prepend(li); $('done').hidden = false;
      $('count').textContent = T('signal.count', { n: list.children.length });
      field.value = ''; grow();
    } catch (e) {
      fail(T('signal.failed', { e: e.message === 'Failed to fetch' ? T('signal.down') : e.message }));
    } finally { busy = false; send.disabled = false; field.focus(); }
  };
  field.addEventListener('keydown', (e) => {
    if (e.key === 'Enter' && !e.shiftKey && !e.isComposing) { e.preventDefault(); submit(); }
  });
  field.addEventListener('input', () => { grow(); if (!err.hidden && field.value.trim()) err.hidden = true; });
  $('form').addEventListener('submit', (e) => { e.preventDefault(); submit(); });
  field.focus();
})(typeof window !== 'undefined' ? window : globalThis);
