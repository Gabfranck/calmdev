// The interaction contract, checked in a real (headless) browser on a running Escadrille (2026-11-02, the pilot).
// For each page: every visible control of the content is clicked from a fresh load; the contract says
//   1. a click does something (the DOM, the URL or the focus changes)      → else « clic sans effet »
//   2. what a click opened, Escape closes, and the focus comes back      → else « Échap ne ferme pas » / « focus perdu »
//   3. a hover never moves the layout                                     → else « le survol pousse la page »
//   4. on a canvas (Flot, a plan): a click on a node opens its detail, Échap closes it and gives the focus back, the
//      arrows go both ways, Tab leaves the canvas and Maj+Tab comes back on the same node, the board never scrolls
//                                                                         → else « canevas · … » (phase 11, F)
// The sidebar's project picker (phase 11 S) is the one control of the bar checked here: it opens a panel.
// Every non-GET request is answered with { ok: true } and never reaches the server: nothing is launched or merged.
//   node scripts/ux-contract.mjs [base=http://localhost:3078] [project path] [--lang=fr|en]
import { createRequire } from 'node:module';
import os from 'node:os';
import path from 'node:path';
import fs from 'node:fs';

const require = createRequire(path.join(os.homedir(), '.npm/_npx/e41f203b7505f1fb/node_modules/'));
const { chromium } = require('playwright-core');
const args = process.argv.slice(2).filter((a) => !a.startsWith('--'));
const BASE = args[0] || 'http://localhost:3078';
const PROJECT = args[1] || process.cwd();
const LANG = (process.argv.find((a) => a.startsWith('--lang=')) || '--lang=fr').slice(7);
const shell = ['chromium_headless_shell-1248/chrome-headless-shell-mac-arm64/chrome-headless-shell'].map((p) => path.join(os.homedir(), 'Library/Caches/ms-playwright', p)).find((p) => fs.existsSync(p));
const q = `project=${encodeURIComponent(PROJECT)}&lang=${LANG}`;
const plans = await fetch(`${BASE}/api/plans?project=${encodeURIComponent(PROJECT)}`).then((r) => r.json()).catch(() => []);
const lastPlan = (Array.isArray(plans) ? plans : plans.plans || [])[0]?.id;
const PAGES = [`/?${q}`, `/flow?${q}`, `/review?${q}`, `/resources?${q}`, `/architecture?${q}`, `/learning?${q}`, `/?${q}#acces`, `/?${q}#rafale`, `/?${q}#memoire`, `/?${q}#pilote`, ...(lastPlan ? [`/plan/${lastPlan}?${q}`] : [])];
const SKIP = /lancer|launch|fusionner|merge|envoyer|send|autoriser|allow|refuser|deny|accepter|accept|approuver|approve|supprimer|delete|arrêter|stop|dicter|dictate|terminal|tout reprendre|resume all/i;
// A disabled control with its reason written beside it is not a missed interaction (phase 11, D): it is skipped.
const CONTROLS = 'main button:visible:enabled, main [role=button]:visible:not([aria-disabled="true"]), main summary:visible, main [role=tab]:visible, main [data-node]:visible, main .node:visible, main a[href^="#"]:visible, aside button:visible:enabled, aside summary:visible, .status [tabindex]:visible, .sidebar .pp-trigger:visible';

// 4. the canvas, by the keyboard and one click (docs/phase11/ux.md §4.3)
async function canvasKeys(p, where) {
  const bad = []; const say = (what) => bad.push(`${where} · canevas · ${what}`);
  const nodes = p.locator('main .cv-node'); const count = await nodes.count().catch(() => 0); if (!count) return bad;
  const active = () => p.evaluate(() => { const a = document.activeElement; const n = a && a.closest && a.closest('.cv-node'); return n ? n.dataset.id : a ? a.tagName + (a.id ? '#' + a.id : '') : ''; });
  const scrolled = () => p.evaluate(() => { const b = document.querySelector('.cv-board'); return b ? b.scrollLeft + b.scrollTop : 0; });
  if ((await p.locator('main .cv-node[tabindex="0"]').count()) !== 1) say('pas un seul nœud dans l’ordre de Tab');
  const first = p.locator('main .cv-node[tabindex="0"]').first(); await first.focus().catch(() => {}); const a0 = await active();
  if (count > 1) {
    await p.keyboard.press('ArrowDown'); await p.waitForTimeout(150); const a1 = await active();
    if (a1 === a0) { await p.keyboard.press('ArrowUp'); await p.waitForTimeout(150); if ((await active()) === a0) say('↓ et ↑ ne bougent pas'); }
    else { await p.keyboard.press('ArrowUp'); await p.waitForTimeout(150); if ((await active()) !== a0) say('↑ ne revient pas après ↓'); }
  }
  const here = await active(); await p.keyboard.press('Tab'); await p.waitForTimeout(150); const out1 = await active();
  if (await p.evaluate(() => !!(document.activeElement && document.activeElement.closest && document.activeElement.closest('.cv-node')))) say(`Tab reste sur les nœuds (${out1})`);
  await p.keyboard.press('Shift+Tab'); await p.waitForTimeout(150); if ((await active()) !== here) say(`Maj+Tab ne revient pas au nœud (${await active()})`);
  if (await scrolled()) say('le canevas a défilé');
  // a click opens the detail, Échap closes it and the focus is the node again
  const target = p.locator('main .cv-node').first(); const id = await target.getAttribute('data-id');
  await target.click({ timeout: 2000 }).catch(() => {}); await p.waitForTimeout(400);
  if ((await target.getAttribute('aria-expanded').catch(() => null)) !== 'true') { say(`clic sur « ${id} » : rien ne s’ouvre`); return bad; }
  await p.keyboard.press('Escape'); await p.waitForTimeout(300);
  if ((await p.locator('main .cv-node[aria-expanded="true"]').count()) !== 0) say('Échap ne ferme pas le détail');
  else if ((await active()) !== id) say(`Échap : le focus ne revient pas au nœud (${await active()})`);
  if (await scrolled()) say('le canevas a défilé');
  return bad;
}

