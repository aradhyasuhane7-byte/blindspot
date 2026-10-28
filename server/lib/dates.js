'use strict';

/**
 * Date helpers. All user-visible plain dates (expected delivery, dispatch
 * date, confirmation date) are ISO strings 'yyyy-MM-dd'; moments are stored
 * as Firestore server timestamps.
 */
const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

function pad(n) { return n < 10 ? '0' + n : String(n); }

function todayLocal() {
  // yyyy-MM-dd in the server's local timezone
  const d = new Date();
  return d.getFullYear() + '-' + pad(d.getMonth() + 1) + '-' + pad(d.getDate());
}

function isIsoDate(s) {
  if (typeof s !== 'string' || s.length !== 10 || !/^\d{4}-\d{2}-\d{2}$/.test(s)) return false;
  const d = new Date(s + 'T00:00:00');
  return !Number.isNaN(d.getTime());
}

function parseIso(s) {
  if (!isIsoDate(s)) throw badIso(s);
  const [y, m, day] = s.slice(0, 10).split('-').map(Number);
  return { y, m, day, date: new Date(s + 'T00:00:00') };
}

function badIso(s) {
  return new Error(`Invalid date "${s}" - use format yyyy-MM-dd`);
}

function prettyIso(s) {
  if (!s) return '';
  const p = parseIso(s);
  return `${MONTHS[p.m - 1]} ${p.day}, ${p.y}`;
}

function fmtDate(tsLike) {
  if (!tsLike) return '';
  const d = typeof tsLike.toDate === 'function' ? tsLike.toDate() : tsLike;
  return `${MONTHS[d.getMonth()]} ${d.getDate()}, ${d.getFullYear()}`;
}

function fmtTs(tsLike) {
  if (!tsLike) return '';
  const d = typeof tsLike.toDate === 'function' ? tsLike.toDate() : tsLike;
  const hh = String(d.getHours()).padStart(2, '0');
  const mm = String(d.getMinutes()).padStart(2, '0');
  return fmtDate(d) + `, ${hh}:${mm}`;
}

/** Days between an ISO date and today (positive = overdue). */
function daysOverdue(iso, todayIso) {
  if (!iso) return 0;
  const a = parseIso(iso).date;
  const b = parseIso(todayIso).date;
  return Math.round((b.getTime() - a.getTime()) / 86400000);
}

function daysBetween(aTs, bTs) {
  if (!aTs || !bTs) return null;
  const a = tsToMs(aTs), b = tsToMs(bTs);
  if (!a || !b) return null;
  return (b - a) / 86400000;
}

function tsToMs(v) {
  if (v && typeof v.toMillis === 'function') return v.toMillis();
  return 0;
}

/** ISO label like "2026-W43" plus the Monday of that week. */
function isoWeek(d, weekStart) {
  const js = d instanceof Date ? d : new Date(d + 'T00:00:00');
  const target = new Date(js.getTime());
  const dayNr = (js.getDay() + 6) % 7; // ISO: Monday = 0
  target.setDate(target.getDate() - dayNr + 3);
  const firstThursday = new Date(target.getFullYear(), 0, 4);
  const fdayNr = (firstThursday.getDay() + 6) % 7;
  firstThursday.setDate(firstThursday.getDate() - fdayNr + 3);
  const week = 1 + Math.round((target - firstThursday) / (7 * 86400000));
  if (weekStart) target.setDate(target.getDate() - 3); // back to Monday
  return { year: target.getFullYear(), week, label: `${target.getFullYear()}-W${pad(week)}`, start: isoDate(target) };
}

function isoDate(d) {
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}

/** [start, end) range for a named period. Returns Date objects as ISO + time. */
function rangeFor(kind, fromIso, toIso, today) {
  const t = today || todayLocal();
  const addDays = (d, n) => { const x = new Date(d + 'T00:00:00'); x.setDate(x.getDate() + n); return isoDate(x); };
  const firstOfMonth = t.slice(0, 8) + '01';
  switch (kind) {
    case 'this-week': { const mon = isoWeek(t, false).start; return { from: mon, to: addDays(mon, 7) }; }
    case 'last-week': { const mon = addDays(t, -((new Date(t + 'T00:00:00').getDay() + 6) % 7) - 7); return { from: mon, to: addDays(mon, 7) }; }
    case 'this-month': return { from: firstOfMonth, to: nextMonth(firstOfMonth) };
    case 'last-month': {
      const prev = new Date(firstOfMonth + 'T00:00:00');
      prev.setMonth(prev.getMonth() - 1);
      const pf = isoDate(prev).slice(0, 8) + '01';
      return { from: pf, to: firstOfMonth };
    }
    case 'custom': {
      if (!fromIso || !toIso) throw new Error('Custom range requires both start and end dates');
      if (fromIso > toIso) throw new Error('Start date must be on or before end date');
      return { from: fromIso, to: addDays(toIso, 1) }; // inclusive end
    }
    default: throw new Error(`Unknown report range "${kind}"`);
  }
}

function nextMonth(firstIso) {
  const d = new Date(firstIso + 'T00:00:00');
  d.setMonth(d.getMonth() + 1);
  return isoDate(d);
}

function humanRange(r) {
  return `${prettyIso(r.from)} - ${prettyIso(addDaysIso(r.to, -1))}`;
}

function addDaysIso(iso, n) {
  const d = new Date(iso + 'T00:00:00');
  d.setDate(d.getDate() + n);
  return isoDate(d);
}

module.exports = {
  todayLocal, isIsoDate, parseIso, prettyIso, fmtDate, fmtTs,
  daysOverdue, daysBetween, tsToMs, isoWeek, isoDate, addDaysIso, rangeFor, humanRange,
};
