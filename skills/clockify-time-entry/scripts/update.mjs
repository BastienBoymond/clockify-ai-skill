import path from 'node:path';
import { createHash } from 'node:crypto';
import { segment } from './api.mjs';
import { withLock, writeJson } from './config.mjs';
import { FIELDS, canonical, entryPayload, entryState, overlaps, sameInterval, candidate, requireShortDescription, requireResolvedWrites } from './entries.mjs';
import { SkillError, requireValue, errorResult } from './errors.mjs';

const digest = (value) => createHash('sha256').update(JSON.stringify(canonical(value))).digest('hex');
const requestKey = (id, changes) => digest({ id, changes });
const recordFile = (service, record) => path.join(service.directory, 'attempts', `${record.fingerprint}.json`);

function patchInput(input) {
  requireValue(input && typeof input === 'object' && !Array.isArray(input), 'INVALID_INPUT', 'Each update must be an object containing id and the fields to change.');
  const { id, ...raw } = input;
  const changes = Object.fromEntries(Object.entries(raw).filter(([, value]) => value !== undefined));
  requireValue(typeof id === 'string' && id.trim(), 'ENTRY_ID_REQUIRED', 'Select an existing entry ID from entries, or from the overlap candidates.');
  requireValue(Object.keys(changes).every((key) => FIELDS.has(key)), 'UNKNOWN_FIELD', 'Unknown update field. Only supply fields documented in references/commands.md.');
  requireValue(Object.keys(changes).some((key) => !['date', 'timezone'].includes(key)), 'UPDATE_REQUIRED', 'Supply at least one field to change. A date or timezone alone does not move an entry; provide start or end.');
  requireValue(!(changes.date !== undefined || changes.timezone !== undefined) || ['start', 'end', 'durationMinutes'].some((key) => changes[key] !== undefined), 'INVALID_INPUT', 'Supply start, end, or durationMinutes when changing the date or timezone.');
  requireValue(!(changes.project !== undefined && changes.projectId !== undefined), 'INVALID_PROJECT', 'Supply project or projectId, not both.');
  requireValue(!(changes.end !== undefined && changes.durationMinutes !== undefined), 'INTERVAL_REQUIRED', 'Supply either end or durationMinutes.');
  return { id, changes };
}

function assertOwnEntry(service, entry, id) {
  requireValue(entry?.id === id && entry.userId === service.config.user.id && entry.workspaceId === service.config.workspace.id,
    'ENTRY_OWNERSHIP', 'Only entries belonging to the authenticated user in the saved workspace can be modified.');
  requireValue(entry.timeInterval?.end && Number.isFinite(Date.parse(entry.timeInterval.start)) && Number.isFinite(Date.parse(entry.timeInterval.end)),
    'ENTRY_IN_PROGRESS', 'Only completed entries can be modified; stop a running timer in Clockify first.');
  requireValue(!entry.type || entry.type === 'REGULAR', 'UNSUPPORTED_ENTRY', 'Only regular work entries can be modified, not breaks, holidays, or time off.');
}

async function scopedRecords(service) {
  return (await service.attempts()).filter((record) => JSON.stringify(canonical(record.scope)) === JSON.stringify(canonical(service.scope())));
}

function preparedReceipt(service, record) {
  return { payload: record.payload, project: record.project || (record.payload.projectId ? { id: record.payload.projectId } : null),
    timezone: record.timezone || service.timeContext?.timezone || service.config.timezone,
    durationMinutes: (Date.parse(record.payload.end) - Date.parse(record.payload.start)) / 60_000 };
}