// 5. every page, at 1440 and 390: no raw i18n marker (⟦) in the DOM, no sideways scroll (phase 11, X; Dev 06:55)
async function pageChecks(p, where, width) {
  const bad = [];
  // a marker is a key between the double brackets (closed, or cut after its key): a memory line that merely quotes the bracket is content
  if (await p.evaluate(() => /⟦[\w.-]+[|⟧]/.test(document.body.innerText || ''))) bad.push(`${where} [${width}] · un marqueur i18n brut (⟦) dans la page`);
  // what overflows is named (tag.class, up to three), so the defect can be found without a browser at hand
  const wide = await p.evaluate(() => { const w = document.documentElement.clientWidth; if (Math.max(document.documentElement.scrollWidth, document.body.scrollWidth) <= w) return null; return [...document.querySelectorAll("body *")].filter((e) => { const r = e.getBoundingClientRect(); return r.width && r.right > w + 1 && getComputedStyle(e).position !== "fixed"; }).slice(0, 3).map((e) => e.tagName.toLowerCase() + (e.id ? "#" + e.id : "") + (e.className && typeof e.className === "string" ? "." + e.className.trim().split(/\s+/).join(".") : "") + " " + Math.round(e.getBoundingClientRect().right - w) + "px").join(", ") || "(un élément transformé)"; });
  if (wide) bad.push(`${where} [${width}] · la page défile en largeur · ${wide}`);
  return bad;
}

