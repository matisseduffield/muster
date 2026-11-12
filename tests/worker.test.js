// The real Worker against a real SQLite database built from schema.sql, in
// memory. Nothing here touches the network or the live database.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { DatabaseSync } = require('node:sqlite');
const L = require('../web/lib.js');

const read = file => fs.readFileSync(path.join(__dirname, '../worker', file), 'utf8');
const load = () => import('data:text/javascript;base64,' + Buffer.from(read('worker.js')).toString('base64')).then(m => m.default);

function fakeD1() {
  const db = new DatabaseSync(':memory:');
  db.exec(read('schema.sql'));
  const statement = (sql, args = []) => ({
    bind: (...next) => statement(sql, next),
    first: async () => db.prepare(sql).get(...args) ?? null,
    run: () => (/^\s*(SELECT|WITH)/i.test(sql) ? { results: db.prepare(sql).all(...args) } : { results: [], meta: db.prepare(sql).run(...args) }),
  });
  return {
    prepare: sql => statement(sql),
    async batch(stmts) {
      db.exec('BEGIN');
      try { const out = stmts.map(s => s.run()); db.exec('COMMIT'); return out; }
      catch (e) { db.exec('ROLLBACK'); throw e; }
    },
    raw: db,
  };
}

const G = 'g'.repeat(22), G2 = 'h'.repeat(22), ME = 'm'.repeat(22), YOU = 'y'.repeat(22), P = 'p'.repeat(22);
const W = L.weeks(new Date(), 2)[1];

async function setup() {
  const env = { DB: fakeD1() };
  const worker = await load();
  const call = async (method, url, { body, headers } = {}) => {
    const res = await worker.fetch(new Request('https://x.test' + url, { method, headers, body: body === undefined ? undefined : JSON.stringify(body) }), env);
    const text = await res.text();
    return { status: res.status, headers: res.headers, body: text ? JSON.parse(text) : null };
  };
  const post = (ops, id = G) => call('POST', `/api/g/${id}/ops`, { body: { ops } });
  const get = (id = G, headers) => call('GET', `/api/g/${id}`, { headers });
  const start = () => post([{ t: 'group', name: 'Crew' }, { t: 'member', id: ME, name: 'Me' }, { t: 'member', id: YOU, name: 'You' }]);
  return { env, worker, call, post, get, start };
}

test('a group starts with its name and people', async () => {
  const { start, get } = await setup();
  const made = await start();
  assert.equal(made.status, 200);
  assert.equal(made.body.group.name, 'Crew');
  assert.deepEqual(made.body.members.map(m => m.name), ['Me', 'You']);
  assert.equal((await get()).body.group.version, 1);
});

test('an unknown group is a 404, for reads and for changes', async () => {
  const { get, post } = await setup();
  assert.equal((await get()).status, 404);
  assert.equal((await post([{ t: 'member', id: ME, name: 'Me' }])).status, 404);
  assert.equal((await get('short')).status, 404);
});

test('answers are kept slot by slot', async () => {
  const { start, post } = await setup();
  await start();
  await post([{ t: 'mark', m: ME, w: W, i: 0, v: 'f' }, { t: 'mark', m: ME, w: W, i: 4, v: 'b' }]);
  const r = await post([{ t: 'mark', m: ME, w: W, i: 2, v: 'm' }, { t: 'mark', m: YOU, w: W, i: 2, v: 'f' }]);
  assert.equal(r.body.marks[ME][W], 'f-m-b');
  assert.equal(r.body.marks[YOU][W], '--f--');
  const cleared = await post([{ t: 'mark', m: ME, w: W, i: 0, v: '-' }]);
  assert.equal(cleared.body.marks[ME][W], '--m-b');
});

test('bad changes are skipped without failing the rest', async () => {
  const { start, post } = await setup();
  await start();
  const thursday = L.addDays(W, -1);
  const r = await post([
    { t: 'mark', m: ME, w: thursday, i: 0, v: 'f' },
    { t: 'mark', m: ME, w: W, i: 5, v: 'f' },
    { t: 'mark', m: ME, w: W, i: 1, v: 'x' },
    { t: 'mark', m: 'z'.repeat(22), w: W, i: 1, v: 'f' },
    { t: 'mark', m: ME, w: '2020-01-03', i: 1, v: 'f' },
    null, 'nope', { t: 'who' },
    { t: 'mark', m: ME, w: W, i: 3, v: 'f' },
  ]);
  assert.equal(r.status, 200);
  assert.deepEqual(r.body.marks, { [ME]: { [W]: '---f-' } });
});