export async function reconcileUpdate(service, record, changes, { preview = false } = {}) {
  let current;
  try {
    current = await service.getEntry(record.entryId);
    assertOwnEntry(service, current, record.entryId);
    requireValue(entryState(current) === entryState(record.payload), 'WRITE_UNCERTAIN', 'The entry does not yet match the attempted update.');
  } catch {
    throw new SkillError('WRITE_UNCERTAIN', 'The earlier update is still unresolved. Inspect the entry in Clockify; no update or creation was resent.', { id: record.entryId, fingerprint: record.fingerprint });
  }
  if (!preview) {
    record.state = 'succeeded';
    record.entry = current;
    await writeJson(recordFile(service, record), record);
  }
  requireValue(record.requestKey === requestKey(record.entryId, changes), 'RECONCILED_DIFFERENT_REQUEST', 'The earlier update was found. Review that result before requesting another change.', { id: record.entryId });
  if (preview) return { action: 'reconcile_update', id: record.entryId, ...preparedReceipt(service, record) };
  return service.result(current, preparedReceipt(service, record), 'reconciled_update');
}

async function prepareUpdate(service, current, changes) {
  const before = entryPayload(current);
  const merged = {
    description: before.description, start: before.start, end: before.end,
    billable: before.billable, tagIds: before.tagIds,
    ...(before.projectId ? { projectId: before.projectId } : {}),
    ...(before.taskId ? { taskId: before.taskId } : {}),
    ...changes,
  };
  if (changes.project !== undefined) delete merged.projectId;
  if (changes.projectId === null) delete merged.projectId;
  if (changes.taskId === null) delete merged.taskId;
  if (changes.durationMinutes !== undefined) delete merged.end;
  const fields = new Map(before.customFields.map((field) => [field.customFieldId, field]));
  if (changes.customFields !== undefined) {
    requireValue(Array.isArray(changes.customFields) && changes.customFields.every((field) => typeof field?.customFieldId === 'string' && field.customFieldId && Object.hasOwn(field, 'value')), 'INVALID_INPUT', 'customFields must contain customFieldId and an explicitly supplied value.');
    requireValue(new Set(changes.customFields.map((field) => field.customFieldId)).size === changes.customFields.length, 'INVALID_INPUT', 'Do not repeat a custom field ID in one update.');
    for (const field of changes.customFields) fields.set(field.customFieldId, { customFieldId: field.customFieldId, value: field.value, sourceType: 'TIMEENTRY' });
  }
  merged.customFields = [...fields.values()];
  // Only a requested time change is rounded up to the next quarter hour. A
  // description or association fix keeps the existing interval untouched.
  const round = ['start', 'end', 'durationMinutes'].some((key) => changes[key] !== undefined);
  const [prepared] = await service.prepare(merged, { preserved: current, round });
  // PUT requires a full writable snapshot. Empty/null values explicitly clear
  // requested associations; unspecified fields keep their original values.
  prepared.payload.taskId ??= null;
  prepared.payload.tagIds ??= [];
  prepared.payload.customFields = merged.customFields;
  return { ...prepared, before };
}

