const test = require('node:test');
const assert = require('node:assert/strict');
const L = require('../web/lib.js');

const at = (y, m, d, h = 12) => new Date(y, m - 1, d, h);
// 2026-11-13 is a Friday.
test('which weekend it is', () => {
  assert.equal(L.weekKey(at(2026, 11, 9)), '2026-11-13');   // Monday
  assert.equal(L.weekKey(at(2026, 11, 12)), '2026-11-13');  // Thursday
  assert.equal(L.weekKey(at(2026, 11, 13)), '2026-11-13');  // Friday
  assert.equal(L.weekKey(at(2026, 11, 15, 23)), '2026-11-13'); // Sunday night
  assert.equal(L.weekKey(at(2026, 11, 16, 3)), '2026-11-13');  // small hours of Monday
  assert.equal(L.weekKey(at(2026, 11, 16, 6)), '2026-11-20');
  assert.deepEqual(L.weeks(at(2026, 12, 24), 3), ['2026-12-25', '2027-01-01', '2027-01-08']);
});

test('when a slot is over', () => {
  const w = '2026-11-13';
  assert.equal(L.isPast(w, 0, at(2026, 11, 14, 2)), false);
  assert.equal(L.isPast(w, 0, at(2026, 11, 14, 5)), true);
  assert.equal(L.isPast(w, 1, at(2026, 11, 14, 17)), false);
  assert.equal(L.isPast(w, 1, at(2026, 11, 14, 18)), true);
  assert.equal(L.isPast(w, 4, at(2026, 11, 16, 4)), false);
  assert.equal(L.isPast(w, 4, at(2026, 11, 16, 5)), true);
});

test('labels', () => {
  assert.equal(L.rangeLabel('2026-11-13'), '13–15 Nov');
  assert.equal(L.rangeLabel('2027-01-29'), '29–31 Jan');
  assert.equal(L.rangeLabel('2026-10-30'), '30 Oct – 1 Nov');
  assert.equal(L.relLabel('2026-11-13', at(2026, 11, 11)), 'This weekend');
  assert.equal(L.relLabel('2026-11-20', at(2026, 11, 11)), 'Next weekend');
  assert.equal(L.relLabel('2026-12-04', at(2026, 11, 11)), 'In 3 weeks');
  assert.equal(L.slotWhen('2026-11-13', 2), 'Sat night, 14 Nov');
  assert.equal(L.names([{ name: 'A' }, { name: 'B' }, { name: 'C' }]), 'A, B and C');
  assert.equal(L.names([{ name: 'A' }, { name: 'B' }, { name: 'C' }, { name: 'D' }, { name: 'E' }]), 'A, B and 3 more');
});

const group = () => ({
  group: { id: 'g', name: 'Crew', version: 1 },
  members: [{ id: 'a', name: 'A', usual: '-----' }, { id: 'b', name: 'B', usual: 'f----' }, { id: 'c', name: 'C', usual: '-----' }],
  marks: { a: { '2026-11-13': 'ffb--' }, b: { '2026-11-13': '-fm--' }, c: { '2026-11-13': '-f---' } },
  plans: [],
});

test("an answer falls back to someone's usual", () => {
  const s = group();
  assert.deepEqual(L.answer(s, 'a', '2026-11-13', 0), { v: 'f', usual: false });
  assert.deepEqual(L.answer(s, 'b', '2026-11-13', 0), { v: 'f', usual: true });
  assert.deepEqual(L.answer(s, 'c', '2026-11-13', 0), { v: '-', usual: false });
  assert.deepEqual(L.answer(s, 'b', '2026-11-20', 0), { v: 'f', usual: true });
});

test('taps go round', () => {
  assert.deepEqual(['-', 'f', 'm', 'b'].map(v => L.next(v, false)), ['f', 'm', 'b', '-']);
  assert.deepEqual(['f', 'm', 'b'].map(v => L.next(v, true)), ['m', 'b', 'f']);
});

test('the best slots, and who to wait on', () => {
  const s = group(), now = at(2026, 11, 11);
  const b = L.best(s, ['2026-11-13', '2026-11-20'], now);
  assert.deepEqual(b.map(x => [x.week, x.i, x.f, x.all]), [['2026-11-13', 1, 3, true], ['2026-11-13', 0, 2, false]]);
  assert.deepEqual(L.best(s, ['2026-11-13'], at(2026, 11, 14, 19)), []);
  assert.deepEqual(L.waiting(s, '2026-11-20', now).map(m => m.id), ['a', 'c']);
  assert.deepEqual(L.waiting(s, '2026-11-13', now), []);
  // Once Saturday is done, only C has nothing said for what's left.
  assert.deepEqual(L.waiting(s, '2026-11-13', at(2026, 11, 14, 19)).map(m => m.id), ['c']);
});

test('changes apply to the local copy', () => {
  const s = group();
  L.applyOp(s, { t: 'mark', m: 'c', w: '2026-11-20', i: 4, v: 'm' });
  assert.equal(s.marks.c['2026-11-20'], '----m');
  L.applyOp(s, { t: 'plan', id: 'p', w: '2026-11-13', i: 1, text: 'Beach', by: 'a' });
  L.applyOp(s, { t: 'rsvp', p: 'p', m: 'a', v: 'in' });
  L.applyOp(s, { t: 'rsvp', p: 'p', m: 'b', v: 'out' });
  L.applyOp(s, { t: 'rsvp', p: 'p', m: 'b', v: '' });
  assert.deepEqual(s.plans[0].rsvp, { a: 'in' });
  L.applyOp(s, { t: 'member', id: 'd', name: 'D' });
  L.applyOp(s, { t: 'member', id: 'a', removed: true });
  assert.deepEqual(s.members.map(m => m.id), ['b', 'c', 'd']);
  L.applyOp(s, { t: 'plan', id: 'p', deleted: true });
  assert.deepEqual(s.plans, []);
});

test("a weekend's dates in two pieces", () => {
  assert.deepEqual(L.rangeParts("2026-11-13"), { days: "13–15", month: "Nov" });
  assert.deepEqual(L.rangeParts("2027-01-29"), { days: "29–31", month: "Jan" });
  assert.deepEqual(L.rangeParts("2026-10-30"), { days: "30–1", month: "Oct / Nov" });
  assert.deepEqual(L.rangeParts("2027-12-31"), { days: "31–2", month: "Dec / Jan" });
});
