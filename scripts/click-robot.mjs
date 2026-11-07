// The click robot (phase 10, session F; first written by the pilot on the night of 2026-11-01).
// Run it after every merge that touches the interface: node scripts/click-robot.mjs   (docs/terrain.md, « Le robot des clics »)
// It starts a throwaway server on a free port (own database and plans folder, claude disabled with /usr/bin/false so no
// session can start), seeds it with test/seed-flow.mjs, and in a headless browser opens every page and view in both
// languages and at two widths, clicking each visible button, tab, summary, checkbox and in-app link, one at a time from
// a fresh load. The refused actions are in scripts/click-denylist.mjs; on top of that every non-GET request is aborted
// and every popup closed: nothing is launched, merged, answered or opened. Prints the defects (page errors, console
// errors, HTTP errors on GET, a frozen page, and « BOUTON MORT <page> <libellé> »: a click with no request, no DOM change,
// no navigation and no message), deduplicated, and exits 1 if there is one. The logic is in
// click-robot-lib.mjs and is tested; the browser itself is not (the sandbox of a session has none).
import { createRequire } from 'node:module';
import { existsSync, readdirSync } from 'node:fs';
import { homedir } from 'node:os';
import path from 'node:path';
import { denyReason } from './click-denylist.mjs';
import { freePort, startServer } from './click-robot-server.mjs';
import { CLICKABLE, USAGE, consoleError, deadButton, defect, isDeadClick, httpError, pageError, pageList, parseArgs, report, traceLine, visits, whereOf } from './click-robot-lib.mjs';
import { vars, projectDir } from '../lib/names.mjs';

const ROOT = path.resolve(path.dirname(new URL(import.meta.url).pathname), '..');
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// playwright-core and the headless shell are looked up, not named: the ms-playwright cache and the npx cache hold
// versioned folders. --browser and ESCADRILLE_BROWSER win; ESCADRILLE_PLAYWRIGHT names a node_modules folder.
const dirs = (d) => { try { return readdirSync(d).map((n) => path.join(d, n)); } catch { return []; } };
const findBrowser = (given) => {
  if (given || vars.BROWSER) return given || vars.BROWSER;
  const caches = [path.join(homedir(), 'Library', 'Caches', 'ms-playwright'), path.join(homedir(), '.cache', 'ms-playwright')];
  for (const c of caches) for (const d of dirs(c).filter((x) => /chromium_headless_shell/.test(x)).sort().reverse()) {
    for (const sub of dirs(d)) for (const bin of ['chrome-headless-shell']) { const f = path.join(sub, bin); if (existsSync(f)) return f; }
  }
  return null;
};
const loadPlaywright = () => {
  const roots = [vars.PLAYWRIGHT, ROOT, ...dirs(path.join(homedir(), '.npm', '_npx')).map((d) => path.join(d, 'node_modules'))].filter(Boolean);
  for (const r of roots) {
    const nm = r.endsWith('node_modules') ? r : path.join(r, 'node_modules');
    try { return createRequire(path.join(nm, '/'))('playwright-core'); } catch { /* next */ }
  }
  return null;
};

const describe = (loc) => loc.evaluate((el) => {
  const attrs = {}; for (const a of el.attributes) attrs[a.name] = a.value;
  const text = (el.innerText || '').trim().replace(/\s+/g, ' ').slice(0, 60);
  return { tag: el.tagName.toLowerCase(), label: text || el.getAttribute('aria-label') || '', attrs, href: el.getAttribute('href') ?? undefined, target: el.getAttribute('target') ?? undefined, type: el.getAttribute('type') ?? undefined, role: el.getAttribute('role') ?? undefined };
}, null, { timeout: 1500 }).catch(() => null);

