import test from 'node:test';
import assert from 'node:assert/strict';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import { fixture, entryInput, jsonResponse } from './helpers.mjs';
import { ClockifyService } from '../skills/clockify-time-entry/scripts/service.mjs';
import { run } from '../skills/clockify-time-entry/scripts/cli.mjs';
import { writeJson } from '../skills/clockify-time-entry/scripts/config.mjs';

async function seed(service, provider, overrides = {}) {
  const [prepared] = await service.prepare(entryInput(overrides));
  return provider.save(prepared.payload);
}

test('same exact interval updates the existing ID instead of creating a duplicate', async (t) => {
  const { service, provider } = await fixture(t);
  const old = await seed(service, provider);
  const result = await service.create(entryInput({ description: 'Detailed actual work' }));
  assert.equal(result.ok, true);
  assert.equal(result.results[0].status, 'updated');
  assert.equal(result.results[0].id, old.id);
  assert.equal(provider.entries.length, 1);
  assert.equal(provider.entries[0].description, 'Detailed actual work');
  assert.equal(provider.posts.length, 0);
  assert.equal(provider.puts.length, 1);
});

test('updates only specified fields and preserves task, tags, billability and custom values', async (t) => {
  const { service, provider } = await fixture(t);
  const old = await seed(service, provider, { taskId: 'task-1', tagIds: ['tag-1'] });
  old.customFieldValues = [
    { customFieldId: 'number-field', value: 0, type: 'PROJECT' },
    { customFieldId: 'boolean-field', value: false, sourceType: 'TIMEENTRY' },
    { customFieldId: 'text-field', value: 'Keep me', type: 'WORKSPACE' },
  ];
  const result = await service.create(entryInput({ description: 'Only change the description', project: undefined }));
  assert.equal(result.results[0].status, 'updated');
  const body = provider.puts[0].body;
  assert.equal(body.projectId, old.projectId);
  assert.equal(body.taskId, old.taskId);
  assert.deepEqual(body.tagIds, old.tagIds);
  assert.equal(body.billable, true);
  assert.deepEqual(body.customFields, [
    { customFieldId: 'number-field', value: 0, sourceType: 'PROJECT' },
    { customFieldId: 'boolean-field', value: false, sourceType: 'TIMEENTRY' },
    { customFieldId: 'text-field', value: 'Keep me', sourceType: 'WORKSPACE' },
  ]);
  assert.equal(provider.entries.length, 1);
});

test('explicit update can change a description without asking for times again', async (t) => {
  const { service, provider } = await fixture(t);
  const old = await seed(service, provider);
  old.timeInterval.start = '2026-09-25T16:00:00.123Z';
  old.timeInterval.end = '2026-09-25T18:00:00.456Z';
  const result = await service.update({ id: old.id, description: 'Corrected description' });
  assert.equal(result.results[0].status, 'updated');
  assert.deepEqual(provider.entries[0].timeInterval, old.timeInterval);
  assert.equal(provider.posts.length, 0);
});

test('unchanged entries cause no write; explicit billability and custom field changes do', async (t) => {
  const { service, provider } = await fixture(t);
  const old = await seed(service, provider);
  assert.equal((await service.update({ id: old.id, description: old.description })).results[0].status, 'unchanged');
  assert.equal(provider.puts.length, 0);
  const changed = await service.create(entryInput({ billable: false, customFields: [{ customFieldId: 'field-1', value: false }] }));
  assert.equal(changed.results[0].status, 'updated');
  assert.equal(provider.entries[0].billable, false);
  assert.equal(provider.entries[0].customFieldValues[0].value, false);
});

test('partial overlaps, including a containing entry starting earlier, require a choice', async (t) => {
  const { service, provider } = await fixture(t);
  const old = await seed(service, provider, { start: '08:00', durationMinutes: 240 });
  const result = await service.create(entryInput());
  assert.equal(result.error.code, 'OVERLAPPING_ENTRIES');
  assert.equal(result.error.candidates[0].id, old.id);
  assert.equal(provider.posts.length, 0);
  assert.equal(provider.puts.length, 0);
  const query = provider.calls.find((call) => call.endpoint.endsWith('/user/user-1/time-entries'));
  assert.equal(query.url.searchParams.has('start'), false);
  assert.equal(query.url.searchParams.has('end'), false);
});

