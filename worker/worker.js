// Muster's server: a Cloudflare Worker with a D1 database (binding DB).
//
//   GET  /api/g/:id       the whole group: { group, members, marks, plans }
//   POST /api/g/:id/ops   apply changes { ops: [...] }, answer with the group
//   POST /api/g/:id/code  the group's join code: { code, until }
//   GET  /api/code/:code  the group a join code leads to: { id }
//   GET  /app          the latest Android app (a redirect to the APK)
//   GET  /, /g/:id, /j/:code, ...   the web app, served from the public muster-releases repo
//   scheduled             the daily Cron Trigger: forget weekends long past
//
// There are no accounts: a group's 22-character random id is its link, and
// anyone holding it can read and change the group. Responses carry the group's
// version as an ETag, so polling an unchanged group costs a 304.
//
// A join code is four capital letters that lead to a group for a week, so a
// group can be read out or typed. One group has one live code; asking again
// returns it and gives it another week. Codes are short, so wrong guesses are
// counted per network address (kept only as a scrambled stub) and cut off.
//
// Ops (anything malformed is skipped, so one bad change can't jam a phone's queue):
//   { t: 'group', name }                      start the group, or rename it
//   { t: 'member', id, name?, usual?, removed? }
//   { t: 'mark', m, w, i, v }                 member m, week w (its Friday), slot i 0-4, v one of f m b -
//   { t: 'plan', id, w, i, text, by, s? }     call a plan; { t: 'plan', id, deleted: true } scraps it.
//                                             s: its slots as bits when it runs over more than one
//   { t: 'rsvp', p, m, v, s? }                v: in | maybe | out | '' (no answer). s: the slots they can make, as bits
// Schema in schema.sql.

const WEB = 'https://raw.githubusercontent.com/matisseduffield/muster-releases/main/web/';
const APK = 'https://raw.githubusercontent.com/matisseduffield/muster-releases/main/Muster.apk';
const ID = /^[A-Za-z0-9_-]{22}$/;
const DATE = /^\d{4}-\d{2}-\d{2}$/;
const SLOTS = /^[fmb-]{5}$/;
const MAX_OPS = 200;
const MAX_BODY = 64 * 1024;
const MAX_MEMBERS = 40;
const MAX_PLANS = 100;
const DAY = 24 * 60 * 60 * 1000;
// Weekends are sent while they are at most this old, and forgotten after KEEP_DAYS.
const SHOW_DAYS = 10;
const KEEP_DAYS = 35;
const AHEAD_DAYS = 400;
// Join codes: no vowels, so they never spell anything.
const LETTERS = 'BCDFGHJKLMNPQRSTVWXZ';
const CODE = /^[BCDFGHJKLMNPQRSTVWXZ]{4}$/;
const CODE_DAYS = 7;
const GUESSES = 10;
const HOUR = 60 * 60 * 1000;

const CORS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type, If-None-Match',
  'Access-Control-Expose-Headers': 'ETag',
  'Access-Control-Max-Age': '86400',
};
// Group links are secrets: never leak them in a Referer, never index them.
const PRIVATE = { 'Referrer-Policy': 'no-referrer', 'X-Robots-Tag': 'noindex', 'X-Content-Type-Options': 'nosniff' };

// The iPhone app, so links to groups open in it. Apple reads this once per install.
const APPLE_LINKS = {
  applinks: { details: [{ appIDs: ['4CN49LRZ9H.com.matisseduffield.muster'], components: [{ '/': '/g/*' }, { '/': '/j/*' }] }] },
};

// The Android app, likewise: the fingerprint of the key its builds are signed with.
const ANDROID_LINKS = [{
  relation: ['delegate_permission/common.handle_all_urls'],
  target: {
    namespace: 'android_app',
    package_name: 'com.matisseduffield.muster',
    sha256_cert_fingerprints: ['C9:A9:3E:D3:E7:AC:D0:C2:63:8A:98:F5:32:E6:F7:A6:93:9D:9B:F5:6B:83:60:DD:5F:ED:8D:94:D9:76:3D:02'],
  },
}];

const json = (body, status = 200, headers = {}) =>
  new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json', 'Cache-Control': 'no-store', ...CORS, ...PRIVATE, ...headers } });
