'use strict';
const test = require('node:test'), assert = require('node:assert/strict');
const time = require('../services/monitoring-time');
test('IANA windows across DST and non-hour offsets use exact UTC instants', () => {
  for (const [date, zone, utc] of [['2026-03-07','America/New_York','2026-03-07T11:00:00.000Z'], ['2026-03-08','America/New_York','2026-03-08T10:00:00.000Z'], ['2026-11-01','America/New_York','2026-11-01T11:00:00.000Z'], ['2026-10-17','Asia/Shanghai','2026-10-16T22:00:00.000Z'], ['2026-10-17','Australia/Adelaide','2026-10-16T19:30:00.000Z'], ['2026-10-17','Asia/Kathmandu','2026-10-17T00:15:00.000Z']]) assert.equal(new Date(time.slotsForDate(date, zone)[0].scheduled_at).toISOString(), utc);
});
test('next slot and local date cross midnight/year independently of process TZ', () => {
  for (const tz of ['UTC','America/Los_Angeles']) { process.env.TZ = tz; assert.equal(time.localDateKey(Date.parse('2026-12-31T17:00:00Z'),'Asia/Shanghai'), '2027-01-01'); assert.equal(new Date(time.nextSlot(Date.parse('2026-12-31T15:00:00Z'),'Asia/Shanghai').scheduled_at).toISOString(), '2026-12-31T22:00:00.000Z'); }
  assert.throws(() => time.slotsForDate('2026-02-30','UTC'));
  assert.throws(() => time.nextSlot(0,'Bad/Zone'));
});
test('nonexistent and repeated local moments are explicit errors', () => {
  assert.throws(() => time.resolveLocalTime('2026-03-08',2,30,'America/New_York'), { code: 'LOCAL_TIME_NONEXISTENT' });
  assert.throws(() => time.resolveLocalTime('2026-11-01',1,30,'America/New_York'), { code: 'LOCAL_TIME_AMBIGUOUS' });
  assert.throws(() => time.slotsForDate('2011-12-30','Pacific/Apia'), { code: 'LOCAL_TIME_NONEXISTENT' });
});
test('Fixed UTC offset strings are not IANA zones, named UTC and Etc aliases remain accepted',()=>{
  for(const zone of ['+08:00','-0500','+08','-05:30'])assert.throws(()=>time.slotsForDate('2026-10-17',zone));
  assert.equal(new Date(time.slotsForDate('2026-10-17','Etc/GMT+8')[0].scheduled_at).toISOString(),'2026-10-17T14:00:00.000Z');
  assert.equal(new Date(time.slotsForDate('2026-10-17','UTC')[0].scheduled_at).toISOString(),'2026-10-17T06:00:00.000Z');
});