let b = await chromium.launch({ executablePath: shell, headless: true });
// A fresh context answering every non-GET itself; a click that took the browser down (a crash, a close) gets a new one
const freshContext = async () => {
  if (!b.isConnected()) b = await chromium.launch({ executablePath: shell, headless: true });
  const c = await b.newContext({ viewport: { width: 1440, height: 900 } });
  await c.route('**/*', (r) => (r.request().method() === 'GET' ? r.continue() : r.fulfill({ status: 200, contentType: 'application/json', body: '{"ok":true}' })));
  return c;
};
const out = []; let clicks = 0;
for (const pg of PAGES) {
  let ctx = await freshContext();
  let p = await ctx.newPage(); const where = pg.replace(/\?[^#]*/, '');
  await p.goto(BASE + pg, { waitUntil: 'load' }).catch(() => {}); await p.waitForTimeout(1200);
  out.push(...(await pageChecks(p, where, 1440)));
  { const small = await b.newContext({ viewport: { width: 390, height: 844 } }); const sp = await small.newPage(); await sp.goto(BASE + pg, { waitUntil: 'load' }).catch(() => {}); await sp.waitForTimeout(1000); out.push(...(await pageChecks(sp, where, 390))); await small.close().catch(() => {}); }
  // the keyboard pass leaves a node selected (the page remembers it): the clicks start from a page with nothing stored, else the
  // open panel's buttons are counted once and the last controls of the page are « gone » at their turn (2026-11-02, the Flot)
  if (/^\/(flow|plan\/)/.test(where)) { out.push(...(await canvasKeys(p, where))); clicks++; await p.evaluate(() => { try { localStorage.clear(); sessionStorage.clear(); } catch {} }).catch(() => {}); await p.goto(BASE + pg, { waitUntil: 'load' }).catch(() => {}); await p.waitForTimeout(800); }
  const n = Math.min(await p.locator(CONTROLS).count().catch(() => 0), 25);
  // the markup of each control at count time: a control gone by the time of its click is named by it
  // after a reload, the page gets its controls back before the next one is clicked (the canvas of the Flot mounts after its data)
  const settled = async () => { for (let k = 0; k < 20; k++) { if ((await p.locator(CONTROLS).count().catch(() => 0)) >= n) return; await p.waitForTimeout(200).catch(() => {}); } };
  const descs = await p.locator(CONTROLS).evaluateAll((els) => els.map((e) => e.outerHTML.replace(/>[\s\S]*$/, '>').slice(0, 80))).catch(() => []);
  for (let i = 0; i < n; i++) {
    // a click may close the page (a window.close, a download): the control is reported and the page reopened
    if (p.isClosed()) { out.push(`${where} · un clic précédent a fermé la page`); p = await ctx.newPage().catch(async () => { await ctx.close().catch(() => {}); ctx = await freshContext(); return ctx.newPage(); }); await p.goto(BASE + pg, { waitUntil: 'load' }).catch(() => {}); await p.waitForTimeout(800); }
    try {
    const loc = p.locator(CONTROLS).nth(i);
    // a control with no text, no aria-label and no title is named by its markup, so the defect can be found (phase 11, X)
    const label = ((await loc.innerText().catch(() => '')) || (await loc.getAttribute('aria-label').catch(() => '')) || (await loc.getAttribute('title').catch(() => '')) || '').trim().replace(/\s+/g, ' ').slice(0, 40) || (await loc.evaluate((e) => e.outerHTML.replace(/>[\s\S]*$/, '>')).catch(() => '(contrôle disparu après le chargement) ' + (descs[i] || ''))).slice(0, 120);
    if (SKIP.test(label)) continue;
    // a node of the canvas is clicked as a person would: only where it is seen, its centre not under the mini-map,
    // the buttons or the edge of the board (the board never scrolls; phase 11, F)
    if (await loc.evaluate((e) => { if (!e.classList.contains('cv-node')) return false; const r = e.getBoundingClientRect(); const b = e.closest('.cv-board').getBoundingClientRect(); const x = r.x + r.width / 2, y = r.y + r.height / 2;
      if (x < b.left || x > b.right || y < b.top || y > b.bottom || y > innerHeight || x > innerWidth) return true; const at = document.elementFromPoint(x, y); return !(at && e.contains(at)); }).catch(() => false)) continue;
    // 3. hover: the box of the panel and of the thread must not move
    const boxes = async () => p.evaluate(() => [...document.querySelectorAll('main, aside, .mc-scroll, .sheet')].map((e) => { const r = e.getBoundingClientRect(); return [r.x, r.y, r.width, r.height].map(Math.round).join(','); }).join('|'));
    // the element is brought into view before the first measure: hover() scrolls to it, and a page that scrolled moved
    // every box (15 of the 50 écarts of the baseline were this, phase 11, D)
    await loc.scrollIntoViewIfNeeded({ timeout: 1500 }).catch(() => {}); await p.waitForTimeout(100);
    const before = await boxes(); await loc.hover({ timeout: 1500 }).catch(() => {}); await p.waitForTimeout(150);
    if ((await boxes()) !== before) out.push(`${where} · survol « ${label} » · le survol pousse la page`);
    // 1. click: something must change
    const snap = async () => p.evaluate(() => [location.href, document.body.innerHTML.length, document.activeElement && document.activeElement.outerHTML.slice(0, 80), [...document.querySelectorAll('[open],[aria-expanded="true"],dialog[open],.open,.is-open,[data-open="true"]')].length].join('¦'));
    const s0 = await snap(); clicks++;
    await loc.click({ timeout: 2000 }).catch(() => {}); await p.waitForTimeout(400);
    const s1 = await snap();
    if (label.startsWith('(contrôle disparu')) { out.push(`${where} · ${label}`); continue; } // not a click: the control is not there to be clicked
    if (s1 === s0) { out.push(`${where} · clic « ${label || '(sans texte)'} » · clic sans effet`); continue; }
    if (s1.split('¦')[0] !== s0.split('¦')[0] && !s1.split('¦')[0].includes('#')) { await p.goto(BASE + pg, { waitUntil: 'load' }).catch(() => {}); await p.waitForTimeout(800); await settled(); continue; } // a link: fine
    // 2. what opened, Escape closes, focus back
    const opened = Number(s1.split('¦')[3]) > Number(s0.split('¦')[3]);
    if (opened) {
      await p.keyboard.press('Escape'); await p.waitForTimeout(300);
      const s2 = await snap();
      if (Number(s2.split('¦')[3]) >= Number(s1.split('¦')[3])) out.push(`${where} · clic « ${label} » puis Échap · Échap ne ferme pas`);
      else if (!(await loc.evaluate((e) => e === document.activeElement || e.contains(document.activeElement)).catch(() => false))) out.push(`${where} · clic « ${label} » puis Échap · le focus ne revient pas`);
    }
    await p.goto(BASE + pg, { waitUntil: 'load' }).catch(() => {}); await p.waitForTimeout(600); await settled();
    } catch (e) { if (!p.isClosed()) throw e; }
  }
  await ctx.close().catch(() => {});
}
await b.close().catch(() => {});
const uniq = [...new Set(out)];
console.log(`${PAGES.length} pages, ${clicks} clics, ${uniq.length} écarts au contrat`); console.log(uniq.join('\n'));
process.exit(uniq.length ? 1 : 0);