export async function updateOne(service, input, { preview = false, expectedInterval } = {}) {
  const { id, changes } = patchInput(input);
  const records = await scopedRecords(service);
  const pendingUpdate = records.find((record) => record.operation === 'update' && record.state === 'pending' && record.entryId === id);
  if (pendingUpdate) return reconcileUpdate(service, pendingUpdate, changes, { preview });
  // A time-only correction preserves legacy text; a new description must be
  // concise. Check after reconciliation so older uncertain writes stay readable.
  if (changes.description !== undefined) requireShortDescription(changes.description);

  const current = await service.getEntry(id);
  assertOwnEntry(service, current, id);
  requireValue(!current.isLocked, 'ENTRY_LOCKED', 'This Clockify entry is locked and cannot be modified.', { id });
  if (expectedInterval) requireValue(sameInterval(current, expectedInterval), 'ENTRY_CHANGED', 'The entry moved after matching its interval. Read entries again before continuing.', { id });
  const prepared = await prepareUpdate(service, current, changes);
  const { payload, before } = prepared;
  for (const record of records.filter((record) => record.state === 'pending')) {
    const periods = [record.payload, ...(record.before ? [record.before] : [])];
    if (periods.some((period) => overlaps(period, before) || overlaps(period, payload))) {
      throw new SkillError('WRITE_UNCERTAIN', 'An earlier write on this interval is still unresolved. Reconcile its original request before modifying this entry.', { fingerprint: record.fingerprint });
    }
  }
  if (!sameInterval(before, payload)) {
    const others = (await service.overlappingEntries(payload)).filter((entry) => entry.id !== id);
    requireValue(others.length === 0, 'OVERLAPPING_ENTRIES', 'The requested time change would overlap other entries. Clarify the intended times before continuing.', { candidates: others.map(candidate) });
  }
  const unchanged = entryState(current) === entryState(payload);
  if (!unchanged) requireResolvedWrites(records);
  if (preview) return { ...prepared, id, action: unchanged ? 'unchanged' : 'update' };
  if (unchanged) return service.result(current, prepared, 'unchanged');

  // Clockify exposes no conditional update token here. Re-read immediately
  // before PUT to detect intervening changes and preserve the current fields.
  const fresh = await service.getEntry(id);
  assertOwnEntry(service, fresh, id);
  requireValue(!fresh.isLocked && entryState(fresh) === entryState(before), 'ENTRY_CHANGED', 'The entry changed while this update was prepared. Review it again; nothing was sent.', { id });
  const record = { version: 1, operation: 'update', scope: service.scope(), entryId: id, before, payload,
    requestKey: requestKey(id, changes), project: prepared.project, timezone: prepared.timezone,
    state: 'pending', attemptedAt: service.now().toISOString() };
  record.fingerprint = digest({ operation: 'update', scope: record.scope, id, before, payload });
  const file = recordFile(service, record);
  await writeJson(file, record);
  let updated;
  try {
    updated = await service.api.put(`${service.base}/time-entries/${segment(id)}`, payload);
    assertOwnEntry(service, updated, id);
    requireValue(entryState(updated) === entryState(payload), 'WRITE_UNCERTAIN', 'Clockify did not confirm all updated fields.');
  } catch (error) {
    // Only an explicit provider rejection proves that PUT did not succeed.
    // A malformed/mismatched success response is always uncertain.
    if (error instanceof SkillError && error.code !== 'WRITE_UNCERTAIN' && error.details.httpStatus >= 400 && error.details.httpStatus < 500 && error.details.httpStatus !== 408) {
      record.state = 'rejected';
      record.error = { code: error.code, httpStatus: error.details.httpStatus };
      await writeJson(file, record);
      throw error;
    }
    throw new SkillError('WRITE_UNCERTAIN', 'This update may have succeeded. Re-run the same request only to reconcile; it will not be resent while unresolved.', { id, fingerprint: record.fingerprint });
  }
  record.state = 'succeeded';
  record.entry = updated;
  try { await writeJson(file, record); }
  catch { throw new SkillError('WRITE_UNCERTAIN', 'Clockify confirmed the update but its local receipt could not be saved. Reconcile before retrying.', { id, fingerprint: record.fingerprint }); }
  return service.result(updated, prepared, 'updated');
}

export async function updateEntries(service, input, { preview = false } = {}) {
  const inputs = Array.isArray(input) ? input : [input];
  requireValue(inputs.length > 0 && inputs.length <= 100, 'INVALID_INPUT', 'Supply 1 to 100 entry updates.');
  const ids = inputs.map((entry) => patchInput(entry).id);
  requireValue(new Set(ids).size === ids.length, 'INVALID_INPUT', 'Only update an entry once per batch.');
  const perform = () => service.withTimezoneContext(async () => {
    const results = [];
    for (const entry of inputs) {
      try { results.push(await updateOne(service, entry, { preview })); }
      catch (error) {
        return { ok: false, ...(preview ? { preview: true } : {}), results, failedIndex: results.length,
          remaining: inputs.length - results.length - 1, error: errorResult(error) };
      }
    }
    return preview ? { ok: true, preview: true, workspace: service.config.workspace, entries: results } : { ok: true, results };
  }, { persist: !preview });
  return preview ? perform() : withLock(service.directory, perform);
}
