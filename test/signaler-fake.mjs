// A stand-in for the server while session A writes the real POST /api/project/backlog { from: 'defect' }:
// serves public/ and answers the backlog the way the contract says, { exists, file, tasks }, so signaler.html can be
// tried and captured alone.   node test/signaler-fake.mjs [port]   (default: a free port from the system; FAIL=1 answers every POST with a 500)
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const PUBLIC = path.join(ROOT, 'public');
const MIME = { '.html': 'text/html; charset=utf-8', '.css': 'text/css; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.svg': 'image/svg+xml' };

export const fake = ({ fail = false, project = ROOT } = {}) => {
  const tasks = [
    { n: 1, text: 'Le guide de QA de la semaine : docs/qa-semaine.md, une section par écran', done: false },
    { n: 2, text: 'Ressources : le tri par date garde l’ordre après un rechargement', done: false },
  ];
  const posts = [];
  const json = (res, code, body) => { res.writeHead(code, { 'content-type': 'application/json; charset=utf-8' }); res.end(JSON.stringify(body)); };
  const server = http.createServer((req, res) => {
    const url = new URL(req.url, 'http://localhost');
    if (url.pathname === '/api/escadrilles') return json(res, 200, [{ id: 'x', project, at: '2026-11-01T09:00:00Z' }]);
    if (url.pathname === '/api/plans') return json(res, 200, []);
    if (url.pathname === '/api/project/backlog' && req.method === 'POST') {
      let raw = ''; req.on('data', (c) => { raw += c; });
      req.on('end', () => {
        const body = JSON.parse(raw || '{}'); posts.push(body);
        if (fail) return json(res, 500, { error: 'docs/backlog.md est en lecture seule' });
        if (body.from !== 'defect' || !String(body.text || '').trim()) return json(res, 400, { error: 'texte vide' });
        tasks.push({ n: tasks.length + 1, text: `${body.screen} : ${String(body.text).replace(/\s+/g, ' ').trim()}`, done: false });
        json(res, 200, { exists: true, file: `${body.project}/docs/backlog.md`, tasks });
      });
      return;
    }
    const rel = url.pathname === '/' ? 'index.html' : decodeURIComponent(url.pathname.slice(1));
    const fp = path.join(PUBLIC, rel);
    if (!fp.startsWith(PUBLIC) || !fs.existsSync(fp) || !fs.statSync(fp).isFile()) { res.writeHead(404); return res.end(); }
    res.writeHead(200, { 'content-type': MIME[path.extname(fp)] || 'application/octet-stream' });
    if (req.method === 'HEAD') return res.end();
    fs.createReadStream(fp).pipe(res);
  });
  return { server, posts, tasks };
};

// Run by hand only: `node --test` with no file list also runs test/**/*.mjs, and a server listening there never ends
if (process.argv[1] === fileURLToPath(import.meta.url) && !process.env.NODE_TEST_CONTEXT) {
  const { server } = fake({ fail: process.env.FAIL === '1' });
  server.listen(Number(process.argv[2]) || 0, '127.0.0.1', () => console.log(`signaler fake on http://127.0.0.1:${server.address().port}/signaler.html?ecran=Ressources`));
}
