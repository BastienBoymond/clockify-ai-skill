import test from 'node:test';
import assert from 'node:assert/strict';
import { normalizeInterval, parseTimestamp, resolveDate, dayRange } from '../skills/clockify-time-entry/scripts/time.mjs';
import { NOW, entryInput } from './helpers.mjs';

test('converts supplied local work and elapsed duration to UTC', () => {
  const result = normalizeInterval(entryInput(), 'America/Los_Angeles', NOW);
  assert.equal(result.start, '2026-09-25T16:00:00.000Z');
  assert.equal(result.end, '2026-09-25T18:00:00.000Z');
  assert.equal(result.durationMinutes, 120);
});

test('today and yesterday use the saved timezone, not the machine date', () => {
  const now = new Date('2026-09-29T01:00:00Z');
  assert.equal(resolveDate('today', 'America/Los_Angeles', now), '2026-09-28');
  assert.equal(resolveDate('yesterday', 'America/Los_Angeles', now), '2026-09-27');
  assert.equal(resolveDate('today', 'Asia/Tokyo', now), '2026-09-29');
});

test('rejects DST gaps and asks for an offset for repeated local times', () => {
  assert.throws(() => parseTimestamp('2026-03-08T02:30', 'America/Los_Angeles'), { code: 'NONEXISTENT_LOCAL_TIME' });
  assert.throws(() => parseTimestamp('2026-11-01T01:30', 'America/Los_Angeles'), { code: 'AMBIGUOUS_LOCAL_TIME' });
  assert.equal(new Date(parseTimestamp('2026-11-01T01:30-07:00', 'America/Los_Angeles')).toISOString(), '2026-11-01T08:30:00.000Z');
  assert.equal(new Date(parseTimestamp('2026-11-01T01:30-08:00', 'America/Los_Angeles')).toISOString(), '2026-11-01T09:30:00.000Z');
});

test('handles half-hour DST shifts and non-hour UTC offsets', () => {
  assert.throws(() => parseTimestamp('2026-10-04T02:15', 'Australia/Lord_Howe'), { code: 'NONEXISTENT_LOCAL_TIME' });
  assert.throws(() => parseTimestamp('2026-04-05T01:45', 'Australia/Lord_Howe'), { code: 'AMBIGUOUS_LOCAL_TIME' });
  assert.equal(new Date(parseTimestamp('2026-09-25T09:00', 'Asia/Kathmandu')).toISOString(), '2026-09-25T03:15:00.000Z');
});

test('DST day reads cover the actual 23 or 25 hour local day', () => {
  const spring = dayRange('2026-03-08', 'America/Los_Angeles');
  const fall = dayRange('2026-11-01', 'America/Los_Angeles');
  assert.equal(Date.parse(spring.end) - Date.parse(spring.start) + 1, 23 * 3_600_000);
  assert.equal(Date.parse(fall.end) - Date.parse(fall.start) + 1, 25 * 3_600_000);
});

test('supports explicit overnight dates and duration across a DST change', () => {
  const overnight = normalizeInterval({ start: '2026-09-24T23:00', end: '2026-09-25T01:00' }, 'UTC', NOW);
  assert.equal(overnight.durationMinutes, 120);
  const spring = normalizeInterval({ start: '2026-03-08T01:30', durationMinutes: 120 }, 'America/Los_Angeles', NOW);
  assert.equal(spring.end, '2026-03-08T11:30:00.000Z');
});

for (const [name, input, code] of [
  ['missing start', { durationMinutes: 60 }, 'START_REQUIRED'],
  ['missing end and duration', { start: '2026-09-25T09:00' }, 'INTERVAL_REQUIRED'],
  ['two interval forms', { start: '2026-09-25T09:00', end: '2026-09-25T10:00', durationMinutes: 60 }, 'INTERVAL_REQUIRED'],
  ['negative duration', { start: '2026-09-25T09:00', durationMinutes: -1 }, 'INVALID_DURATION'],
  ['fractional duration', { start: '2026-09-25T09:00', durationMinutes: 1.5 }, 'INVALID_DURATION'],
  ['invalid date rollover', { start: '2026-02-30T09:00Z', durationMinutes: 60 }, 'INVALID_DATE'],
  ['invalid clock', { start: '2026-09-25T24:00', durationMinutes: 60 }, 'INVALID_DATE'],
  ['future work', { start: '2027-01-01T09:00', durationMinutes: 60 }, 'FUTURE_ENTRY'],
  ['backwards interval', { start: '2026-09-25T09:00', end: '2026-09-25T08:00' }, 'INVALID_INTERVAL'],
  ['invalid timezone', { start: '2026-09-25T09:00', durationMinutes: 60, timezone: 'wrong/timezone' }, 'INVALID_TIMEZONE'],
  ['no date with clock time', { start: '09:00', durationMinutes: 60 }, 'DATE_REQUIRED'],
  ['invalid offset', { start: '2026-09-25T09:00+15:00', durationMinutes: 60 }, 'INVALID_OFFSET'],
]) {
  test(`rejects ${name}`, () => assert.throws(() => normalizeInterval(input, 'UTC', NOW), { code }));
}
