import { requireValue } from './errors.mjs';

export const FIELDS = new Set(['description', 'date', 'start', 'end', 'durationMinutes', 'timezone', 'project', 'projectId', 'billable', 'taskId', 'tagIds', 'customFields']);

export function requireResolvedWrites(records) {
  const pending = records.find((record) => record.state === 'pending');
  requireValue(!pending, 'WRITE_UNCERTAIN', 'An earlier write remains unresolved. Reconcile its original request with the original timezone or UTC timestamps before sending another write.',
    pending ? { fingerprint: pending.fingerprint, timezone: pending.timezone, originalStart: pending.payload.start, originalEnd: pending.payload.end } : undefined);
}

export function requireShortDescription(description) {
  requireValue(typeof description === 'string' && description.trim(), 'DESCRIPTION_REQUIRED', 'Supply a short activity label.');
  const characters = [...description].length;
  const words = description.trim().split(/\s+/u).length;
  const limits = { characters, words, maxCharacters: 100, maxWords: 12 };
  requireValue(!/[\r\n\u0085\u2028\u2029]/u.test(description), 'DESCRIPTION_MULTILINE',
    'Rewrite the description as one short line of 3–8 words. No write was sent for this entry.', limits);
  requireValue(characters <= limits.maxCharacters && words <= limits.maxWords, 'DESCRIPTION_TOO_LONG',
    'Summarize the main activity in 3–8 words, at most 12 words and 100 characters. Do not truncate or list implementation details. No write was sent for this entry.', limits);
}

export function canonical(value) {
  if (Array.isArray(value)) return value.map(canonical);
  if (value && typeof value === 'object') return Object.fromEntries(Object.keys(value).sort().map((key) => [key, canonical(value[key])]));
  return value;
}

export function identity(entry) {
  return {
    description: entry.description || '', projectId: entry.projectId || null, taskId: entry.taskId || null,
    tagIds: [...(entry.tagIds || [])].sort(),
    start: new Date(entry.start ?? entry.timeInterval?.start).toISOString(),
    end: new Date(entry.end ?? entry.timeInterval?.end).toISOString(),
  };
}

export function sameEntry(entry, payload) {
  if (!entry?.id || !entry.timeInterval?.end) return false;
  try { return JSON.stringify(identity(entry)) === JSON.stringify(identity(payload)); } catch { return false; }
}

export function overlaps(a, b) {
  const start = (entry) => Date.parse(entry.start ?? entry.timeInterval?.start);
  const end = (entry) => entry.end ?? entry.timeInterval?.end;
  return start(a) < (end(b) ? Date.parse(end(b)) : Infinity) && start(b) < (end(a) ? Date.parse(end(a)) : Infinity);
}

export function sameInterval(a, b) {
  return Date.parse(a.start ?? a.timeInterval?.start) === Date.parse(b.start ?? b.timeInterval?.start)
    && Date.parse(a.end ?? a.timeInterval?.end) === Date.parse(b.end ?? b.timeInterval?.end);
}

export function entryPayload(entry) {
  const fields = entry.customFieldValues ?? entry.customFields ?? [];
  requireValue(Array.isArray(fields), 'INVALID_API_RESPONSE', 'Clockify did not return readable custom field values.');
  return {
    ...identity(entry), billable: entry.billable === true, type: entry.type || 'REGULAR',
    customFields: fields.map((field) => {
      requireValue(typeof field?.customFieldId === 'string' && Object.hasOwn(field, 'value'), 'INVALID_API_RESPONSE', 'A custom field value cannot be preserved safely.');
      const sourceType = field.sourceType || field.type;
      return { customFieldId: field.customFieldId, value: field.value,
        ...(['WORKSPACE', 'PROJECT', 'TIMEENTRY'].includes(sourceType) ? { sourceType } : {}) };
    }),
  };
}

export function entryState(entry) {
  const payload = entryPayload(entry);
  // Source metadata can differ between GET and PUT responses. Values, including
  // false, zero, and null, must be preserved and confirmed without coercion.
  payload.customFields = payload.customFields.map(({ customFieldId, value }) => ({ customFieldId, value }))
    .sort((a, b) => a.customFieldId.localeCompare(b.customFieldId));
  return JSON.stringify(canonical(payload));
}

export function candidate(entry) {
  return { id: entry.id, description: entry.description, start: entry.timeInterval?.start,
    end: entry.timeInterval?.end, projectId: entry.projectId, isLocked: entry.isLocked };
}
