// A small, safe Markdown renderer for the docs pages (no dependency).
// render(md, { linkMd }) → HTML. Every piece of text is escaped: raw HTML in the source is shown, never passed.
// Supported: headings # to #### (with id anchors), paragraphs, bullet and numbered lists (nested), tables,
// fenced code blocks (class language-xxx), inline code, links, bold, italic, blockquotes, rules.
// linkMd: 'html' (default) turns a link to a .md file of the same folder into .html; 'md' keeps it (server route).
// docPage(title, body, { base }) wraps the body in the docs shell used by scripts/site.mjs and GET /docs/*.md.

export const esc = (s) => String(s ?? '').replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));

export const slug = (s) => String(s).normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '') || 'section';

const safeHref = (u, linkMd) => {
  u = u.trim();
  if (/^[a-z][a-z0-9+.-]*:/i.test(u) && !/^(https?|mailto):/i.test(u)) return '#'; // javascript:, data:, file:…
  if (linkMd === 'html' && !/^[a-z][a-z0-9+.-]*:|^\/\/|\//i.test(u.split('#')[0])) u = u.replace(/\.md(#|$)/, '.html$1');
  return u;
};

const inline = (src, opts) => {
  const stash = [];
  const keep = (html) => '\u0000' + (stash.push(html) - 1) + '\u0000';
  let s = src.replace(/(`+)([\s\S]*?[^`])\1(?!`)/g, (_, __, code) => keep(`<code>${esc(code.trim())}</code>`));
  s = esc(s);
  s = s.replace(/\[([^\]]+)\]\(([^)\s]+)(?:\s+&quot;[^)]*&quot;)?\)/g, (_, text, href) => keep(`<a href="${esc(safeHref(href.replace(/&amp;/g, '&'), opts.linkMd))}">`) + text + keep('</a>'));
  s = s.replace(/\*\*([^*\n]+)\*\*/g, '<strong>$1</strong>').replace(/(^|[^\w*])\*([^*\s][^*\n]*?)\*(?![\w*])/g, '$1<em>$2</em>');
  s = s.replace(/(^|[^\w])_([^_\s][^_\n]*?)_(?!\w)/g, '$1<em>$2</em>');
  return s.replace(/\u0000(\d+)\u0000/g, (_, i) => stash[i]);
};

const LIST = /^(\s*)([-*+]|\d+[.)])\s+(.*)$/;
const startsBlock = (l) => /^\s*(```|#{1,6}\s|>|([-*_])(\s*\2){2,}\s*$)/.test(l) || LIST.test(l);
const cells = (l) => l.trim().replace(/^\||\|$/g, '').split(/(?<!\\)\|/).map((c) => c.trim().replace(/\\\|/g, '|'));
const isSep = (l) => /^\s*\|?\s*:?-+:?\s*(\|\s*:?-+:?\s*)*\|?\s*$/.test(l) && l.includes('-') && (l.includes('|') || false);

const renderList = (items, opts) => {
  const tag = /^\d/.test(items[0].mark) ? 'ol' : 'ul';
  const base = items[0].indent; let out = `<${tag}>`;
  for (let i = 0; i < items.length;) {
    const it = items[i]; let j = i + 1; const kids = [];
    while (j < items.length && items[j].indent > base) kids.push(items[j++]);
    out += `<li>${inline(it.text, opts)}${kids.length ? renderList(kids, opts) : ''}</li>`;
    i = j;
  }
  return out + `</${tag}>`;
};

export function render(md, opts = {}) {
  opts = { linkMd: 'html', ...opts };
  const lines = String(md).replace(/\r\n?/g, '\n').split('\n'); const used = new Map(); const out = [];
  const id = (t) => { const b = slug(t); const n = used.get(b) ?? 0; used.set(b, n + 1); return n ? `${b}-${n}` : b; };
  for (let i = 0; i < lines.length;) {
    const l = lines[i];
    if (!l.trim()) { i++; continue; }
    let m;
    if ((m = l.match(/^\s*(`{3,})\s*([\w+-]*)/))) { // fenced code
      const body = []; i++;
      while (i < lines.length && !lines[i].trim().startsWith(m[1])) body.push(lines[i++]);
      i++; out.push(`<pre><code${m[2] ? ` class="language-${esc(m[2])}"` : ''}>${esc(body.join('\n'))}</code></pre>`); continue;
    }
    if ((m = l.match(/^(#{1,4})\s+(.*?)\s*#*\s*$/))) { const text = m[2]; out.push(`<h${m[1].length} id="${esc(id(text.replace(/[`*_]/g, '')))}">${inline(text, opts)}</h${m[1].length}>`); i++; continue; }
    if (/^\s*([-*_])(\s*\1){2,}\s*$/.test(l)) { out.push('<hr>'); i++; continue; }
    if (/^\s*>/.test(l)) { const q = []; while (i < lines.length && /^\s*>/.test(lines[i])) q.push(lines[i++].replace(/^\s*>\s?/, '')); out.push(`<blockquote>${render(q.join('\n'), opts)}</blockquote>`); continue; }
    if (l.includes('|') && i + 1 < lines.length && isSep(lines[i + 1])) {
      const head = cells(l); i += 2; const rows = [];
      while (i < lines.length && lines[i].trim() && lines[i].includes('|')) rows.push(cells(lines[i++]));
      out.push(`<div class="table"><table><thead><tr>${head.map((c) => `<th>${inline(c, opts)}</th>`).join('')}</tr></thead><tbody>${rows.map((r) => `<tr>${head.map((_, k) => `<td>${inline(r[k] ?? '', opts)}</td>`).join('')}</tr>`).join('')}</tbody></table></div>`); continue;
    }
    if (LIST.test(l)) {
      const items = [];
      while (i < lines.length) {
        const lm = lines[i].match(LIST);
        if (lm) { items.push({ indent: lm[1].replace(/\t/g, '    ').length, mark: lm[2], text: lm[3] }); i++; continue; }
        if (!lines[i].trim()) { const nx = lines.slice(i + 1).find((x) => x.trim()); if (nx && LIST.test(nx) && /^\s/.test(nx)) { i++; continue; } break; }
        if (/^\s+\S/.test(lines[i]) && !startsBlock(lines[i])) { items[items.length - 1].text += ' ' + lines[i++].trim(); continue; } // continuation
        break;
      }
      out.push(renderList(items, opts)); continue;
    }
    const p = [];
    while (i < lines.length && lines[i].trim() && !startsBlock(lines[i]) && !(lines[i].includes('|') && i + 1 < lines.length && isSep(lines[i + 1]))) p.push(lines[i++].trim());
    if (!p.length) { p.push(lines[i++].trim()); }
    out.push(`<p>${inline(p.join(' '), opts)}</p>`);
  }
  return out.join('\n');
}

export const firstTitle = (md) => { const m = String(md).match(/^#\s+(.+?)\s*$/m); return m ? m[1].replace(/[`*_]/g, '') : null; };

const ROUNDEL = '<svg aria-hidden="true" viewBox="0 0 100 100"><circle cx="50" cy="50" r="50" fill="#1f56c4"/><circle cx="50" cy="50" r="31" fill="#fff"/><circle cx="50" cy="50" r="18" fill="#1f56c4"/></svg>';

// base: { css, docsCss, home, index } — the paths differ between the built files and the server route.
export const SHELL_STATIC = { css: '../site.css', docsCss: '../docs.css', home: '../index.html', index: 'index.html' };
export const SHELL_SERVER = { css: '/site/site.css', docsCss: '/site/docs.css', home: '/site/index.html', index: '/site/docs/index.html' };

export function docPage(title, body, base = SHELL_STATIC) {
  return `<!doctype html>
<html lang="fr">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${esc(title)} · Escadrille</title>
<link rel="icon" href="${esc(base.home.replace(/index\.html$/, ''))}assets/favicon.svg" type="image/svg+xml">
<link rel="stylesheet" href="${esc(base.css)}">
<link rel="stylesheet" href="${esc(base.docsCss)}">
</head>
<body class="docs">
<header class="nav"><a class="mark" href="${esc(base.home)}">${ROUNDEL}Escadrille · Docs</a><nav aria-label="Docs"><ul><li><a href="${esc(base.index)}">Toutes les docs</a></li></ul></nav></header>
<main class="prose">
${body}
</main>
</body>
</html>
`;
}
