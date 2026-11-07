// « Retour » (Accès, one folded row; lib/feedback.mjs builds the report). Shared with the tests:
//   escadrilleFeedback.compose(report, sentence)   the whole text: the sentence first, then the report
//   escadrilleFeedback.issueUrl(text)              { url, cut }: issues/new?title=&body=, the body cut near 6 000
//                                                  characters on a line boundary, the cut said at the end
//   escadrilleFeedback.row(row)                    the Accès row (row = access.js's own row helper); the report is read
//                                                  by GET /api/feedback when the row opens, nothing else is requested
// Nothing leaves without the click: « Ouvrir une issue » is a plain link the browser follows, « Copier » the clipboard.
(function (root) {
  const ISSUES = 'https://github.com/Gabfranck/calmdev/issues/new';
  const LIMIT = 6000;
  const T = (k, v) => (root.T ? root.T(k, v) : k);
  // the issue itself is French, like the server's report (lib/feedback.mjs): the team reads it
  const compose = (report, sentence) => `## Ce qui m'a fait perdre du temps\n\n${String(sentence || '').trim() || '—'}\n\n${report || ''}`; // i18n-ok: the issue's text
  const issueUrl = (text, title = 'Retour calmdev') => { // i18n-ok: the issue's title
    let body = String(text || ''); let cut = false;
    if (body.length > LIMIT) { cut = true; body = body.slice(0, LIMIT); const nl = body.lastIndexOf('\n'); if (nl > LIMIT - 800) body = body.slice(0, nl); body += '\n\n_(rapport tronqué à 6 000 caractères)_'; } // i18n-ok: the issue's text
    return { url: `${ISSUES}?title=${encodeURIComponent(title)}&body=${encodeURIComponent(body)}`, cut };
  };
  const api = { compose, issueUrl, ISSUES, LIMIT };
  root.escadrilleFeedback = api;
  const doc = root.document; if (!doc || !doc.addEventListener) return;

  const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  const S = { open: /[?&]retour=1\b/.test(root.location.search), report: null, error: false, sentence: '', copied: false, loading: false };
  const text = () => compose(S.report, S.sentence);
  const load = () => {
    if (S.report || S.loading) return; S.loading = true;
    fetch('/api/feedback').then((r) => r.json()).then((b) => { S.report = b.report || ''; }).catch(() => { S.error = true; }).finally(() => { S.loading = false; fill(); });
  };
  const body = () => {
    if (S.error) return `<p class="fb-note" role="alert">${esc(T('fb.unread'))}</p>`;
    if (!S.report) return `<p class="fb-note">${esc(T('fb.reading'))}</p>`;
    const { url, cut } = issueUrl(text());
    return `<label class="fb-label" for="fbSentence">${esc(T('fb.ask'))}</label>
<textarea id="fbSentence" class="fb-field" rows="2" data-i18n-attr="placeholder:fb.ph" placeholder="${esc(T('fb.ph'))}">${esc(S.sentence)}</textarea>
<p class="fb-sub">${esc(T('fb.whole'))}</p>
<pre class="fb-report" id="fbReport" tabindex="0" aria-label="${esc(T('fb.reportAria'))}">${esc(text())}</pre>
<div class="fb-act"><a class="btn primary" id="fbIssue" href="${esc(url)}" target="_blank" rel="noopener noreferrer">${esc(T('fb.issue'))}</a><button type="button" class="btn" id="fbCopy">${esc(T(S.copied ? 'fb.copied' : 'fb.copy'))}</button><span class="fb-sub" id="fbCut">${esc(T(cut ? 'fb.cut' : 'fb.nothing'))}</span></div>`;
  };
  const fill = () => { const box = doc.getElementById('fbBox'); if (box) box.innerHTML = body(); };
  // arriving by the link of an error (?retour=1), the row is opened and brought into view once
  let shown = !/[?&]retour=/.test(root.location.search);
  const reveal = () => { if (shown) return; const d = doc.getElementById('acc-retour'); if (!d) return; shown = true; d.scrollIntoView({ block: 'start' }); };
  const row = (mk) => { if (S.open) load(); setTimeout(reveal, 0); return mk(body()).replace('<details class="acc-row" id="acc-retour"', `<details class="acc-row" id="acc-retour"${S.open ? ' open' : ''}`); };
  api.row = row;
  doc.addEventListener('toggle', (e) => { const d = e.target; if (!d || d.id !== 'acc-retour') return; S.open = d.open; if (d.open) { load(); fill(); } }, true);
  doc.addEventListener('input', (e) => {
    if (e.target.id !== 'fbSentence') return; S.sentence = e.target.value; S.copied = false;
    const pre = doc.getElementById('fbReport'); if (pre) pre.textContent = text();
    const { url, cut } = issueUrl(text()); const a = doc.getElementById('fbIssue'); if (a) a.href = url;
    const c = doc.getElementById('fbCut'); if (c) c.textContent = T(cut ? 'fb.cut' : 'fb.nothing');
  });
  doc.addEventListener('click', (e) => {
    const b = e.target.closest && e.target.closest('#fbCopy'); if (!b) return;
    const done = () => { S.copied = true; b.textContent = T('fb.copied'); };
    if (root.navigator?.clipboard?.writeText) root.navigator.clipboard.writeText(text()).then(done, () => {}); else done();
  });
})(typeof window !== 'undefined' ? window : globalThis);
