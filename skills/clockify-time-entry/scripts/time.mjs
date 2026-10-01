import { requireValue, SkillError } from './errors.mjs';

// Logged durations are always rounded up to the next quarter hour
// (15, 30, 45, 60 minutes, and so on). The start time is kept as supplied.
export const ROUNDING_MINUTES = 15;

export function roundUpMinutes(minutes, step = ROUNDING_MINUTES) {
  return Math.ceil(minutes / step) * step;
}

export function validateTimezone(timezone) {
  requireValue(typeof timezone === 'string' && timezone.length > 0, 'INVALID_TIMEZONE', 'Supply an IANA timezone such as America/Los_Angeles.');
  try { new Intl.DateTimeFormat('en', { timeZone: timezone }).format(); } catch {
    throw new SkillError('INVALID_TIMEZONE', 'Supply a valid IANA timezone such as America/Los_Angeles.');
  }
  return timezone;
}

function partsAt(ms, timezone) {
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone: timezone, year: 'numeric', month: '2-digit', day: '2-digit',
    hour: '2-digit', minute: '2-digit', second: '2-digit', hourCycle: 'h23',
  }).formatToParts(ms);
  return Object.fromEntries(parts.filter((part) => part.type !== 'literal').map((part) => [part.type, Number(part.value)]));
}

function calendarMs(parts) {
  const { year, month, day, hour = 0, minute = 0, second = 0 } = parts;
  requireValue(year >= 1000 && year <= 9999 && month >= 1 && month <= 12 && day >= 1 && day <= 31 && hour >= 0 && hour <= 23 && minute >= 0 && minute <= 59 && second >= 0 && second <= 59,
    'INVALID_DATE', 'Supply a real calendar date and a time between 00:00:00 and 23:59:59.');
  const ms = Date.UTC(year, month - 1, day, hour, minute, second);
  requireValue(new Date(ms).getUTCDate() === day, 'INVALID_DATE', 'The requested date does not exist.');
  return ms;
}

export function resolveDate(date, timezone, now = new Date()) {
  validateTimezone(timezone);
  requireValue(typeof date === 'string', 'DATE_REQUIRED', 'Ask the user which date to log.');
  if (date === 'today' || date === 'yesterday') {
    const parts = partsAt(now.getTime(), timezone);
    const ms = Date.UTC(parts.year, parts.month - 1, parts.day) - (date === 'yesterday' ? 86_400_000 : 0);
    return new Date(ms).toISOString().slice(0, 10);
  }
  requireValue(/^\d{4}-\d{2}-\d{2}$/.test(date), 'INVALID_DATE', 'Use YYYY-MM-DD, today, or yesterday.');
  const [year, month, day] = date.split('-').map(Number);
  calendarMs({ year, month, day });
  return date;
}

export function parseTimestamp(value, timezone, date, now = new Date()) {
  validateTimezone(timezone);
  requireValue(typeof value === 'string' && value.length > 0, 'START_REQUIRED', 'Ask the user for the missing start or end time.');
  if (/^\d{2}:\d{2}(:\d{2})?$/.test(value)) value = `${resolveDate(date, timezone, now)}T${value}`;
  const match = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})(?::(\d{2})(?:\.(\d{1,3}))?)?(Z|[+-]\d{2}:\d{2})?$/.exec(value);
  requireValue(match, 'INVALID_DATE', 'Use HH:mm with a date, or YYYY-MM-DDTHH:mm:ss with an optional UTC offset.');
  const [, year, month, day, hour, minute, second = '0', fraction = '', offset] = match;
  const desired = { year: +year, month: +month, day: +day, hour: +hour, minute: +minute, second: +second };
  const local = calendarMs(desired) + Number(fraction.padEnd(3, '0'));
  if (offset) {
    let shift = 0;
    if (offset !== 'Z') {
      const hours = Number(offset.slice(1, 3));
      const minutes = Number(offset.slice(4, 6));
      requireValue(hours <= 14 && minutes <= 59 && (hours !== 14 || minutes === 0), 'INVALID_OFFSET', 'Supply a valid UTC offset.');
      shift = (hours * 60 + minutes) * 60_000 * (offset[0] === '-' ? -1 : 1);
    }
    return local - shift;
  }
  // Gather actual offsets around the date, then round-trip candidates. This
  // detects both gaps and repeated local times, including half-hour changes.
  const offsets = new Set();
  for (let hours = -48; hours <= 48; hours += 6) {
    const sample = local + hours * 3_600_000;
    offsets.add(calendarMs(partsAt(sample, timezone)) - Math.floor(sample / 1000) * 1000);
  }
  const candidates = [...offsets].map((offsetMs) => local - offsetMs).filter((candidate) => {
    const actual = partsAt(candidate, timezone);
    return Object.keys(desired).every((key) => desired[key] === actual[key]);
  });
  requireValue(candidates.length > 0, 'NONEXISTENT_LOCAL_TIME', 'This local time does not exist because the clocks changed. Ask for a valid time.');
  requireValue(candidates.length === 1, 'AMBIGUOUS_LOCAL_TIME', 'This local time occurs twice because the clocks changed. Ask which UTC offset applies.');
  return candidates[0];
}

export function normalizeInterval(entry, timezone, now = new Date(), { round = true, allowFuture = false } = {}) {
  const zone = validateTimezone(entry.timezone || timezone);
  requireValue(entry.start, 'START_REQUIRED', 'Ask the user for a start time; never assume 09:00 or end at now.');
  const hasEnd = entry.end !== undefined;
  const hasDuration = entry.durationMinutes !== undefined;
  requireValue(hasEnd !== hasDuration, 'INTERVAL_REQUIRED', 'Supply either end or durationMinutes, with start.');
  const start = parseTimestamp(entry.start, zone, entry.date, now);
  let end;
  if (hasDuration) {
    requireValue(Number.isInteger(entry.durationMinutes) && entry.durationMinutes > 0 && entry.durationMinutes <= 525_600, 'INVALID_DURATION', 'durationMinutes must be a positive whole number no greater than one year.');
    end = start + entry.durationMinutes * 60_000;
  } else {
    end = parseTimestamp(entry.end, zone, entry.date, now);
  }
  requireValue(end > start, 'INVALID_INTERVAL', 'End must be after start. For overnight work, supply the end date explicitly.');
  // Completed work is checked on the supplied end, before rounding, so work that
  // ended a few minutes ago is not rejected because its rounded end is later.
  // An explicit allowFuture opt-in (per entry, or for an untouched interval on
  // update) skips only this check; rounding and overlap checks still apply.
  requireValue(allowFuture || entry.allowFuture === true || end <= now.getTime(), 'FUTURE_ENTRY', 'Only completed work can be logged; the end time is in the future. Set allowFuture: true only when the user explicitly asks to log this block anyway.');
  const elapsed = (end - start) / 60_000;
  const durationMinutes = round ? roundUpMinutes(elapsed) : elapsed;
  end = start + durationMinutes * 60_000;
  return { start: new Date(start).toISOString(), end: new Date(end).toISOString(), timezone: zone, durationMinutes };
}

export function dayRange(date, timezone, now = new Date()) {
  const resolved = resolveDate(date, timezone, now);
  const next = new Date(Date.parse(`${resolved}T00:00:00Z`) + 86_400_000).toISOString().slice(0, 10);
  return { start: new Date(parseTimestamp(`${resolved}T00:00:00`, timezone)).toISOString(), end: new Date(parseTimestamp(`${next}T00:00:00`, timezone) - 1).toISOString() };
}