test('an unchanged group polls as 304', async () => {
  const { start, get, post } = await setup();
  await start();
  const first = await get();
  const tag = first.headers.get('ETag');
  assert.equal((await get(G, { 'If-None-Match': tag })).status, 304);
  await post([{ t: 'mark', m: ME, w: W, i: 0, v: 'f' }]);
  assert.equal((await get(G, { 'If-None-Match': tag })).status, 200);
});

test('renaming, a usual, and leaving', async () => {
  const { start, post, env } = await setup();
  await start();
  await post([{ t: 'mark', m: YOU, w: W, i: 0, v: 'f' }]);
  const r = await post([{ t: 'group', name: '  The   Crew ' }, { t: 'member', id: ME, name: 'Mat', usual: 'f-f--' }, { t: 'member', id: YOU, removed: true }]);
  assert.equal(r.body.group.name, 'The Crew');
  assert.deepEqual(r.body.members, [{ id: ME, name: 'Mat', usual: 'f-f--' }]);
  assert.deepEqual(r.body.marks, {});
  // Someone who left can't answer, and nothing of them is kept.
  assert.deepEqual((await post([{ t: 'mark', m: YOU, w: W, i: 1, v: 'f' }])).body.marks, {});
  assert.equal(env.DB.raw.prepare('SELECT COUNT(*) AS n FROM members WHERE id = ?').get(YOU).n, 0);
  assert.equal(env.DB.raw.prepare('SELECT COUNT(*) AS n FROM marks WHERE member_id = ?').get(YOU).n, 0);
  // Asking to be put back does nothing; joining again starts fresh.
  assert.equal((await post([{ t: 'member', id: YOU, removed: false }])).body.members.length, 1);
  const back = await post([{ t: 'member', id: YOU, name: 'You' }]);
  assert.deepEqual(back.body.marks, {});
  assert.equal(back.body.members.length, 2);
});

test('leaving takes replies along and leaves the plan unnamed', async () => {
  const { start, post, env } = await setup();
  await start();
  await post([{ t: 'plan', id: P, w: W, i: 1, text: 'Beach', by: YOU }, { t: 'rsvp', p: P, m: YOU, v: 'in' }, { t: 'rsvp', p: P, m: ME, v: 'in' }]);
  const r = await post([{ t: 'member', id: YOU, removed: true }]);
  assert.deepEqual(r.body.plans[0].rsvp, { [ME]: 'in' });
  assert.equal(r.body.plans[0].by, YOU);
  assert.equal(env.DB.raw.prepare('SELECT COUNT(*) AS n FROM rsvps').get().n, 1);
});

test('deleting a group erases it for everyone and it cannot come back', async () => {
  const { start, post, get, call, env } = await setup();
  await start();
  await post([{ t: 'mark', m: ME, w: W, i: 0, v: 'f' }, { t: 'plan', id: P, w: W, i: 1, text: 'Beach', by: ME }, { t: 'rsvp', p: P, m: ME, v: 'in' }]);
  const code = (await call('POST', `/api/g/${G}/code`)).body.code;
  assert.deepEqual((await call('POST', `/api/g/${G}/delete`)).body, { deleted: true });
  for (const t of ['members', 'marks', 'plans', 'rsvps', 'codes']) assert.equal(env.DB.raw.prepare(`SELECT COUNT(*) AS n FROM ${t}`).get().n, 0, t);
  assert.equal(env.DB.raw.prepare('SELECT name FROM groups WHERE id = ?').get(G).name, '');
  assert.equal((await get()).status, 404);
  assert.equal((await call('GET', `/api/code/${code}`)).status, 404);
  assert.equal((await call('POST', `/api/g/${G}/code`)).status, 404);
  assert.equal((await call('POST', `/api/g/${G}/delete`)).status, 404);
  // A phone's queued changes, even ones that start a group, don't revive it.
  assert.equal((await post([{ t: 'group', name: 'Crew' }, { t: 'member', id: ME, name: 'Me' }])).status, 404);
  assert.equal((await get()).status, 404);
  // Another group is untouched.
  await post([{ t: 'group', name: 'Other' }], G2);
  assert.equal((await get(G2)).status, 200);
});

test('the word filter stars out listed words and leaves the rest', async () => {
  const { start, post } = await setup();
  await start();
  const r = await post([
    { t: 'group', name: 'The filtertestword crew' },
    { t: 'member', id: ME, name: 'F1lt3rtestw0rds!' },
    { t: 'plan', id: P, w: W, i: 1, text: 'Pub, then FILTERTESTWORDDD. Scunthorpe after', by: ME },
  ]);
  assert.equal(r.body.group.name, 'The *** crew');
  assert.equal(r.body.members[0].name, '***');
  assert.equal(r.body.plans[0].text, 'Pub, then *** Scunthorpe after');
});

