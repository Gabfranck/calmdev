// The measure on screen (docs/mesure.md): three calm lines, the figure first then the words, the figure in
// the one tint; nothing when there is no data. Shared by the home (the project's figures) and a plan's header.
//   Measure.lines(m, { plan })   → the <p> lines, '' when nothing is measured
(() => {
  const esc = (s) => String(s ?? '').replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
  const T = (k, v) => (window.T ? window.T(k, v) : k);
  const usd = (x) => window.T.usd(x, 2);
  const hours = (h) => (h < 1 ? T('time.forMin', { n: Math.round(h * 60) }) : T('time.forH', { n: h < 10 ? Math.round(h * 10) / 10 : Math.round(h) }));
  // One figure, a two-word label, the full sentence and the definition at the click (Dev: the least text possible)
  const line = (fig, words, detail) => `<details class="measure-line"><summary><b>${esc(fig)}</b> ${esc(words)}</summary><p>${esc(detail)}</p></details>`;
  const lines = (m, { plan = false } = {}) => {
    if (!m) return '';
    const out = [];
    if (m.costPerMergedPr != null) out.push(line(usd(m.costPerMergedPr), T('measure.perPr'), m.merged ? T('measure.perPrDetailN', { usd: usd(m.costPerMergedPr), cost: usd(m.cost), n: m.merged }) : T('measure.perPrDetail', { usd: usd(m.costPerMergedPr) })));
    if (m.sessionHours != null && m.sessionHours > 0 && m.attentionMinutes != null) out.push(line(T('time.forMin', { n: Math.round(m.attentionMinutes) }), T('measure.attention'), T('measure.attentionDetail', { min: Math.round(m.attentionMinutes), hours: hours(m.sessionHours) })));
    if (plan) { if (m.unattended != null) out.push(line(T(m.unattended ? 'measure.finished' : 'measure.resumed'), T(m.unattended ? 'measure.unattended' : 'measure.byHand'), T(m.unattended ? 'measure.unattendedDetail' : 'measure.attendedDetail'))); }
    else if (m.finished) out.push(line(T('measure.ofN', { a: m.unattended, b: m.finished }), T('measure.unattended'), T('measure.plansDetail', { a: m.unattended, n: m.finished })));
    return out.join('');
  };
  window.Measure = { lines };
})();