const fail = (status, error) => json({ error }, status);
const dateKey = ms => new Date(ms).toISOString().slice(0, 10);

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    if (request.method === 'OPTIONS') return new Response(null, { status: 204, headers: CORS });
    try {
      const api = url.pathname.match(/^\/api\/g\/([^/]+)(\/ops|\/code)?$/);
      if (api) {
        const id = api[1];
        if (!ID.test(id)) return fail(404, 'No such group');
        if (request.method === 'GET' && !api[2]) return getGroup(env, id, request);
        if (request.method === 'POST' && api[2] === '/ops') return applyOps(env, id, request);
        if (request.method === 'POST' && api[2] === '/code') return groupCode(env, id);
        return fail(405, 'Not allowed');
      }
      const code = url.pathname.match(/^\/api\/code\/([^/]+)$/);
      if (code) return request.method === 'GET' ? findCode(env, code[1], request) : fail(405, 'Not allowed');
      if (url.pathname === '/.well-known/apple-app-site-association') return json(APPLE_LINKS, 200, { 'Cache-Control': 'public, max-age=3600' });
      if (url.pathname === '/.well-known/assetlinks.json') return json(ANDROID_LINKS, 200, { 'Cache-Control': 'public, max-age=3600' });
      if (url.pathname === '/app') return new Response(null, { status: 302, headers: { Location: APK, 'Cache-Control': 'no-store', ...PRIVATE } });
      if (request.method === 'GET') return serveWeb(url.pathname, url.search);
      return fail(405, 'Not allowed');
    } catch (e) {
      return fail(500, 'Something went wrong');
    }
  },
  async scheduled(event, env) {
    const old = dateKey(Date.now() - KEEP_DAYS * DAY);
    await env.DB.batch([
      env.DB.prepare('DELETE FROM marks WHERE week < ?').bind(old),
      env.DB.prepare('DELETE FROM rsvps WHERE plan_id IN (SELECT id FROM plans WHERE week < ?)').bind(old),
      env.DB.prepare('DELETE FROM plans WHERE week < ?').bind(old),
      env.DB.prepare('DELETE FROM codes WHERE expires <= ?').bind(Date.now()),
      env.DB.prepare('DELETE FROM guesses WHERE since <= ?').bind(Date.now() - HOUR),
    ]);
  },
};

async function readGroup(env, id, now) {
  const from = dateKey(now - SHOW_DAYS * DAY);
  const [g, members, marks, plans, rsvps] = await env.DB.batch([
    env.DB.prepare('SELECT id, name, version FROM groups WHERE id = ?').bind(id),
    env.DB.prepare('SELECT id, name, usual FROM members WHERE group_id = ? AND removed = 0 ORDER BY created_at, id').bind(id),
    env.DB.prepare('SELECT member_id, week, slots FROM marks WHERE group_id = ? AND week >= ?').bind(id, from),
    env.DB.prepare('SELECT id, week, slot, mask, text, by_id, created_at FROM plans WHERE group_id = ? AND deleted = 0 AND week >= ? ORDER BY created_at, id').bind(id, from),
    env.DB.prepare('SELECT plan_id, member_id, state, part FROM rsvps WHERE group_id = ? AND plan_id IN (SELECT id FROM plans WHERE group_id = ? AND deleted = 0 AND week >= ?)').bind(id, id, from),
  ]);
  if (!g.results.length) return null;
  const here = new Set(members.results.map(m => m.id));
  const byMember = {};
  for (const r of marks.results) if (here.has(r.member_id)) (byMember[r.member_id] ||= {})[r.week] = r.slots;
  const byPlan = {};
  const masks = {}, parts = {};
  for (const p of plans.results) if (many(p.mask)) masks[p.id] = p.mask;
  for (const r of rsvps.results) if (here.has(r.member_id)) {
    (byPlan[r.plan_id] ||= {})[r.member_id] = r.state;
    // Only part of a longer event: kept when it names some, not all, of the event's slots.
    const some = r.part & (masks[r.plan_id] || 0);
    if (some && some !== masks[r.plan_id]) (parts[r.plan_id] ||= {})[r.member_id] = some;
  }
  return {
    group: g.results[0],
    members: members.results,
    marks: byMember,
    plans: plans.results.map(p => ({ id: p.id, w: p.week, i: p.slot, text: p.text, by: p.by_id, at: p.created_at, rsvp: byPlan[p.id] || {}, ...(masks[p.id] ? { s: masks[p.id] } : {}), ...(parts[p.id] ? { part: parts[p.id] } : {}) })),
  };
}