test('the nightly tidy erases people removed before leaving erased them', async () => {
  const { start, post, get, worker, env } = await setup();
  await start();
  await post([{ t: 'mark', m: YOU, w: W, i: 0, v: 'f' }]);
  env.DB.raw.prepare('UPDATE members SET removed = 1 WHERE id = ?').run(YOU);
  assert.equal((await post([{ t: 'member', id: YOU, name: 'Back' }])).body.members.length, 1);
  await worker.scheduled({}, env);
  assert.equal(env.DB.raw.prepare('SELECT COUNT(*) AS n FROM members').get().n, 1);
  assert.equal(env.DB.raw.prepare('SELECT COUNT(*) AS n FROM marks').get().n, 0);
  assert.equal((await get()).body.members.length, 1);
});

test('plans: called, answered, scrapped', async () => {
  const { start, post } = await setup();
  await start();
  let r = await post([{ t: 'plan', id: P, w: W, i: 2, text: 'Pub at 7', by: ME }, { t: 'rsvp', p: P, m: ME, v: 'in' }, { t: 'rsvp', p: P, m: YOU, v: 'out' }]);
  assert.equal(r.body.plans.length, 1);
  assert.deepEqual({ ...r.body.plans[0], at: 0 }, { id: P, w: W, i: 2, text: 'Pub at 7', by: ME, at: 0, rsvp: { [ME]: 'in', [YOU]: 'out' } });
  r = await post([{ t: 'rsvp', p: P, m: YOU, v: '' }, { t: 'rsvp', p: P, m: ME, v: 'sure' }]);
  assert.deepEqual(r.body.plans[0].rsvp, { [ME]: 'in' });
  r = await post([{ t: 'rsvp', p: P, m: YOU, v: 'maybe' }]);
  assert.deepEqual(r.body.plans[0].rsvp, { [ME]: 'in', [YOU]: 'maybe' });
  r = await post([{ t: 'plan', id: P, deleted: true }, { t: 'rsvp', p: P, m: YOU, v: 'in' }]);
  assert.deepEqual(r.body.plans, []);
});

test("one group can't write into another", async () => {
  const { start, post, get } = await setup();
  await start();
  await post([{ t: 'mark', m: ME, w: W, i: 0, v: 'f' }, { t: 'plan', id: P, w: W, i: 0, text: 'Ours', by: ME }]);
  await post([{ t: 'group', name: 'Other' }, { t: 'member', id: ME, name: 'Thief' }, { t: 'mark', m: ME, w: W, i: 0, v: 'b' }, { t: 'plan', id: P, w: W, i: 1, text: 'Theirs', by: ME }], G2);
  const ours = (await get()).body;
  assert.equal(ours.members[0].name, 'Me');
  assert.equal(ours.marks[ME][W], 'f----');
  assert.equal(ours.plans[0].text, 'Ours');
  const theirs = (await get(G2)).body;
  assert.deepEqual(theirs.members, []);
  assert.deepEqual(theirs.plans, []);
});

test('the daily clean-up forgets weekends long past', async () => {
  const { start, post, get, worker, env } = await setup();
  await start();
  await post([{ t: 'mark', m: ME, w: W, i: 0, v: 'f' }]);
  env.DB.raw.prepare("INSERT INTO marks VALUES (?, '2020-01-03', ?, 'fffff', 0)").run(ME, G);
  env.DB.raw.prepare("INSERT INTO plans VALUES (?, ?, '2020-01-03', 0, 'Old', ?, 0, 0, 0, 0)").run(P, G, ME);
  env.DB.raw.prepare("INSERT INTO rsvps VALUES (?, ?, ?, 'in', 0, 0)").run(P, ME, G);
  await worker.scheduled({}, env);
  const n = t => env.DB.raw.prepare(`SELECT COUNT(*) AS n FROM ${t}`).get().n;
  assert.deepEqual([n('marks'), n('plans'), n('rsvps')], [1, 0, 0]);
  assert.equal((await get()).body.marks[ME][W], 'f----');
});

// ---- join codes ----

test('a group gets a four-letter code that leads back to it, and keeps it', async () => {
  const { start, call } = await setup();
  await start();
  const made = await call('POST', `/api/g/${G}/code`);
  assert.equal(made.status, 200);
  assert.match(made.body.code, /^[BCDFGHJKLMNPQRSTVWXZ]{4}$/);
  assert.ok(made.body.until > Date.now() + 6 * 24 * 60 * 60 * 1000);
  assert.equal((await call('POST', `/api/g/${G}/code`)).body.code, made.body.code);
  assert.deepEqual((await call('GET', `/api/code/${made.body.code}`)).body, { id: G });
  assert.deepEqual((await call('GET', `/api/code/${made.body.code.toLowerCase()}`)).body, { id: G });
});