test('overlap detection checks later API pages before treating an interval as free', async (t) => {
  const { service, provider } = await fixture(t);
  const containing = await seed(service, provider, { start: '08:00', durationMinutes: 240 });
  const neighbor = await seed(service, provider, { start: '12:00', durationMinutes: 60 });
  provider.intercept = (call) => {
    if (!call.endpoint.endsWith('/user/user-1/time-entries')) return;
    return call.url.searchParams.get('page') === '1'
      ? jsonResponse([neighbor], 200, { 'Last-Page': 'false' })
      : jsonResponse([containing], 200, { 'Last-Page': 'true' });
  };
  const result = await service.create(entryInput());
  assert.equal(result.error.code, 'OVERLAPPING_ENTRIES');
  assert.equal(result.error.candidates[0].id, containing.id);
  assert.equal(provider.posts.length + provider.puts.length, 0);
});

test('an incomplete overlap read prevents both creation and automatic update', async (t) => {
  const { service, provider } = await fixture(t);
  const exact = await seed(service, provider);
  provider.intercept = (call) => {
    if (!call.endpoint.endsWith('/user/user-1/time-entries')) return;
    return call.url.searchParams.get('page') === '1'
      ? jsonResponse([exact], 200, { 'Last-Page': 'false' })
      : jsonResponse({}, 429, { 'Retry-After': '60' });
  };
  const result = await service.create(entryInput({ description: 'Updated work' }));
  assert.equal(result.error.code, 'RATE_LIMITED');
  assert.equal(provider.posts.length + provider.puts.length, 0);
});

test('multiple exact matches require choosing one ID, which can then be updated', async (t) => {
  const { service, provider } = await fixture(t);
  const first = await seed(service, provider);
  const second = await seed(service, provider, { description: 'Second block' });
  const result = await service.create(entryInput({ description: 'Correction' }));
  assert.equal(result.error.code, 'OVERLAPPING_ENTRIES');
  assert.equal(result.error.candidates.length, 2);
  assert.equal(provider.puts.length, 0);
  const selected = await service.update({ id: first.id, description: 'Correction' });
  assert.equal(selected.results[0].id, first.id);
  assert.equal(provider.entries.find((entry) => entry.id === second.id).description, 'Second block');
  assert.equal(provider.entries.length, 2);
});

test('a neighboring entry ending at the requested start does not overlap', async (t) => {
  const { service, provider } = await fixture(t);
  await seed(service, provider, { start: '08:00', durationMinutes: 60 });
  const result = await service.create(entryInput());
  assert.equal(result.results[0].status, 'created');
  assert.equal(provider.posts.length, 1);
});

test('update previews show before/after while leaving Clockify and the journal untouched', async (t) => {
  const { service, provider, directory } = await fixture(t);
  const old = await seed(service, provider);
  const auto = await service.create(entryInput({ description: 'Preview only' }), { preview: true });
  assert.equal(auto.entries[0].action, 'update');
  assert.equal(auto.entries[0].before.description, old.description);
  assert.equal(auto.entries[0].payload.description, 'Preview only');
  const explicit = await service.update({ id: old.id, description: 'Preview only' }, { preview: true });
  assert.equal(explicit.entries[0].id, old.id);
  assert.equal(provider.entries[0].description, old.description);
  assert.equal(provider.puts.length + provider.posts.length, 0);
  await assert.rejects(fs.stat(directory), { code: 'ENOENT' });
});

for (const [label, change, code] of [
  ['another user', { userId: 'other-user' }, 'ENTRY_OWNERSHIP'],
  ['another workspace', { workspaceId: 'other-workspace' }, 'ENTRY_OWNERSHIP'],
  ['locked work', { isLocked: true }, 'ENTRY_LOCKED'],
  ['a running timer', { timeInterval: { start: '2026-09-25T16:00:00Z', end: null } }, 'ENTRY_IN_PROGRESS'],
  ['time off', { type: 'TIME_OFF' }, 'UNSUPPORTED_ENTRY'],
]) {
  test(`refuses to modify ${label}`, async (t) => {
    const { service, provider } = await fixture(t);
    const old = await seed(service, provider);
    Object.assign(old, change);
    const result = await service.update({ id: old.id, description: 'Changed' });
    assert.equal(result.error.code, code);
    assert.equal(provider.posts.length + provider.puts.length, 0);
  });
}

