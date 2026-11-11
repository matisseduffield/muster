// Muster on this computer: the real Worker over an in-memory SQLite database,
// with the pages read from web/. Nothing here touches the network.
//   node dev.mjs [port]      then http://localhost:5186
// It starts with one made-up group, at the address it prints.
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { DatabaseSync } from 'node:sqlite';
import { createRequire } from 'node:module';
import worker from './worker/worker.js';

const here = path.dirname(fileURLToPath(import.meta.url));
const L = createRequire(import.meta.url)('./web/lib.js');
const port = Number(process.argv[2]) || 5186;

const db = new DatabaseSync(':memory:');
db.exec(fs.readFileSync(path.join(here, 'worker/schema.sql'), 'utf8'));
const statement = (sql, args = []) => ({
  bind: (...next) => statement(sql, next),
  first: async () => db.prepare(sql).get(...args) ?? null,
  run: () => (/^\s*(SELECT|WITH)/i.test(sql) ? { results: db.prepare(sql).all(...args) } : { results: [], meta: db.prepare(sql).run(...args) }),
});
const env = {
  DB: {
    prepare: sql => statement(sql),
    async batch(stmts) {
      db.exec('BEGIN');
      try { const out = stmts.map(s => s.run()); db.exec('COMMIT'); return out; }
      catch (e) { db.exec('ROLLBACK'); throw e; }
    },
  },
};

// The made-up group. Ids are fixed so a screenshot script can be someone in it.
export const DEMO = 'demo-group-0000000000a';
export const PEOPLE = ['Matisse', 'Tom', 'Jess', 'Arlo', 'Priya', 'Dan'].map((name, k) => ({ id: `demo-member-000000000${k}`, name }));
async function seed() {
  const [w0, w1, w2, w3] = L.weeks(new Date(), 4);
  const rows = {
    [w0]: ['ffmbf', 'fbf-f', 'ffff-', 'mbfbb', 'f-fmf', '-----'],
    [w1]: ['fffbm', 'mffbb', 'bbfff', 'fffb-', 'fmfbf', 'fffbb'],
    [w2]: ['bbbbb', 'ff---', '-----', 'fmf--', '-----', 'bb-ff'],
    [w3]: ['-f---', '-----', 'ff---', '-----', '-----', '-----'],
  };
  const ops = [{ t: 'group', name: 'The Usual Suspects' }, ...PEOPLE.map((p, k) => ({ t: 'member', ...p, usual: undefined }))];
  for (const [w, list] of Object.entries(rows)) list.forEach((s, k) => [...s].forEach((v, i) => { if (v !== '-') ops.push({ t: 'mark', m: PEOPLE[k].id, w, i, v }); }));
  const plan = 'demo-plan-00000000000a';
  ops.push({ t: 'plan', id: plan, w: w0, i: 2, text: "Pub at 7, then Tom's", by: PEOPLE[1].id });
  ops.push({ t: 'rsvp', p: plan, m: PEOPLE[1].id, v: 'in' }, { t: 'rsvp', p: plan, m: PEOPLE[2].id, v: 'in' }, { t: 'rsvp', p: plan, m: PEOPLE[3].id, v: 'out' }, { t: 'rsvp', p: plan, m: PEOPLE[4].id, v: 'maybe' });
  await worker.fetch(new Request(`http://x/api/g/${DEMO}/ops`, { method: 'POST', body: JSON.stringify({ ops }) }), env);
}

const TYPES = { html: 'text/html; charset=utf-8', js: 'text/javascript; charset=utf-8', json: 'application/json', woff2: 'font/woff2', svg: 'image/svg+xml', png: 'image/png', txt: 'text/plain' };
http.createServer(async (req, res) => {
  const url = new URL(req.url, `http://localhost:${port}`);
  if (url.pathname.startsWith('/api/')) {
    const chunks = [];
    for await (const c of req) chunks.push(c);
    const body = ['GET', 'HEAD'].includes(req.method) ? undefined : Buffer.concat(chunks);
    const out = await worker.fetch(new Request(url, { method: req.method, headers: req.headers, body }), env);
    res.writeHead(out.status, Object.fromEntries(out.headers));
    return res.end(Buffer.from(await out.arrayBuffer()));
  }
  let file = url.pathname.replace(/^\/+/, '');
  if (!file || /^[gj]\/[^/]+$/.test(file)) file = 'index.html';
  const full = path.join(here, 'web', file);
  if (!full.startsWith(path.join(here, 'web')) || !fs.existsSync(full) || fs.statSync(full).isDirectory()) { res.writeHead(404); return res.end('Not found'); }
  res.writeHead(200, { 'Content-Type': TYPES[file.split('.').pop()] || 'application/octet-stream', 'Cache-Control': 'no-store' });
  res.end(fs.readFileSync(full));
}).listen(port, async () => {
  await seed();
  console.log(`Muster on http://localhost:${port}  (made-up group: http://localhost:${port}/g/${DEMO})`);
});
