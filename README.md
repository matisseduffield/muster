# Muster

Who's free this weekend. A friend group marks Friday night, Saturday and Sunday
(day and night) as free, maybe or busy, and everyone sees the same board.

- A group has a name and a private link (https://muster.teloone.au/g/…). Anyone
  with the link opens it in a browser, types their name and answers. No accounts.
- The next eight weekends, five slots each. No answer is kept apart from busy.
- Best bet: the slot most of the group can make.
- A usual weekend per person, used for weekends they haven't answered.
- Call a plan on a slot; people say in or out.
- Nudge: a ready-made message for whoever hasn't answered, through the share sheet.
- Works offline: the board lives on the device, changes queue and sync later.

## Layout

- `web/index.html`: the whole app (HTML/CSS/JS, no build step).
- `web/lib.js`: the rules (weekends, answers, best bet), tested by `node --test`.
- `web/sw.js`: opens the site with no signal. Network first, and it only touches
  the files it names: never `/api/`, and never a `/g/` address.
- `worker/worker.js`, `worker/schema.sql`: the server, a Cloudflare Worker named
  `muster` with a D1 database `muster` (binding `DB`). It also serves the web app,
  fetching it from the public `muster-releases` repo under `web/`.
- `dev.mjs`: a local server with a demo group (`node dev.mjs 5186`).

## The server

`GET /api/g/<id>` returns a group, with an ETag of its version (304 when unchanged).
`POST /api/g/<id>/ops` applies a list of changes and returns the group. A group's
22-character id is its secret. A daily cron drops weekends more than 35 days old.

## Releasing

1. `node --test` from this folder.
2. If `lib.js` changed, raise its `?v=` in `index.html`.
3. Copy `web/` into `muster-releases/web/` and push. The site follows within five minutes.
4. If the Worker changed: copy `worker/worker.js` beside `APPS/deploy/muster/wrangler.toml`
   and deploy as that file says.