const sameTag = (a, b) => !!a && a.replace(/^W\//, '') === b;

async function getGroup(env, id, request) {
  const head = await env.DB.prepare('SELECT version FROM groups WHERE id = ?').bind(id).first();
  if (!head) return fail(404, 'No such group');
  if (sameTag(request.headers.get('If-None-Match'), `"${head.version}"`)) {
    return new Response(null, { status: 304, headers: { ETag: `"${head.version}"`, ...CORS, ...PRIVATE } });
  }
  const group = await readGroup(env, id, Date.now());
  if (!group) return fail(404, 'No such group');
  return json(group, 200, { ETag: `"${group.group.version}"` });
}

function randomCode() {
  let code = '';
  while (code.length < 4) {
    // Bytes past 239 are thrown back, so every letter is as likely as the next.
    for (const b of crypto.getRandomValues(new Uint8Array(8))) if (b < 240 && code.length < 4) code += LETTERS[b % 20];
  }
  return code;
}

// The group's code: the one it has, with another week on it, or a new one.
async function groupCode(env, id) {
  const db = env.DB, now = Date.now(), until = now + CODE_DAYS * DAY;
  if (!await db.prepare('SELECT id FROM groups WHERE id = ?').bind(id).first()) return fail(404, 'No such group');
  const have = await db.prepare('SELECT code FROM codes WHERE group_id = ? AND expires > ? ORDER BY expires DESC').bind(id, now).first();
  if (have) {
    await db.batch([db.prepare('UPDATE codes SET expires = ? WHERE code = ?').bind(until, have.code)]);
    return json({ code: have.code, until });
  }
  for (let k = 0; k < 8; k++) {
    const code = randomCode();
    // A code another group still holds is left alone; one that has run out is taken over.
    const [made] = await db.batch([db.prepare(
      'INSERT INTO codes (code, group_id, expires) VALUES (?, ?, ?) ' +
      'ON CONFLICT(code) DO UPDATE SET group_id = excluded.group_id, expires = excluded.expires WHERE codes.expires <= ?'
    ).bind(code, id, until, now)]);
    if (made.meta && made.meta.changes) return json({ code, until });
  }
  return fail(503, 'Try again');
}

// Who is asking, without keeping their address: a stub of its hash. An IPv6
// address counts by its network, since one phone can hold a great many.
async function asker(request) {
  let ip = request.headers.get('CF-Connecting-IP') || 'local';
  if (ip.includes(':')) ip = ip.split(':').slice(0, 4).join(':');
  const hash = await crypto.subtle.digest('SHA-256', new TextEncoder().encode('muster ' + ip));
  return [...new Uint8Array(hash)].slice(0, 8).map(b => b.toString(16).padStart(2, '0')).join('');
}

async function findCode(env, raw, request) {
  const db = env.DB, now = Date.now();
  const who = await asker(request);
  const tries = await db.prepare('SELECT n FROM guesses WHERE who = ? AND since > ?').bind(who, now - HOUR).first();
  if (tries && tries.n >= GUESSES) return fail(429, 'Too many tries');
  const code = String(raw).toUpperCase();
  const hit = CODE.test(code) ? await db.prepare('SELECT group_id FROM codes WHERE code = ? AND expires > ?').bind(code, now).first() : null;
  if (hit) return json({ id: hit.group_id });
  // A miss counts; the count starts again an hour after its first.
  await db.batch([db.prepare(
    'INSERT INTO guesses (who, n, since) VALUES (?, 1, ?) ON CONFLICT(who) DO UPDATE SET ' +
    'n = CASE WHEN guesses.since <= ? THEN 1 ELSE guesses.n + 1 END, since = CASE WHEN guesses.since <= ? THEN excluded.since ELSE guesses.since END'
  ).bind(who, now, now - HOUR, now - HOUR)]);
  return fail(404, 'No such code');
}

// Letters, digits and ordinary punctuation on one line; nothing a page could trip on later.
function cleanText(s, max) {
  if (typeof s !== 'string') return '';
  return s.replace(/[\x00-\x1F\x7F\u2028\u2029]/g, ' ').replace(/\s+/g, ' ').trim().slice(0, max).trim();
}

// A weekend's Friday, not long past and not absurdly far ahead.
function goodWeek(w, now) {
  if (typeof w !== 'string' || !DATE.test(w)) return false;
  const t = Date.parse(w + 'T00:00:00Z');
  if (Number.isNaN(t) || dateKey(t) !== w || new Date(t).getUTCDay() !== 5) return false;
  return t >= now - (SHOW_DAYS + 1) * DAY && t <= now + AHEAD_DAYS * DAY;
}
// Ids must be real strings: an array holding one would pass the pattern and then break the query.
const isId = v => typeof v === 'string' && ID.test(v);
const goodSlot = i => Number.isInteger(i) && i >= 0 && i <= 4;
const goodMask = m => Number.isInteger(m) && m >= 1 && m <= 31;
const many = m => goodMask(m) && (m & (m - 1)) !== 0;
const lowest = m => Math.log2(m & -m);

async function applyOps(env, id, request) {
  const raw = await request.text();
  if (raw.length > MAX_BODY) return fail(413, 'Too much at once');
  let body;
  try { body = JSON.parse(raw); } catch { return fail(400, 'Not JSON'); }
  const ops = body && body.ops;
  if (!Array.isArray(ops) || !ops.length || ops.length > MAX_OPS) return fail(400, 'Bad changes');

  const now = Date.now();
  const db = env.DB;
  const [g, mem, pl] = await db.batch([
    db.prepare('SELECT id FROM groups WHERE id = ?').bind(id),
    db.prepare('SELECT id, removed FROM members WHERE group_id = ?').bind(id),
    db.prepare('SELECT id, deleted FROM plans WHERE group_id = ?').bind(id),
  ]);
  let exists = g.results.length > 0;
  const members = new Map(mem.results.map(m => [m.id, !m.removed]));
  const plans = new Map(pl.results.map(p => [p.id, !p.deleted]));
  const live = map => [...map.values()].filter(Boolean).length;
  const out = [];

  for (const op of ops) {
    if (!op || typeof op !== 'object') continue;
    if (op.t === 'group') {
      const name = cleanText(op.name, 40);
      if (!name) continue;
      if (exists) out.push(db.prepare('UPDATE groups SET name = ? WHERE id = ?').bind(name, id));
      else out.push(db.prepare('INSERT INTO groups (id, name, version, created_at, updated_at) VALUES (?, ?, 0, ?, ?)').bind(id, name, now, now));
      exists = true;
      continue;
    }
    if (!exists) continue;
    if (op.t === 'member') {
      if (!isId(op.id)) continue;
      const name = op.name === undefined ? null : cleanText(op.name, 24) || null;
      const usual = typeof op.usual === 'string' && SLOTS.test(op.usual) ? op.usual : null;
      const removed = op.removed === undefined ? null : op.removed ? 1 : 0;
      if (!members.has(op.id)) {
        if (!name || live(members) >= MAX_MEMBERS) continue;
        // An id already used in another group stays theirs: nothing is added here.
        out.push(db.prepare('INSERT INTO members (id, group_id, name, usual, removed, created_at, updated_at) VALUES (?, ?, ?, ?, 0, ?, ?) ON CONFLICT(id) DO NOTHING')
          .bind(op.id, id, name, usual || '-----', now, now));
        members.set(op.id, true);
      } else {
        if (removed === 0 && !members.get(op.id) && live(members) >= MAX_MEMBERS) continue;
        out.push(db.prepare('UPDATE members SET name = COALESCE(?, name), usual = COALESCE(?, usual), removed = COALESCE(?, removed), updated_at = ? WHERE id = ? AND group_id = ?')
          .bind(name, usual, removed, now, op.id, id));
        if (removed !== null) members.set(op.id, !removed);
      }
    } else if (op.t === 'mark') {
      if (!members.get(op.m) || !goodWeek(op.w, now) || !goodSlot(op.i) || typeof op.v !== 'string' || !/^[fmb-]$/.test(op.v)) continue;
      const fresh = '-----'.slice(0, op.i) + op.v + '-----'.slice(op.i + 1);
      out.push(db.prepare(
        'INSERT INTO marks (member_id, week, group_id, slots, updated_at) VALUES (?, ?, ?, ?, ?) ' +
        'ON CONFLICT(member_id, week) DO UPDATE SET slots = substr(slots, 1, ?) || ? || substr(slots, ?), updated_at = excluded.updated_at WHERE group_id = excluded.group_id'
      ).bind(op.m, op.w, id, fresh, now, op.i, op.v, op.i + 2));
    } else if (op.t === 'plan') {
      if (!isId(op.id)) continue;
      if (op.deleted) {
        if (!plans.has(op.id)) continue;
        out.push(db.prepare('UPDATE plans SET deleted = 1, updated_at = ? WHERE id = ? AND group_id = ?').bind(now, op.id, id));
        plans.set(op.id, false);
        continue;
      }
      const text = cleanText(op.text, 80);
      // Over several slots, the first one is its slot, so older apps still show it.
      const mask = many(op.s) ? op.s : 0, slot = mask ? lowest(mask) : op.i;
      if (!text || !members.get(op.by) || !goodWeek(op.w, now) || !goodSlot(slot)) continue;
      if (!plans.has(op.id) && live(plans) >= MAX_PLANS) continue;
      out.push(db.prepare(
        'INSERT INTO plans (id, group_id, week, slot, mask, text, by_id, deleted, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, 0, ?, ?) ' +
        'ON CONFLICT(id) DO UPDATE SET week = excluded.week, slot = excluded.slot, mask = excluded.mask, text = excluded.text, deleted = 0, updated_at = excluded.updated_at WHERE group_id = excluded.group_id'
      ).bind(op.id, id, op.w, slot, mask, text, op.by, now, now));
      plans.set(op.id, true);
    } else if (op.t === 'rsvp') {
      if (!plans.get(op.p) || !members.get(op.m)) continue;
      if (op.v === 'in' || op.v === 'maybe' || op.v === 'out') {
        out.push(db.prepare(
          'INSERT INTO rsvps (plan_id, member_id, group_id, state, part, updated_at) VALUES (?, ?, ?, ?, ?, ?) ' +
          'ON CONFLICT(plan_id, member_id) DO UPDATE SET state = excluded.state, part = excluded.part, updated_at = excluded.updated_at WHERE group_id = excluded.group_id'
        ).bind(op.p, op.m, id, op.v, goodMask(op.s) ? op.s : 0, now));
      } else if (op.v === '') {
        out.push(db.prepare('DELETE FROM rsvps WHERE plan_id = ? AND member_id = ? AND group_id = ?').bind(op.p, op.m, id));
      }
    }
  }

  if (!exists) return fail(404, 'No such group');
  if (out.length) {
    out.push(db.prepare('UPDATE groups SET version = version + 1, updated_at = ? WHERE id = ?').bind(now, id));
    await db.batch(out);
  }
  const group = await readGroup(env, id, now);
  return json(group, 200, { ETag: `"${group.group.version}"` });
}

const TYPES = { html: 'text/html; charset=utf-8', js: 'text/javascript; charset=utf-8', json: 'application/json', woff2: 'font/woff2', svg: 'image/svg+xml', png: 'image/png' };
async function serveWeb(path, search = '') {
  let file = path.replace(/^\/+/, '');
  if (!file || /^[gj]\/[^/]+$/.test(file)) file = 'index.html';
  if (!/^[a-z0-9-]+(\/[a-z0-9-]+)*\.(html|js|json|woff2|svg|png)$/.test(file)) return fail(404, 'Not found');
  const version = /^\?v=\d+$/.test(search) ? search : '';
  const res = await fetch(WEB + file + version, { cf: { cacheTtl: 300, cacheEverything: true } });
  if (!res.ok) return fail(404, 'Not found');
  const type = TYPES[file.split('.').pop()];
  // The page is checked every time, so it and the versions it names arrive together.
  const cache = file.endsWith('.html') ? 'no-cache' : version || file.endsWith('.woff2') ? 'public, max-age=604800' : 'public, max-age=60';
  return new Response(res.body, { headers: { 'Content-Type': type, 'Cache-Control': cache, ...PRIVATE } });
}
