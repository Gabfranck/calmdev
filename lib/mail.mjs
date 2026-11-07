// The developer's mail, on this Mac only (docs/mail.md). First step: the unread count of the default mail app and a
// click that opens it. Nothing leaves the Mac: no service, no key, no OAuth. No mail content (sender, subject, body)
// is ever read here, kept, logged or returned: a number and the app's name, nothing else.
//
//   handler()  → { bundleId, name, kind: 'mail' | 'other' }   the mailto: handler of LaunchServices, read, never launched
//   count()    → { app, bundleId, count: n | null, reason }    reason: 'ok' | 'not-running' | 'no-counter' | 'error'
//   open()     → { ok: true, app }                             `open -b <bundleId>`: the developer's click only
//   route(req, res, url, { json })  → true when it answered    GET /api/mail, POST /api/mail/open (wired by server.mjs)
//
// list() and draft() come with the session REP; they keep the same rule (nothing stored, nothing logged).
//
// ESCADRILLE_MAIL_FAKE (captures, tests): a JSON { "app": "Mail", "bundleId": "com.apple.mail", "count": 3 } answered
// as is; open() then does nothing but say so. The sandbox of a session has neither Mail nor Apple Events.

import { execFile } from 'node:child_process';
import { homedir } from 'node:os';
import path from 'node:path';
import { vars } from './names.mjs';

export const MAIL_APP = 'com.apple.mail';
const NAMES = {
  'com.apple.mail': 'Mail', 'com.microsoft.outlook': 'Outlook', 'com.readdle.smartemail-mac': 'Spark',
  'com.readdle.sparkdesktop': 'Spark', 'com.google.chrome': 'Chrome', 'com.apple.safari': 'Safari',
  'org.mozilla.firefox': 'Firefox', 'org.mozilla.thunderbird': 'Thunderbird', 'com.superhuman.electron': 'Superhuman',
  'com.brave.browser': 'Brave', 'company.thebrowser.browser': 'Arc', 'com.microsoft.edgemac': 'Edge',
  'it.bloop.airmail2': 'Airmail', 'com.mimestream.mimestream': 'Mimestream', 'com.freron.mailmate': 'MailMate',
};
export const TTL_MS = 60_000;      // the count is cached one minute
export const TIMEOUT_MS = 2_500;   // a short delay: a slow Mail never holds the home page

const run = (cmd, args, timeout = TIMEOUT_MS) => new Promise((resolve, reject) => {
  execFile(cmd, args, { timeout, maxBuffer: 1 << 20 }, (err, stdout) => (err ? reject(err) : resolve(String(stdout))));
});

export const appName = (bundleId) => NAMES[String(bundleId || '').toLowerCase()] || String(bundleId || '').split('.').pop() || 'Mail';

// The mailto: handler in the LaunchServices preferences (the list of LSHandlers); none declared = Mail, the system default.
export const parseHandler = (lsJson) => {
  const list = (lsJson && lsJson.LSHandlers) || [];
  const h = list.find((x) => String(x.LSHandlerURLScheme || '').toLowerCase() === 'mailto');
  const id = String((h && (h.LSHandlerRoleAll || h.LSHandlerRoleViewer)) || MAIL_APP).toLowerCase();
  return { bundleId: id, name: appName(id), kind: id === MAIL_APP ? 'mail' : 'other' };
};

const LS_PLIST = () => path.join(homedir(), 'Library/Preferences/com.apple.LaunchServices/com.apple.launchservices.secure.plist');

// The AppleScript never names Mail outside the `is running` test, so it never launches it; the count is the unified inbox.
export const COUNT_SCRIPT = 'if application id "com.apple.mail" is running then\ntell application id "com.apple.mail" to return unread count of inbox\nelse\nreturn "not-running"\nend if';

const fake = () => { const raw = vars.MAIL_FAKE; if (!raw) return null; try { return JSON.parse(raw); } catch { return null; } };

// deps are injected by the tests: { readHandler, isRunning, unread, launch, now }
export const createMail = (deps = {}) => {
  const d = {
    readHandler: async () => parseHandler(JSON.parse(await run('/usr/bin/plutil', ['-convert', 'json', '-o', '-', LS_PLIST()]))),
    isRunning: async (bundleId) => { try { await run('/usr/bin/pgrep', ['-xq', bundleId === MAIL_APP ? 'Mail' : appName(bundleId)]); return true; } catch { return false; } },
    unread: async () => run('/usr/bin/osascript', ['-e', COUNT_SCRIPT]),
    launch: async (bundleId) => { await run('/usr/bin/open', ['-b', bundleId]); },
    now: () => Date.now(),
    ...deps,
  };
  let cache = null; // { at, value }

  const handler = async () => {
    const f = fake(); if (f) { const id = String(f.bundleId || MAIL_APP).toLowerCase(); return { bundleId: id, name: f.app || appName(id), kind: id === MAIL_APP ? 'mail' : 'other' }; }
    try { return await d.readHandler(); } catch { return parseHandler(null); } // unreadable preferences: the system default
  };

  const count = async ({ fresh = false } = {}) => {
    const f = fake();
    if (f) { const n = Number.isInteger(f.count) && f.count >= 0 ? f.count : null; const h = await handler(); return { app: h.name, bundleId: h.bundleId, count: n, reason: n === null ? (h.kind === 'mail' ? 'not-running' : 'no-counter') : 'ok' }; }
    if (!fresh && cache && d.now() - cache.at < TTL_MS) return cache.value;
    const h = await handler(); let value;
    if (h.kind !== 'mail') value = { app: h.name, bundleId: h.bundleId, count: null, reason: 'no-counter' };
    else if (!(await d.isRunning(h.bundleId))) value = { app: h.name, bundleId: h.bundleId, count: null, reason: 'not-running' };
    else {
      try { const out = String(await d.unread()).trim(); const n = /^\d+$/.test(out) ? Number(out) : null;
        value = { app: h.name, bundleId: h.bundleId, count: n, reason: n === null ? (out === 'not-running' ? 'not-running' : 'error') : 'ok' }; }
      catch { value = { app: h.name, bundleId: h.bundleId, count: null, reason: 'error' }; } // timeout, Automation refused: never the message
    }
    cache = { at: d.now(), value };
    return value;
  };

  const open = async () => {
    const h = await handler();
    if (fake()) return { ok: true, app: h.name, fake: true };
    await d.launch(h.bundleId);
    cache = null; // back from the app, the count is read again
    return { ok: true, app: h.name };
  };

  // The routes, from this Mac only: server.mjs calls route() after its guard (the LAN without a device token gets 401
  // there, and /api/mail is not a phone route, so a token gets 403). The check is repeated here for a wiring mistake.
  const route = async (req, res, url, { json, isMac }) => {
    if (url.pathname !== '/api/mail' && url.pathname !== '/api/mail/open') return false;
    if (isMac && !isMac(req)) { json(res, 403, { error: 'depuis le Mac seulement' }); return true; }
    if (url.pathname === '/api/mail' && req.method === 'GET') { json(res, 200, await count({ fresh: url.searchParams.get('fresh') === '1' })); return true; }
    if (url.pathname === '/api/mail/open' && req.method === 'POST') { try { json(res, 200, await open()); } catch { json(res, 500, { error: 'l’app de mail ne s’est pas ouverte' }); } return true; }
    json(res, 405, { error: 'méthode refusée' }); return true;
  };

  return { handler, count, open, route };
};

const shared = createMail();
export const { handler, count, open, route } = shared;
