-- Muster's store (Cloudflare D1). A group's id is its secret link. Ids for
-- members and plans come from the phones, so things made offline keep their
-- identity. A week is the date of its Friday; a member's answers for one
-- weekend are five characters, one per slot (Fri night, Sat day, Sat night,
-- Sun day, Sun night): f free, m maybe, b busy, - no answer.
CREATE TABLE IF NOT EXISTS groups (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  version INTEGER NOT NULL DEFAULT 1,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS members (
  id TEXT PRIMARY KEY,
  group_id TEXT NOT NULL,
  name TEXT NOT NULL,
  usual TEXT NOT NULL DEFAULT '-----', -- what they usually are, for weekends not answered
  removed INTEGER NOT NULL DEFAULT 0,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS members_group ON members (group_id);
CREATE TABLE IF NOT EXISTS marks (
  member_id TEXT NOT NULL,
  week TEXT NOT NULL,
  group_id TEXT NOT NULL,
  slots TEXT NOT NULL,
  updated_at INTEGER NOT NULL,
  PRIMARY KEY (member_id, week)
);
CREATE INDEX IF NOT EXISTS marks_group ON marks (group_id, week);
CREATE INDEX IF NOT EXISTS marks_week ON marks (week);
-- A plan someone has called for one slot of one weekend.
CREATE TABLE IF NOT EXISTS plans (
  id TEXT PRIMARY KEY,
  group_id TEXT NOT NULL,
  week TEXT NOT NULL,
  slot INTEGER NOT NULL,
  text TEXT NOT NULL,
  by_id TEXT NOT NULL,
  deleted INTEGER NOT NULL DEFAULT 0,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  mask INTEGER NOT NULL DEFAULT 0 -- its slots as bits when it runs over more than one
);
CREATE INDEX IF NOT EXISTS plans_group ON plans (group_id, week);
CREATE INDEX IF NOT EXISTS plans_week ON plans (week);
CREATE TABLE IF NOT EXISTS rsvps (
  plan_id TEXT NOT NULL,
  member_id TEXT NOT NULL,
  group_id TEXT NOT NULL,
  state TEXT NOT NULL, -- in | maybe | out
  updated_at INTEGER NOT NULL,
  part INTEGER NOT NULL DEFAULT 0, -- the slots they can make, as bits; 0 is all of it
  PRIMARY KEY (plan_id, member_id)
);
CREATE INDEX IF NOT EXISTS rsvps_group ON rsvps (group_id);
-- A join code: four capital letters that lead to a group until they expire.
CREATE TABLE IF NOT EXISTS codes (
  code TEXT PRIMARY KEY,
  group_id TEXT NOT NULL,
  expires INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS codes_group ON codes (group_id);
-- Wrong guesses at a code in the last hour, by a stub of the asker's hashed address.
CREATE TABLE IF NOT EXISTS guesses (
  who TEXT PRIMARY KEY,
  n INTEGER NOT NULL,
  since INTEGER NOT NULL
);
