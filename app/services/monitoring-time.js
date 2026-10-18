'use strict';
// 03 §12: local calendar windows, never a fixed UTC offset or +24h recurrence.
const formatters = new Map();
function formatter(zone) {
  if (typeof zone !== 'string' || !zone.trim() || /^[+-]/.test(zone)) throw new RangeError('Explicit IANA timeZone required');
  if (!formatters.has(zone)) formatters.set(zone, new Intl.DateTimeFormat('en-CA', { timeZone: zone, year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', second: '2-digit', hourCycle: 'h23' }));
  return formatters.get(zone);
}
function parts(ms, zone) { return Object.fromEntries(formatter(zone).formatToParts(ms).filter(p => p.type !== 'literal').map(p => [p.type, p.value])); }
function dateValue(key) {
  if (typeof key !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(key)) throw new RangeError('Invalid local date');
  const value = Date.parse(key + 'T00:00:00Z');
  if (!Number.isFinite(value) || new Date(value).toISOString().slice(0,10) !== key) throw new RangeError('Invalid local date');
  return value;
}
function localDateKey(now, zone) { const p = parts(now, zone); return `${p.year}-${p.month}-${p.day}`; }
function resolveLocalTime(key, hour, minute, zone) {
  const day = dateValue(key); formatter(zone);
  if (!Number.isInteger(hour) || hour < 0 || hour > 23 || !Number.isInteger(minute) || minute < 0 || minute > 59) throw new RangeError('Invalid local time');
  const nominal = day + hour * 3600000 + minute * 60000;
  const offsets = new Set();
  // Collect both sides of transitions, including full-date skips. ICU supplies offsets.
  for (let d = -48; d <= 48; d += 6) {
    const instant = nominal + d * 3600000, p = parts(instant, zone);
    offsets.add(Date.parse(`${p.year}-${p.month}-${p.day}T${p.hour}:${p.minute}:${p.second}Z`) - instant);
  }
  const matches = [...offsets].map(o => nominal - o).filter(t => { const p = parts(t, zone); return `${p.year}-${p.month}-${p.day}` === key && +p.hour === hour && +p.minute === minute; });
  if (matches.length !== 1) { const error = new Error('Local window is nonexistent or ambiguous'); error.code = matches.length ? 'LOCAL_TIME_AMBIGUOUS' : 'LOCAL_TIME_NONEXISTENT'; throw error; }
  return matches[0];
}
function slotsForDate(key, zone) { return [6,14,22].map(hour => ({ window_key: `${key}:${String(hour).padStart(2,'0')}`, scheduled_at: resolveLocalTime(key, hour, 0, zone) })); }
function nextSlot(now, zone) {
  const key = localDateKey(now, zone);
  const today = slotsForDate(key, zone).find(s => s.scheduled_at > now);
  return today || slotsForDate(new Date(dateValue(key) + 86400000).toISOString().slice(0,10), zone)[0];
}
module.exports = { formatter, localDateKey, resolveLocalTime, slotsForDate, nextSlot };