test('an explicit time change keeps the ID and rejects a collision with another entry', async (t) => {
  const { service, provider } = await fixture(t);
  const old = await seed(service, provider);
  await seed(service, provider, { start: '12:00', durationMinutes: 60 });
  const conflict = await service.update({ id: old.id, durationMinutes: 240 });
  assert.equal(conflict.error.code, 'OVERLAPPING_ENTRIES');
  const result = await service.update({ id: old.id, end: '2026-09-25T11:30' });
  assert.equal(result.results[0].id, old.id);
  assert.equal(result.results[0].durationMinutes, 150);
  assert.equal(provider.posts.length, 0);
});

test('explicit null associations clear only the requested fields', async (t) => {
  const { service, provider } = await fixture(t);
  const old = await seed(service, provider, { taskId: 'task-1', tagIds: ['tag-1'] });
  const result = await service.update({ id: old.id, projectId: null, taskId: null, tagIds: [] });
  assert.equal(result.results[0].status, 'updated');
  assert.equal(provider.entries[0].projectId, null);
  assert.equal(provider.entries[0].taskId, null);
  assert.deepEqual(provider.entries[0].tagIds, []);
  assert.equal(provider.entries[0].billable, true);
});

test('patching a custom field preserves all other custom fields', async (t) => {
  const { service, provider } = await fixture(t);
  const old = await seed(service, provider);
  old.customFieldValues = [{ customFieldId: 'field-1', value: 'Old' }, { customFieldId: 'field-2', value: 0 }];
  await service.update({ id: old.id, customFields: [{ customFieldId: 'field-1', value: 'New' }] });
  assert.deepEqual(provider.entries[0].customFieldValues.map(({ customFieldId, value }) => ({ customFieldId, value })), [{ customFieldId: 'field-1', value: 'New' }, { customFieldId: 'field-2', value: 0 }]);
});

test('a lost successful PUT is reconciled by a second agent without another PUT or POST', async (t) => {
  const { service, provider, config, directory, dependencies } = await fixture(t);
  const old = await seed(service, provider);
  const input = { id: old.id, description: 'Actual work' };
  provider.putHandlers.push((body, id) => { provider.update(id, body); throw new Error('lost response'); });
  assert.equal((await service.update(input)).error.code, 'WRITE_UNCERTAIN');
  const other = new ClockifyService(provider.apiFactory(), config, directory, dependencies);
  assert.equal((await other.update(input)).results[0].status, 'reconciled_update');
  assert.equal(provider.puts.length, 1);
  assert.equal(provider.posts.length, 0);
});

test('an uncertain failed PUT blocks retries and a different create request on its interval', async (t) => {
  const { service, provider } = await fixture(t);
  const old = await seed(service, provider);
  const input = { id: old.id, description: 'Actual work' };
  provider.putHandlers.push(() => { throw new Error('timeout'); });
  assert.equal((await service.update(input)).error.code, 'WRITE_UNCERTAIN');
  assert.equal((await service.update(input)).error.code, 'WRITE_UNCERTAIN');
  assert.equal((await service.create(entryInput({ description: 'Bypass attempt' }))).error.code, 'WRITE_UNCERTAIN');
  assert.equal(provider.puts.length, 1);
  assert.equal(provider.posts.length, 0);
});

test('automatic exact-match updates also reconcile a lost response without a new entry', async (t) => {
  const { service, provider } = await fixture(t);
  await seed(service, provider);
  provider.putHandlers.push((body, id) => { provider.update(id, body); throw new Error('lost response'); });
  const input = entryInput({ description: 'Detailed work', project: undefined });
  assert.equal((await service.create(input)).error.code, 'WRITE_UNCERTAIN');
  const result = await service.create(input);
  assert.equal(result.results[0].status, 'reconciled_update');
  assert.equal(provider.puts.length, 1);
  assert.equal(provider.entries.length, 1);
});

