// A small markdown for what a session writes (the thread of the Conversation and of a plan): paragraphs, headings,
// lists, tables, code blocks, bold, italic, inline code. The HTML of the source is always escaped.
// One source for index.html and plan.html (window.escadrilleMd); test/md-render.test.mjs loads it with require().
(function (root) {
  const esc = (s) => String(s ?? '').replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
  const inline = (t) => esc(t).replace(/`([^`]+)`/g, '<code>$1</code>').replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>').replace(/(^|\s)\*([^*\n]+)\*(?=\s|$|[.,;:])/g, '$1<em>$2</em>').replace(/\n/g, '<br>');

  // Table: a header row, a separator row (:---, ---:, :---:), then the rows up to the first line without a pipe.
  // Cells split on the pipes outside of an inline code span; « \| » is a pipe in the text.
  const cells = (line) => { let t = line.trim(); if (t.startsWith('|')) t = t.slice(1); if (t.endsWith('|') && !t.endsWith('\\|')) t = t.slice(0, -1);
    const out = []; let cur = ''; let tick = false;
    for (let i = 0; i < t.length; i++) { const c = t[i];
      if (c === '\\' && t[i + 1] === '|') { cur += '|'; i++; continue; }
      if (c === '`') tick = !tick;
      if (c === '|' && !tick) { out.push(cur.trim()); cur = ''; continue; }
      cur += c; }
    out.push(cur.trim()); return out; };
  const SEP = /^\s*\|?\s*:?-+:?\s*(\|\s*:?-+:?\s*)*\|?\s*$/;
  const isTableStart = (head, sep) => head !== undefined && sep !== undefined && head.includes('|') && sep.includes('-') && SEP.test(sep) && cells(sep).length === cells(head).length;
  const table = (head, sep, rows) => { const al = cells(sep).map((c) => (c.startsWith(':') && c.endsWith(':') ? ' class="md-c"' : c.endsWith(':') ? ' class="md-r"' : ''));
    const row = (tag, r) => `<tr>${al.map((a, i) => `<${tag}${a}>${inline(r[i] ?? '')}</${tag}>`).join('')}</tr>`;
    return `<div class="md-table"><table><thead>${row('th', cells(head))}</thead>${rows.length ? `<tbody>${rows.map((r) => row('td', cells(r))).join('')}</tbody>` : ''}</table></div>`; };

  const md = (src) => { const lines = String(src).replace(/\r/g, '').split('\n'); let out = ''; let list = null; let para = []; let code = null; let codeInd = 0; let codeLi = false;
    // a fence may be indented (a code block inside a list item): its indent is stripped from its lines, and it stays in the item
    const closeCode = () => { const pre = `<pre><code>${esc(code.map((c) => c.replace(new RegExp(`^ {0,${codeInd}}`), '')).join('\n'))}</code></pre>`;
      if (codeLi && list) out = out.replace(/<\/li>$/, pre + '</li>'); else out += pre; code = null; };
    // lines of one paragraph join with a space (Markdown); two spaces or a backslash at the end of a line force a break
    const flushP = () => { if (para.length) { out += `<p>${inline(para.map((p, i) => (i === para.length - 1 ? p.text : p.text + (p.hard ? '\n' : ' '))).join(''))}</p>`; para = []; } };
    const flushL = () => { if (list) { out += `</${list}>`; list = null; } };
    for (let i = 0; i < lines.length; i++) { const raw = lines[i]; const l = raw.replace(/\s+$/, '');
      if (code !== null) { if (/^\s*```/.test(l)) closeCode(); else code.push(raw); continue; }
      if (/^\s*```/.test(l)) { codeInd = l.match(/^\s*/)[0].length; flushP(); codeLi = !!list && codeInd >= 2; if (!codeLi) flushL(); code = []; continue; }
      if (isTableStart(l, lines[i + 1])) { flushP(); flushL(); const rows = []; let j = i + 2; while (j < lines.length && lines[j].trim() && lines[j].includes('|')) rows.push(lines[j++]); out += table(l, lines[i + 1], rows); i = j - 1; continue; }
      const h = l.match(/^(#{1,3})\s+(.*)/); if (h) { flushP(); flushL(); out += `<h${h[1].length + 1}>${inline(h[2])}</h${h[1].length + 1}>`; continue; }
      const ol = l.match(/^\s*(\d+)[.)]\s+(.*)/); const ul = l.match(/^\s*[-*•]\s+(.*)/);
      if (ol || ul) { flushP(); const kind = ol ? 'ol' : 'ul'; if (list !== kind) { flushL(); list = kind; out += ol && +ol[1] !== 1 ? `<ol start="${+ol[1]}">` : `<${kind}>`; } out += `<li>${inline((ol || ul)[ol ? 2 : 1])}</li>`; continue; }
      // a blank line keeps the list open: « 1. a », blank, « 2. b » is one list; any other line closes it
      if (!l.trim()) { flushP(); continue; }
      if (list && /^\s{2,}/.test(raw)) { out = out.replace(/<\/li>$/, ' ' + inline(l.trim()) + '</li>'); continue; }
      flushL(); para.push({ text: l.replace(/^\s+/, ''), hard: / {2,}$/.test(raw) || /\\$/.test(l) }); if (/\\$/.test(l)) para[para.length - 1].text = l.replace(/^\s+/, '').slice(0, -1); }
    flushP(); if (code) closeCode(); flushL(); return out; };

  if (typeof module !== 'undefined' && module.exports) module.exports = md;
  else root.escadrilleMd = md;
})(typeof window !== 'undefined' ? window : globalThis);
