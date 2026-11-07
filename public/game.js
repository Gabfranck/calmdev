// The progression on the page (docs/game.md), one script for every screen: it reads GET /api/game and places
//   - nothing in the top bar: the rank and the XP live in the bottom line of the sidebar (sidebar.js), one trace per
//     screen (docs/phase9/direction.md §0); its « Progression » button ([data-gm-open]) opens the sheet drawn here;
//   - on a plan (/plan/:id): one line, what this plan brings;
//   - on a review (#finish): « +15 XP » beside the button;
//   - a discreet « +N XP » under the bar when something new earns, and a 4 s toast for a new achievement, once each.
// With 'game': false in the project's settings the API answers { off: true } and nothing shows.
(function () {
  const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);
  const project = () => new URLSearchParams(location.search).get('project') || localStorage.getItem('escadrille.project') || '';
  const planId = () => { const m = /^\/plan\/([^/?#]+)/.exec(location.pathname); return m ? decodeURIComponent(m[1]) : ''; };
  const T = (k, v) => window.T(k, v);
  const fmt = (n) => window.T.num(Number(n));
  // the ranks, achievements and quests by their ids (lib/game.mjs), in the page's language
  const has = (k) => window.T.has && window.T.has(k);
  const localize = (x) => { if (!x || x.off) return x;
    const rk = (lv, name) => (has('game.rank.' + lv) ? T('game.rank.' + lv) : name);
    return { ...x, rank: rk(x.level, x.rank), next: x.next ? { ...x.next, rank: rk(x.level + 1, x.next.rank) } : x.next,
      badges: (x.badges || []).map((b) => ({ ...b, title: has('game.b.' + b.id) ? T('game.b.' + b.id) : b.title, why: has('game.bw.' + b.id) ? T('game.bw.' + b.id) : b.why })),
      week: x.week ? { ...x.week, quests: (x.week.quests || []).map((q) => ({ ...q, title: has('game.q.' + q.id) ? T('game.q.' + q.id) : q.title })) } : x.week }; };
  // The icons, drawn at the stroke, 16px (no emoji)
  const P = {
    plane: 'M2 9l12-5-3 9-3-3-3 2 1-4z', merge: 'M5 3v10M5 6a5 5 0 005 5h1M11 11a2 2 0 104 0 2 2 0 00-4 0M3 3a2 2 0 104 0 2 2 0 00-4 0',
    moon: 'M12 10A5 5 0 016 4a5 5 0 106 6z', eye: 'M1.5 8S4 3.5 8 3.5 14.5 8 14.5 8 12 12.5 8 12.5 1.5 8 1.5 8zM8 10a2 2 0 100-4 2 2 0 000 4z',
    shield: 'M8 1.5l5 2v4c0 3.5-2.2 5.8-5 7-2.8-1.2-5-3.5-5-7v-4z', map: 'M1.5 3.5l4-1.5 5 2 4-1.5v10l-4 1.5-5-2-4 1.5zM5.5 2v10M10.5 4v10',
    check: 'M3 8.5l3 3 7-7', leaf: 'M3 13C3 6 7 3 13 3c0 6-3 10-10 10zM3 13l6-6', compass: 'M8 14.5a6.5 6.5 0 100-13 6.5 6.5 0 000 13zM10.5 5.5l-1.5 3.5-3.5 1.5 1.5-3.5z',
    target: 'M8 14.5a6.5 6.5 0 100-13 6.5 6.5 0 000 13zM8 11a3 3 0 100-6 3 3 0 000 6z', relay: 'M2 5h9l-2.5-2.5M14 11H5l2.5 2.5',
    book: 'M3 2.5h7.5a2 2 0 012 2v9H5a2 2 0 01-2-2zM3 11.5a2 2 0 012-2h7.5', grid: 'M2 2h5v5H2zM9 2h5v5H9zM2 9h5v5H2zM9 9h5v5H9z',
    flame: 'M8 14.5c-2.8 0-4.5-1.8-4.5-4.3C3.5 7 6.5 5.5 6.5 1.5c2.5 1.5 6 4.3 6 8.7 0 2.5-1.7 4.3-4.5 4.3z',
  };
  const icon = (k) => `<svg class="gm-ic" viewBox="0 0 16 16" width="16" height="16" aria-hidden="true"><path d="${P[k] || P.check}"/></svg>`;
  const css = `
  .gm-bar { width: 64px; height: 4px; border-radius: 2px; background: var(--active); overflow: hidden; flex: none; } .gm-bar i { display: block; height: 100%; background: var(--accent); }
  .gm-num { font-family: var(--mono); font-variant-numeric: tabular-nums; color: var(--text); font-size: 12px; } /* taste-skill-ignore: figures in mono (Dev, boot.dev); the shadow is on a floating sheet or toast */
  .gm-gain { font-family: var(--mono); font-size: 12px; color: var(--accent); opacity: 0; transform: translateY(-4px); transition: opacity var(--t-ui) var(--ease-out), transform var(--t-ui) var(--ease-out); pointer-events: none; } /* taste-skill-ignore: figures in mono (Dev, boot.dev); the shadow is on a floating sheet or toast */
  .gm-gain.on { opacity: 1; transform: none; }
  .gm-line { margin: 12px 0 0; font-size: var(--fs-small); color: var(--muted); display: flex; gap: 8px; align-items: center; min-width: 0; }
  .gm-line button { border: 0; background: none; padding: 0; font: inherit; color: var(--accent); cursor: pointer; } .gm-line .gm-num { font-size: 12px; }
  .gm-line .t { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; min-width: 0; }
  .gm-hint { margin-left: 8px; font-family: var(--mono); font-size: 12px; color: var(--accent); } /* taste-skill-ignore: figures in mono (Dev, boot.dev); the shadow is on a floating sheet or toast */
  .gm-ic { fill: none; stroke: currentColor; stroke-width: 1.4; stroke-linecap: round; stroke-linejoin: round; flex: none; }
  dialog.gm-sheet { width: min(560px, calc(100vw - 32px)); max-height: calc(100vh - 64px); padding: 0; border: 0; border-radius: var(--radius-card); background: var(--surface); color: var(--text); box-shadow: 0 12px 40px rgba(0,0,0,.18); } /* taste-skill-ignore: figures in mono (Dev, boot.dev); the shadow is on a floating sheet or toast */
  dialog.gm-sheet::backdrop { background: rgba(15,18,22,.32); }
  .gm-in { padding: var(--card-pad); display: grid; gap: 20px; }
  .gm-in header { display: flex; align-items: baseline; gap: 12px; } .gm-in h1 { font-size: var(--fs-section); margin: 0; font-weight: 600; } .gm-in header .gm-num { margin-left: auto; color: var(--muted); }
  .gm-rank { display: grid; gap: 8px; } .gm-rank b { font-size: var(--fs-title); font-weight: 600; letter-spacing: -0.01em; }
  .gm-rank .gm-bar { width: 100%; height: 6px; border-radius: 3px; } .gm-rank p { margin: 0; color: var(--muted); font-size: var(--fs-small); display: flex; justify-content: space-between; }
  .gm-in h2 { font-size: var(--fs-small); font-weight: 600; margin: 0 0 8px; color: var(--text); }
  .gm-q { list-style: none; margin: 0; padding: 0; display: grid; gap: 2px; } .gm-q li { display: flex; align-items: center; gap: 10px; height: 32px; font-size: var(--fs-body); }
  .gm-q li.done { color: var(--muted); } .gm-q li .gm-bar { width: 48px; margin-left: auto; } .gm-q .gm-num { width: 28px; text-align: right; }
  .gm-badges { display: grid; grid-template-columns: repeat(5, 1fr); gap: 6px; }
  .gm-badges button { display: grid; justify-items: center; gap: 6px; padding: 10px 4px; border: 0; border-radius: var(--radius-control); background: var(--raised); color: var(--text); font: inherit; font-size: 12px; line-height: 1.25; text-align: center; cursor: pointer; min-height: 72px; }
  .gm-badges button .gm-ic { width: 20px; height: 20px; color: var(--accent); }
  .gm-badges button.off { color: var(--faint); background: transparent; outline: 1px solid var(--border); outline-offset: -1px; } .gm-badges button.off .gm-ic { color: var(--faint); }
  .gm-badges button[aria-pressed="true"] { outline: 2px solid var(--accent); outline-offset: -2px; }
  .gm-why { margin: 8px 0 0; min-height: 20px; font-size: var(--fs-small); color: var(--muted); }
  .gm-close { margin-left: 12px; }
  .gm-toast { position: fixed; right: 24px; bottom: 24px; z-index: 50; display: flex; align-items: center; gap: 10px; padding: 10px 14px; border-radius: var(--radius-card); background: var(--primary); color: var(--primary-ink); font-size: var(--fs-small); box-shadow: 0 8px 24px rgba(0,0,0,.18); opacity: 0; transform: translateY(8px); transition: opacity var(--t-ui) var(--ease-out), transform var(--t-ui) var(--ease-out); } /* taste-skill-ignore: figures in mono (Dev, boot.dev); the shadow is on a floating sheet or toast */
  .gm-toast.on { opacity: 1; transform: none; } .gm-toast .gm-num { color: inherit; }
  @media (max-width: 860px) { .gm-badges { grid-template-columns: repeat(3, 1fr); } }
  @media (prefers-reduced-motion: reduce) { .gm-gain, .gm-toast { transition: none; transform: none; } }`;
  const style = document.createElement('style'); style.textContent = css; document.head.appendChild(style);

  let g = null; let picked = null; const seenKey = () => 'escadrille.game.' + (project() || '-');
  const pct = (x) => (x.next ? Math.max(0, Math.min(100, Math.round(((x.xp - x.from) / (x.next.xp - x.from)) * 100))) : 100);
  const lastBadge = () => (g.badges || []).filter((b) => b.at).sort((a, b) => Date.parse(b.at) - Date.parse(a.at))[0];
  const questsDone = () => g.week.quests.filter((q) => q.done >= q.of).length;

  const place = () => {
    if (!g || g.off) { document.querySelectorAll('.gm-line,.gm-hint').forEach((n) => n.remove()); return; }
    // no line on a planning thread's rail (#rail): the bottom line of the sidebar is the one trace there (§0)
    const pid = planId(); const tr = document.querySelector('.title-row > div');
    if (pid && g.plan && tr && !tr.querySelector('.gm-line')) {
      const p = document.createElement('p'); p.className = 'gm-line'; p.id = 'gm-plan';
      p.innerHTML = `<span class="gm-num">+${g.plan.earned} XP</span><span>${esc(T('game.earned'))}</span>${g.plan.potential > g.plan.earned ? `<span>${esc(T('game.upTo'))}</span><span class="gm-num">+${g.plan.potential}</span>` : ''}`;
      tr.appendChild(p);
    }
    const fin = document.getElementById('finish');
    if (fin && !fin.parentElement.querySelector('.gm-hint')) {
      const strict = /strict/i.test(document.getElementById('level')?.textContent || '');
      const s = document.createElement('span'); s.className = 'gm-hint'; s.textContent = `+${strict ? 25 : 15} XP`; s.title = T('game.onReview'); fin.after(s);
    }
  };
  let queued = false; new MutationObserver(() => { if (queued) return; queued = true; requestAnimationFrame(() => { queued = false; place(); }); }).observe(document.body, { childList: true, subtree: true });

  const sheet = () => {
    let d = document.getElementById('gm-sheet'); if (!d) { d = document.createElement('dialog'); d.id = 'gm-sheet'; d.className = 'gm-sheet'; d.setAttribute('aria-labelledby', 'gm-h'); document.body.appendChild(d); }
    const won = g.badges.filter((b) => b.at).length; const st = g.week.streak; const sel = g.badges.find((b) => b.id === picked);
    d.innerHTML = `<div class="gm-in"><header><h1 id="gm-h">${esc(T('game.title'))}</h1><span class="gm-num">${esc(T('game.level', { n: g.level }))}</span><button type="button" class="btn ghost gm-close" data-gm-close>${esc(T('game.close'))}</button></header>
      <div class="gm-rank"><b>${esc(g.rank)}</b><span class="gm-bar" aria-hidden="true"><i style="width:${pct(g)}%"></i></span><p><span class="gm-num">${fmt(g.xp)} XP</span><span>${g.next ? `${esc(T('game.nextAt', { rank: g.next.rank }))} <span class="gm-num">${fmt(g.next.xp)}</span>` : esc(T('game.top'))}</span></p></div>
      <section aria-labelledby="gm-wk"><h2 id="gm-wk">${esc(T('game.week'))} · <span class="gm-num">+${g.week.xp} XP</span> · ${esc(T('game.streak'))} <span class="gm-num">${st.days}</span> ${esc(T('game.days'))}${st.frozen ? ` ${esc(T('game.frozen', { n: st.frozen }))}` : ''}</h2>
      <ul class="gm-q">${g.week.quests.map((q) => `<li class="${q.done >= q.of ? 'done' : ''}">${icon(q.done >= q.of ? 'check' : q.id === 'reviews' ? 'eye' : q.id === 'budget' ? 'leaf' : 'book')}<span>${esc(q.title)}</span><span class="gm-bar" aria-hidden="true"><i style="width:${Math.round((q.done / q.of) * 100)}%"></i></span><span class="gm-num">${q.done}/${q.of}</span></li>`).join('')}</ul></section>
      <section aria-labelledby="gm-bd"><h2 id="gm-bd">${esc(T('game.badges'))} · <span class="gm-num">${won}/${g.badges.length}</span></h2>
      <div class="gm-badges">${g.badges.map((b) => `<button type="button" class="${b.at ? '' : 'off'}" data-gm-badge="${esc(b.id)}" aria-pressed="${picked === b.id}" aria-label="${esc(b.title)}${b.at ? '' : ' ' + T('game.toEarn')}">${icon(b.icon)}<span>${esc(b.title)}</span></button>`).join('')}</div>
      <p class="gm-why" aria-live="polite">${sel ? `${esc(sel.why)}${sel.at ? ` · ${window.T.date(sel.at)}` : ''}` : ''}</p></section></div>`;
    return d;
  };
  document.addEventListener('click', (e) => {
    const t = e.target.closest ? e.target : null; if (!t) return;
    if (t.closest('[data-gm-open]')) { if (!g || g.off) return; picked = null; const d = sheet(); if (!d.open) d.showModal(); return; }
    if (t.closest('[data-gm-close]')) { document.getElementById('gm-sheet')?.close(); return; }
    const b = t.closest('[data-gm-badge]'); if (b) { picked = picked === b.dataset.gmBadge ? null : b.dataset.gmBadge; sheet(); document.querySelector(`[data-gm-badge="${b.dataset.gmBadge}"]`)?.focus(); return; }
    if (t.closest('button') && !t.closest('#gm-sheet')) setTimeout(load, 1500); // an action may have earned: read again, once
  });
  document.addEventListener('click', (e) => { const d = document.getElementById('gm-sheet'); if (d && e.target === d) d.close(); });

  const toast = (html) => { const t = document.createElement('div'); t.className = 'gm-toast'; t.setAttribute('role', 'status'); t.innerHTML = html; document.body.appendChild(t);
    requestAnimationFrame(() => t.classList.add('on')); setTimeout(() => { t.classList.remove('on'); setTimeout(() => t.remove(), 300); }, 4000); };
  // What is new since the last visit: the earnings and achievements after the stored mark, shown once
  const announce = () => {
    const mark = localStorage.getItem(seenKey()); const latest = [g.recent?.[0]?.at, ...g.badges.map((b) => b.at)].filter(Boolean).sort().pop() || '';
    if (mark !== null) {
      const gained = (g.recent || []).filter((r) => r.at > mark).reduce((a, r) => a + r.xp, 0);
      const gain = document.querySelector('.gm-gain');
      if (gained && gain) { gain.textContent = `+${gained} XP`; gain.classList.add('on'); setTimeout(() => gain.classList.remove('on'), 4000); }
      const merge = (g.recent || []).find((r) => r.at > mark && r.kind === 'merge');
      for (const b of g.badges.filter((x) => x.at && x.at > mark)) toast(`${icon(b.icon)}<span>${esc(T('game.badge', { name: b.title }))}</span>`);
      if (merge && !g.badges.some((x) => x.at && x.at > mark)) toast(`${icon('merge')}<span>${esc(T('game.merged'))}</span><span class="gm-num">+${merge.xp} XP</span>`);
    }
    if (latest) localStorage.setItem(seenKey(), latest);
  };
  let busy = false;
  async function load() {
    if (busy) return; busy = true;
    try {
      const q = new URLSearchParams(); if (project()) q.set('project', project()); if (planId()) q.set('plan', planId());
      const r = await fetch('/api/game?' + q); const next = r.ok ? await r.json() : null; if (!next) return;
      g = localize(next); document.querySelectorAll('.gm-line,.gm-hint').forEach((n) => n.remove()); place(); if (!g.off) announce();
      const d = document.getElementById('gm-sheet'); if (d && d.open) sheet();
    } catch {} finally { busy = false; }
  }
  load(); setInterval(() => { if (!document.hidden) load(); }, 30000);
  if (window.escadrilleI18n) window.escadrilleI18n.onChange(load); // the ranks and quests come from the server, in the cookie's language
  window.escadrilleGame = { load };
})();