test('malformed success and server errors keep PUT outcomes uncertain', async (t) => {
  for (const response of [jsonResponse({}, 503), new Response('bad json', { status: 200 }), jsonResponse({ id: 'wrong-id' })]) {
    const { service, provider } = await fixture(t);
    const old = await seed(service, provider);
    provider.putHandlers.push(() => response);
    const input = { id: old.id, description: 'Actual work' };
    assert.equal((await service.update(input)).error.code, 'WRITE_UNCERTAIN');
    assert.equal((await service.update(input)).error.code, 'WRITE_UNCERTAIN');
    assert.equal(provider.puts.length, 1);
  }
});

test('a concurrent edit detected before PUT is preserved', async (t) => {
  const { service, provider } = await fixture(t);
  const old = await seed(service, provider);
  let reads = 0;
  provider.intercept = (call) => {
    if (call.method === 'GET' && call.endpoint.endsWith(`/time-entries/${old.id}`) && ++reads === 2) old.description = 'Edited in Clockify UI';
  };
  const result = await service.update({ id: old.id, description: 'Agent change' });
  assert.equal(result.error.code, 'ENTRY_CHANGED');
  assert.equal(provider.entries[0].description, 'Edited in Clockify UI');
  assert.equal(provider.puts.length, 0);
});

test('rate limits preserve completed batch updates and stop the remaining ones', async (t) => {
  const { service, provider } = await fixture(t);
  const first = await seed(service, provider);
  const second = await seed(service, provider, { start: '12:00' });
  const input = [{ id: first.id, description: 'First corrected' }, { id: second.id, description: 'Second corrected' }];
  provider.putHandlers.push((body, id) => jsonResponse(provider.update(id, body)), () => jsonResponse({}, 429, { 'Retry-After': '60' }));
  const partial = await service.update(input);
  assert.equal(partial.results[0].status, 'updated');
  assert.equal(partial.error.code, 'RATE_LIMITED');
  assert.equal(partial.failedIndex, 1);
  const resumed = await service.update(input);
  assert.equal(resumed.results[0].status, 'unchanged');
  assert.equal(resumed.results[1].status, 'updated');
  assert.equal(provider.puts.length, 3);
});

test('CLI update supports partial fields and preview without real network requests', async (t) => {
  const { service, provider, directory, config, dependencies } = await fixture(t);
  const old = await seed(service, provider);
  await writeJson(path.join(directory, 'config.json'), config);
  const file = path.join(directory, 'patch.json');
  await fs.writeFile(file, JSON.stringify({ id: old.id, description: 'New description' }));
  const result = await run(['update', '--input', file, '--preview'], dependencies);
  assert.equal(result.entries[0].action, 'update');
  assert.equal(provider.puts.length, 0);
});

test('exact-slot updates inherit workspace-required associations rather than asking for them again', async (t) => {
  const { service, provider } = await fixture(t);
  const old = await seed(service, provider, { taskId: 'task-1', tagIds: ['tag-1'] });
  provider.workspaces[0].workspaceSettings = { forceProjects: true, forceTasks: true, forceTags: true };
  const result = await service.create(entryInput({ project: undefined, description: 'Concise actual work' }));
  assert.equal(result.results[0].status, 'updated');
  assert.equal(provider.entries[0].projectId, old.projectId);
  assert.equal(provider.entries[0].taskId, old.taskId);
  assert.deepEqual(provider.entries[0].tagIds, old.tagIds);
});

test('same-batch overlaps cannot overwrite an earlier requested entry', async (t) => {
  const { service, provider } = await fixture(t);
  await assert.rejects(service.create([entryInput(), entryInput({ description: 'Other work' })]), { code: 'OVERLAPPING_REQUESTS' });
  assert.equal(provider.posts.length + provider.puts.length, 0);
});

test('editing a description preserves already archived reference data', async (t) => {
  const { service, provider } = await fixture(t);
  const old = await seed(service, provider, { taskId: 'task-1', tagIds: ['tag-1'] });
  provider.projects = [];
  provider.tasks = [];
  provider.tags = [];
  const result = await service.update({ id: old.id, description: 'Corrected work' });
  assert.equal(result.results[0].status, 'updated');
  assert.equal(provider.entries[0].projectId, old.projectId);
  assert.deepEqual(provider.entries[0].tagIds, old.tagIds);
});