test('no code for a group that does not exist', async () => {
  const { call } = await setup();
  assert.equal((await call('POST', `/api/g/${G}/code`)).status, 404);
});

test('a code that has run out leads nowhere, and the group gets a new one', async () => {
  const { start, call, env } = await setup();
  await start();
  const { code } = (await call('POST', `/api/g/${G}/code`)).body;
  env.DB.raw.prepare('UPDATE codes SET expires = ?').run(Date.now() - 1);
  assert.equal((await call('GET', `/api/code/${code}`)).status, 404);
  assert.equal((await call('POST', `/api/g/${G}/code`)).status, 200);
  assert.equal(env.DB.raw.prepare('SELECT COUNT(*) AS n FROM codes WHERE expires > ?').get(Date.now()).n, 1);
});

test('wrong guesses are cut off, and start again after an hour', async () => {
  const { start, call, env } = await setup();
  await start();
  const { code } = (await call('POST', `/api/g/${G}/code`)).body;
  const wrong = code === 'BBBB' ? 'CCCC' : 'BBBB';
  for (let k = 0; k < 10; k++) assert.equal((await call('GET', `/api/code/${wrong}`)).status, 404);
  assert.equal((await call('GET', `/api/code/${wrong}`)).status, 429);
  assert.equal((await call('GET', `/api/code/${code}`)).status, 429);
  // Someone else is not held up.
  assert.equal((await call('GET', `/api/code/${code}`, { headers: { 'CF-Connecting-IP': '203.0.113.9' } })).status, 200);
  env.DB.raw.prepare('UPDATE guesses SET since = ?').run(Date.now() - 61 * 60 * 1000);
  assert.equal((await call('GET', `/api/code/${code}`)).status, 200);
  assert.equal((await call('GET', `/api/code/${wrong}`)).status, 404);
  assert.equal(env.DB.raw.prepare('SELECT n FROM guesses').get().n, 1);
});

test('rubbish in place of a code is a miss, not an error', async () => {
  const { call } = await setup();
  for (const bad of ['AEIO', 'BCD', 'BCDFG', '%27--', 'B1CD']) assert.equal((await call('GET', `/api/code/${bad}`)).status, 404);
});

test('the daily clean-up drops codes and guesses that have run out', async () => {
  const { start, call, env, worker } = await setup();
  await start();
  await call('POST', `/api/g/${G}/code`);
  await call('GET', '/api/code/BBBB');
  env.DB.raw.prepare('UPDATE codes SET expires = 1').run();
  env.DB.raw.prepare('UPDATE guesses SET since = 1').run();
  await worker.scheduled({}, env);
  assert.equal(env.DB.raw.prepare('SELECT COUNT(*) AS n FROM codes').get().n, 0);
  assert.equal(env.DB.raw.prepare('SELECT COUNT(*) AS n FROM guesses').get().n, 0);
});

test('an event over several slots, and who can make which part', async () => {
  const { start, post } = await setup();
  await start();
  // Sat day and Sat night: its slot is the first of them, whatever the app sent.
  let r = await post([{ t: 'plan', id: P, w: W, i: 4, s: 6, text: 'Beach then pub', by: ME }, { t: 'rsvp', p: P, m: ME, v: 'in' }, { t: 'rsvp', p: P, m: YOU, v: 'in', s: 4 }]);
  assert.deepEqual({ ...r.body.plans[0], at: 0 }, { id: P, w: W, i: 1, text: 'Beach then pub', by: ME, at: 0, rsvp: { [ME]: 'in', [YOU]: 'in' }, s: 6, part: { [YOU]: 4 } });
  // All of it, a slot it doesn't have, or rubbish: no part.
  for (const s of [6, 0, 16, 99, 'x']) {
    r = await post([{ t: 'rsvp', p: P, m: YOU, v: 'maybe', s }]);
    assert.equal(r.body.plans[0].part, undefined);
  }
  // Back to one slot.
  r = await post([{ t: 'plan', id: P, w: W, i: 2, s: 4, text: 'Pub', by: ME }]);
  assert.equal(r.body.plans[0].s, undefined);
  assert.equal(r.body.plans[0].i, 2);
  // A bad set of slots falls back to the one slot.
  r = await post([{ t: 'plan', id: P, w: W, i: 3, s: 64, text: 'Pub', by: ME }]);
  assert.equal(r.body.plans[0].s, undefined);
  assert.equal(r.body.plans[0].i, 3);
});
