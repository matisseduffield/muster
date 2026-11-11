# Muster

Who's free this weekend. A friend group marks Friday night, Saturday and Sunday
(day and night) as free, maybe or busy, and everyone sees the same board.

- A group has a name and a private link (https://muster.teloone.au/g/…). Anyone
  with the link opens it in a browser, types their name and answers. No accounts.
- Invite shows a join code: four capital letters, good for a week, renewed each
  time Invite is opened. Friends enter it under Join a group, or open
  https://muster.teloone.au/j/CODE. Wrong guesses are cut off at ten an hour.
- Eight weekends ahead (four shown, the rest behind a link), five slots each.
  Each slot shows how many are free and a Free / Maybe / Busy answer; tap the
  slot for names. No answer is kept apart from busy.
- Events: anyone posts one on a slot and the group answers Going / Maybe / No.
- Looks like the rest of the family (Tally's paper, ink and type).
- The rules and the server still carry a per-person "usual weekend"; nothing in
  the app sets it now.
- Works offline: the board lives on the device, changes queue and sync later.

## Layout

- `web/index.html`: the whole app (HTML/CSS/JS, no build step).
- `web/lib.js`: the rules (weekends, answers, counts), tested by `node --test`.
- `web/sw.js`: opens the site with no signal. Network first, and it only touches
  the files it names: never `/api/`, and never a `/g/` address.
- `worker/worker.js`, `worker/schema.sql`: the server, a Cloudflare Worker named
  `muster` with a D1 database `muster` (binding `DB`). It also serves the web app,
  fetching it from the public `muster-releases` repo under `web/`.
- `dev.mjs`: a local server with a demo group (`node dev.mjs 5186`).

## The server

`GET /api/g/<id>` returns a group, with an ETag of its version (304 when unchanged).
`POST /api/g/<id>/code` returns the group's join code, `GET /api/code/<code>` the
group it leads to.
`POST /api/g/<id>/ops` applies a list of changes and returns the group. A group's
22-character id is its secret. A daily cron drops weekends more than 35 days old.

## Releasing

1. `node --test` from this folder.
2. If `lib.js` changed, raise its `?v=` in `index.html`.
3. Copy `web/` into `muster-releases/web/` and push. The site follows within five minutes.
4. If the Worker changed: copy `worker/worker.js` beside `APPS/deploy/muster/wrangler.toml`
   and deploy as that file says.