const main = async () => {
  const opt = parseArgs(process.argv.slice(2));
  if (opt.help) { console.log(USAGE); return 0; }
  const seedDir = path.resolve(opt.seedDir || projectDir(ROOT, 'seed'));
  const pw = loadPlaywright(); const exe = findBrowser(opt.browser);
  if (!pw || !exe) { console.error(`click-robot: ${!pw ? 'playwright-core not found (set ESCADRILLE_PLAYWRIGHT to its node_modules folder)' : 'no headless browser found (use --browser PATH or ESCADRILLE_BROWSER)'}`); return 2; }

  let server = null; let base = opt.base;
  if (!base) { server = await startServer({ port: opt.port || await freePort(), seedDir }); base = server.base; }
  const defects = []; let clicks = 0; let skipped = 0; let visited = 0;
  // --keep / --trace: one line per thing a page does (console, navigation, failed request, download, close, crash)
  const trace = (where, event, detail) => { if (opt.keep || opt.trace) console.log(traceLine(where, event, detail)); };
  let browser = null;
  try {
    const plans = await (await fetch(`${base}/api/plans?project=${encodeURIComponent(path.join(seedDir, 'Carnet'))}`)).json().catch(() => []);
    const planIds = (Array.isArray(plans) ? plans : plans.plans || []).map((p) => p.id).filter(Boolean);
    let pages = pageList({ seedDir, planIds });
    if (opt.only) pages = pages.filter((p) => p.includes(opt.only));
    browser = await pw.chromium.launch({ executablePath: exe, headless: true });
    let gone = false; browser.on('disconnected', () => { gone = true; trace('navigateur', 'disconnected'); });
    const viewports = [[1440, 900], [390, 844]];
    outer: for (const lang of opt.langs || ['fr', 'en']) for (const [w, h] of viewports) {
      const ctx = await browser.newContext({ viewport: { width: w, height: h }, acceptDownloads: false });
      await ctx.route('**/*', (r) => (r.request().method() === 'GET' ? r.continue() : r.abort()));
      // what a click does, counted in the page for the dead buttons: DOM mutations and the messages the robot swallows
      await ctx.addInitScript(() => {
        const fx = (window.__robotFx = { mutations: 0, messages: 0 }); const said = () => { fx.messages++; };
        window.open = () => { said(); return null; }; window.confirm = () => { said(); return false; }; window.alert = () => { said(); };
        try { const c = navigator.clipboard; if (c) { const w = c.writeText && c.writeText.bind(c); c.writeText = (t) => { said(); return w ? w(t).catch(() => {}) : Promise.resolve(); }; } } catch { /* no clipboard */ }
        new MutationObserver((l) => { fx.mutations += l.length; }).observe(document, { subtree: true, childList: true, attributes: true, characterData: true });
      });
      // page.opener() is a promise in Playwright: tested as is, it is always truthy and every page of the robot was closed
      ctx.on('page', async (p) => { if (await p.opener().catch(() => null)) { trace('popup', 'closed by the robot', p.url()); p.close().catch(() => {}); } });
      for (const v of visits(pages, { langs: [lang], viewports: [[w, h]] })) {
        const where = whereOf(v); let action = 'chargement'; visited++;
        if (gone) { defects.push(defect({ where, kind: 'NAVIGATEUR FERMÉ' })); break outer; } // the browser died: a defect, exit 1
        const p = await ctx.newPage();
        const seen = { requests: 0, navigations: 0, messages: 0 }; // for the dead buttons: what the page did, from outside
        p.on('request', () => { seen.requests++; });
        p.on('framenavigated', (f) => { if (f === p.mainFrame()) seen.navigations++; });
        p.on('console', () => { seen.messages++; });
        p.on('dialog', () => { seen.messages++; });
        p.on('pageerror', (e) => defects.push(pageError(where, action, e)));
        p.on('console', (m) => { trace(where, `console.${m.type()}`, m.text()); if (m.type() === 'error') defects.push(consoleError(where, action, m.text())); });
        p.on('response', (r) => defects.push(httpError(where, action, { status: r.status(), method: r.request().method(), url: r.url() }, base)));
        p.on('dialog', (d) => { trace(where, `dialog.${d.type()}`, d.message()); d.dismiss().catch(() => {}); });
        p.on('framenavigated', (f) => { if (f === p.mainFrame()) trace(where, 'navigated', f.url().replace(base, '')); });
        p.on('requestfailed', (r) => trace(where, 'requestfailed', `${r.method()} ${r.url().replace(base, '')} ${r.failure()?.errorText || ''}`));
        p.on('download', (d) => { trace(where, 'download', d.url()); defects.push(defect({ where, action, kind: 'TÉLÉCHARGEMENT', detail: d.url().replace(base, '') })); });
        p.on('crash', () => { trace(where, 'crash'); defects.push(defect({ where, action, kind: 'PLANTÉE' })); });
        p.on('close', () => trace(where, 'close'));
        await p.goto(base + v.url, { waitUntil: 'load', timeout: 20000 }).catch((e) => defects.push(defect({ where, kind: 'GOTO', detail: e.message })));
        await p.waitForTimeout(1200).catch(() => {});
        if (p.isClosed()) { defects.push(defect({ where, action, kind: 'FERMÉE' })); continue; } // the page closed while loading: a defect (exit 1), never hidden
        const n = await p.locator(CLICKABLE).count().catch(() => 0);
        for (let i = 0; i < Math.min(n, opt.max); i++) {
          const loc = p.locator(CLICKABLE).nth(i);
          const el = await describe(loc);
          if (!el) continue;
          if (denyReason(el, { base })) { skipped++; continue; }
          action = `clic « ${el.label || '(sans texte)'} »`; clicks++;
          const before = p.url();
          const inPage = () => p.evaluate(() => ({ ...(window.__robotFx || { mutations: 0, messages: 0 }) })).catch(() => null);
          const fx0 = await inPage(); const out0 = { ...seen };
          let clicked = true; await loc.click({ timeout: 2000 }).catch(() => { clicked = false; });
          if (p.isClosed()) { defects.push(defect({ where, action, kind: 'FERMÉE' })); break; } // a click closed the page: said, never a crash
          await p.waitForTimeout(500).catch(() => {});
          if (p.isClosed()) { defects.push(defect({ where, action, kind: 'FERMÉE' })); break; }
          const alive = await Promise.race([p.evaluate(() => 1).then(() => true), sleep(3000).then(() => false)]);
          if (!alive) { defects.push(defect({ where, action, kind: 'FIGÉ' })); break; }
          const fx1 = p.url() === before ? await inPage() : null;
          // a navigation reloads the page (its counters restart): the click did something. A click refused by Playwright
          // (covered, out of view) says nothing about the button: not counted.
          if (clicked && fx0 && fx1 && isDeadClick({ requests: seen.requests - out0.requests, mutations: fx1.mutations - fx0.mutations, navigated: seen.navigations > out0.navigations, messages: (seen.messages - out0.messages) + (fx1.messages - fx0.messages) }, el)) defects.push(deadButton(where, el.label));
          if (p.url() !== before) { await p.goto(base + v.url, { waitUntil: 'load' }).catch(() => {}); await p.waitForTimeout(800); }
        }
        await p.close().catch(() => {});
      }
      await ctx.close();
    }
  } finally {
    if (browser) await browser.close().catch(() => {});
    if (server && !opt.keep) await server.stop();
  }
  const r = report({ clicks, visited, skipped, defects });
  console.log(r.text);
  if (server && opt.keep) console.log(`serveur gardé : ${base} (Ctrl-C pour l'arrêter)`);
  return r.code;
};

main().then((c) => process.exit(c), (e) => { console.error(`click-robot: ${e.message}`); process.exit(2); });
