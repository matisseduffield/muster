// Muster's rules, apart from the page so they can be tested: which weekend is
// which, what someone's answer is, who's free when, and what a change does.
//
// A week is the date of its Friday ('2026-11-13'). Each weekend has five
// slots: 0 Fri night, 1 Sat day, 2 Sat night, 3 Sun day, 4 Sun night. An
// answer is one character: f free, m maybe, b busy, - none.
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory();
  else root.Muster = factory();
})(typeof self !== 'undefined' ? self : this, function () {
  const SLOTS = [
    { day: 'Fri', full: 'Friday', part: 'night', add: 0 },
    { day: 'Sat', full: 'Saturday', part: 'day', add: 1 },
    { day: 'Sat', full: 'Saturday', part: 'night', add: 1 },
    { day: 'Sun', full: 'Sunday', part: 'day', add: 2 },
    { day: 'Sun', full: 'Sunday', part: 'night', add: 2 },
  ];
  const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
  const BLANK = '-----';
  // A night runs until 5 the next morning; a day until 6 that evening.
  const LATE = 5, DUSK = 18;

  const pad = n => String(n).padStart(2, '0');
  const key = d => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
  const parse = k => { const [y, m, d] = k.split('-').map(Number); return new Date(y, m - 1, d); };
  const addDays = (k, n) => { const d = parse(k); d.setDate(d.getDate() + n); return key(d); };

  // The weekend on now, or the next one coming. Sunday night belongs to its
  // weekend until 5 on Monday morning.
  function weekKey(now) {
    const d = new Date(now.getTime() - LATE * 3600e3);
    d.setHours(0, 0, 0, 0);
    const off = (d.getDay() + 2) % 7; // Fri 0, Sat 1, Sun 2, Mon 3 ... Thu 6
    d.setDate(d.getDate() + (off <= 2 ? -off : 7 - off));
    return key(d);
  }
  const weeks = (now, n) => Array.from({ length: n }, (_, k) => addDays(weekKey(now), 7 * k));

  function slotEnd(week, i) {
    const night = SLOTS[i].part === 'night';
    const d = parse(week);
    d.setDate(d.getDate() + SLOTS[i].add + (night ? 1 : 0));
    d.setHours(night ? LATE : DUSK, 0, 0, 0);
    return d;
  }
  const isPast = (week, i, now) => now.getTime() >= slotEnd(week, i).getTime();
  const slotDate = (week, i) => parse(addDays(week, SLOTS[i].add));

  // "13–15 Nov", "30 Jan – 1 Feb"
  function rangeLabel(week) {
    const a = parse(week), b = parse(addDays(week, 2));
    if (a.getMonth() === b.getMonth()) return `${a.getDate()}–${b.getDate()} ${MONTHS[a.getMonth()]}`;
    return `${a.getDate()} ${MONTHS[a.getMonth()]} – ${b.getDate()} ${MONTHS[b.getMonth()]}`;
  }
  // The same, in two pieces for the page: { days: '13–15', month: 'Nov' }
  function rangeParts(week) {
    const a = parse(week), b = parse(addDays(week, 2));
    const same = a.getMonth() === b.getMonth();
    return { days: `${a.getDate()}–${b.getDate()}`, month: same ? MONTHS[a.getMonth()] : `${MONTHS[a.getMonth()]} / ${MONTHS[b.getMonth()]}` };
  }
  function relLabel(week, now) {
    const n = Math.round((parse(week) - parse(weekKey(now))) / (7 * 864e5));
    return n === 0 ? 'This weekend' : n === 1 ? 'Next weekend' : `In ${n} weeks`;
  }
  const slotName = i => `${SLOTS[i].day} ${SLOTS[i].part}`;
  const slotWhen = (week, i) => { const d = slotDate(week, i); return `${slotName(i)}, ${d.getDate()} ${MONTHS[d.getMonth()]}`; };
  // An event can run over several slots: p.s holds them as bits, p.i is the first.
  const bits = mask => SLOTS.map((_, i) => i).filter(i => mask >> i & 1);
  const maskOf = list => list.reduce((m, i) => m | 1 << i, 0);
  const planSlots = p => (p.s && bits(p.s).length ? bits(p.s) : [p.i]);
  // "Sat day and night", "Sat night and Sun day", "Sat and Sun". Within one day, short says just "night".
  function slotsName(list, short) {
    const days = [];
    for (const i of list) { const d = days.find(x => x.day === SLOTS[i].day); if (d) d.parts.push(SLOTS[i].part); else days.push({ day: SLOTS[i].day, parts: [SLOTS[i].part] }); }
    const one = days.length === 1;
    const said = days.map(d => (short ? d.parts.join(' and ') : d.parts.length === 2 && !one ? d.day : `${d.day} ${d.parts.join(' and ')}`));
    return said.length > 1 ? `${said.slice(0, -1).join(', ')} and ${said[said.length - 1]}` : said[0];
  }
  // "Sat day and night, 14 Nov", "Sat and Sun, 14–15 Nov"
  function planWhen(p) {
    const list = planSlots(p), a = slotDate(p.w, list[0]), b = slotDate(p.w, list[list.length - 1]);
    const dates = a.getTime() === b.getTime() ? `${a.getDate()} ${MONTHS[a.getMonth()]}`
      : a.getMonth() === b.getMonth() ? `${a.getDate()}–${b.getDate()} ${MONTHS[a.getMonth()]}`
      : `${a.getDate()} ${MONTHS[a.getMonth()]} – ${b.getDate()} ${MONTHS[b.getMonth()]}`;
    return `${slotsName(list)}, ${dates}`;
  }
  // The slots of an event a person can make: all of them unless they said otherwise.
  // A plan has no clock time, only the parts of the weekend it covers, so the
  // calendar entry gets ordinary hours the person can change before saving:
  // a day part runs noon to 5, a night 7 to 11.
  function planTimes(p) {
    const list = planSlots(p), first = list[0], last = list[list.length - 1];
    const start = slotDate(p.w, first), end = slotDate(p.w, last);
    start.setHours(SLOTS[first].part === 'night' ? 19 : 12, 0, 0, 0);
    end.setHours(SLOTS[last].part === 'night' ? 23 : 17, 0, 0, 0);
    return { start, end };
  }
  // The same plan as a calendar file, in the phone's own time zone.
  function planIcs(p, notes, now) {
    const t = planTimes(p), two = n => String(n).padStart(2, '0');
    const local = d => `${d.getFullYear()}${two(d.getMonth() + 1)}${two(d.getDate())}T${two(d.getHours())}${two(d.getMinutes())}00`;
    const text = s => String(s).replace(/[\\;,]/g, c => '\\' + c).replace(/\s+/g, ' ').trim();
    const stamp = now.toISOString().replace(/[-:]/g, '').replace(/\.\d+/, '');
    return ['BEGIN:VCALENDAR', 'VERSION:2.0', 'PRODID:-//Muster//EN', 'BEGIN:VEVENT', `UID:${p.id}@muster.teloone.au`, `DTSTAMP:${stamp}`,
      `DTSTART:${local(t.start)}`, `DTEND:${local(t.end)}`, `SUMMARY:${text(p.text)}`, `DESCRIPTION:${text(notes)}`, 'END:VEVENT', 'END:VCALENDAR', ''].join('\r\n');
  }

  function planPart(p, m) {
    const all = planSlots(p), mine = bits((p.part && p.part[m]) || 0).filter(i => all.includes(i));
    return mine.length ? mine : all;
  }

  const member = (state, id) => state.members.find(m => m.id === id);

  // What someone has said for a slot: their answer for that weekend, or
  // failing that their usual. { v, usual } with v '-' when there's neither.
  function answer(state, id, week, i) {
    const mark = ((state.marks[id] || {})[week] || BLANK)[i];
    if (mark && mark !== '-') return { v: mark, usual: false };
    const m = member(state, id);
    const u = m && m.usual ? m.usual[i] : '-';
    return u && u !== '-' ? { v: u, usual: true } : { v: '-', usual: false };
  }

  // The tap after this one. With a usual set there's no going back to nothing.
  function next(v, hasUsual) {
    const ring = hasUsual ? 'fmb' : 'fmb-';
    return ring[(ring.indexOf(v) + 1) % ring.length];
  }

  // Everyone in a slot, sorted into f, m, b and - (in the group's order).
  function roll(state, week, i) {
    const out = { f: [], m: [], b: [], '-': [] };
    for (const m of state.members) out[answer(state, m.id, week, i).v].push(m);
    return out;
  }

  // People with nothing said for any of the weekend's slots still to come.
  function waiting(state, week, now) {
    const left = SLOTS.map((_, i) => i).filter(i => !isPast(week, i, now));
    if (!left.length) return [];
    return state.members.filter(m => left.every(i => answer(state, m.id, week, i).v === '-'));
  }

  // The slots most of the group can make, best first: by share of the group
  // free (a maybe counts half), then by who's free, then the soonest.
  function best(state, weekList, now) {
    const n = state.members.length;
    if (n < 2) return [];
    const out = [];
    weekList.forEach((week, wi) => SLOTS.forEach((_, i) => {
      if (isPast(week, i, now)) return;
      const r = roll(state, week, i);
      if (r.f.length < 2) return;
      out.push({ week, i, f: r.f.length, m: r.m.length, b: r.b.length, n, all: r.f.length === n, score: r.f.length + r.m.length / 2, order: wi * 5 + i });
    }));
    return out.sort((a, b) => b.score - a.score || b.f - a.f || a.order - b.order);
  }

  // A change, applied to the page's copy of the group the way the server applies it.
  function applyOp(state, op) {
    if (op.t === 'group') state.group.name = op.name;
    else if (op.t === 'member') {
      const m = member(state, op.id);
      if (op.removed) {
        state.members = state.members.filter(x => x.id !== op.id);
      } else if (m) {
        if (op.name !== undefined) m.name = op.name;
        if (op.usual !== undefined) m.usual = op.usual;
      } else if (op.name) {
        state.members.push({ id: op.id, name: op.name, usual: op.usual || BLANK });
      }
    } else if (op.t === 'mark') {
      const mine = state.marks[op.m] || (state.marks[op.m] = {});
      const s = mine[op.w] || BLANK;
      mine[op.w] = s.slice(0, op.i) + op.v + s.slice(op.i + 1);
    } else if (op.t === 'plan') {
      const at = state.plans.findIndex(p => p.id === op.id);
      if (op.deleted) { if (at >= 0) state.plans.splice(at, 1); }
      else if (at >= 0) Object.assign(state.plans[at], { w: op.w, i: op.i, text: op.text });
      else state.plans.push({ id: op.id, w: op.w, i: op.i, text: op.text, by: op.by, at: Date.now(), rsvp: {} });
      const p = !op.deleted && state.plans.find(x => x.id === op.id);
      if (p) { if (op.s && bits(op.s).length > 1) p.s = op.s; else delete p.s; }
    } else if (op.t === 'rsvp') {
      const p = state.plans.find(x => x.id === op.p);
      if (p) {
        if (op.v) p.rsvp[op.m] = op.v; else delete p.rsvp[op.m];
        if (op.v && op.s) (p.part || (p.part = {}))[op.m] = op.s; else if (p.part) delete p.part[op.m];
      }
    }
    return state;
  }

  // "Sam", "Sam and Jo", "Sam, Jo and Alex", "Sam, Jo and 3 more"
  function names(list, max = 3) {
    const n = list.map(m => m.name);
    if (n.length > max) return `${n.slice(0, max - 1).join(', ')} and ${n.length - max + 1} more`;
    return n.length < 2 ? n.join('') : `${n.slice(0, -1).join(', ')} and ${n[n.length - 1]}`;
  }

  return { SLOTS, BLANK, key, parse, addDays, weekKey, weeks, slotEnd, isPast, slotDate, rangeLabel, rangeParts, relLabel, slotName, slotWhen, bits, maskOf, planSlots, planTimes, planIcs, slotsName, planWhen, planPart, member, answer, next, roll, waiting, best, applyOp, names };
});
