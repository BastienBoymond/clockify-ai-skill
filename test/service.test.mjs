import test from 'node:test';
import assert from 'node:assert/strict';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import { ClockifyService } from '../skills/clockify-time-entry/scripts/service.mjs';
import { withLock, readJson } from '../skills/clockify-time-entry/scripts/config.mjs';
import { fixture, entryInput, jsonResponse } from './helpers.mjs';

test('creates the authenticated user entry and returns the confirmed receipt', async (t) => {
  const { service, provider } = await fixture(t);
  const result = await service.create(entryInput());
  assert.equal(result.ok, true);
  assert.equal(result.results[0].status, 'created');
  assert.equal(result.results[0].id, 'entry-1');
  assert.equal(result.results[0].durationMinutes, 120);
  assert.equal(provider.posts[0].endpoint, '/workspaces/workspace-1/time-entries');
  assert.equal(provider.posts[0].body.projectId, 'project-1');
  assert.equal(provider.posts[0].body.billable, true);
  assert.equal(provider.posts[0].body.start, '2026-09-25T16:00:00.000Z');
  assert.equal(provider.posts[0].options.redirect, 'error');
});

test('preview creates neither Clockify entries nor a local config/lock/journal', async (t) => {
  const { service, provider, directory } = await fixture(t);
  const result = await service.create(entryInput(), { preview: true });
  assert.equal(result.preview, true);
  assert.equal(result.entries[0].durationMinutes, 120);
  assert.equal(provider.posts.length, 0);
  await assert.rejects(fs.stat(directory), { code: 'ENOENT' });
});

test('creates entries with the duration rounded up to the next quarter hour', async (t) => {
  const { service, provider } = await fixture(t);
  const preview = await service.create(entryInput({ durationMinutes: 50 }), { preview: true });
  assert.equal(preview.entries[0].durationMinutes, 60);
  assert.equal(preview.entries[0].payload.end, '2026-09-25T17:00:00.000Z');
  const result = await service.create(entryInput({ end: '10:07', durationMinutes: undefined }));
  assert.equal(result.results[0].status, 'created');
  assert.equal(result.results[0].durationMinutes, 75);
  assert.equal(provider.posts[0].body.start, '2026-09-25T16:00:00.000Z');
  assert.equal(provider.posts[0].body.end, '2026-09-25T17:15:00.000Z');
});

test('a future end is logged only with an explicit allowFuture opt-in', async (t) => {
  const { service, provider } = await fixture(t);
  const planned = { date: '2026-09-29', start: '12:00', durationMinutes: 90 };
  await assert.rejects(service.create(entryInput(planned)), { code: 'FUTURE_ENTRY' });
  await assert.rejects(service.create(entryInput({ ...planned, allowFuture: 'yes' })), { code: 'INVALID_INPUT' });
  assert.equal(provider.posts.length, 0);
  const result = await service.create(entryInput({ ...planned, allowFuture: true }));
  assert.equal(result.results[0].status, 'created');
  assert.equal(result.results[0].end, '2026-09-29T20:30:00.000Z');
  assert.equal(provider.posts[0].body.end, '2026-09-29T20:30:00.000Z');
  assert.equal(Object.hasOwn(provider.posts[0].body, 'allowFuture'), false);
});

test('validates an entire batch before creating its first entry', async (t) => {
  const { service, provider } = await fixture(t);
  await assert.rejects(service.create([entryInput(), entryInput({ start: undefined })]), { code: 'START_REQUIRED' });
  assert.equal(provider.calls.length, 0);
});

test('duplicate project names require an explicit ID', async (t) => {
  const { service, provider } = await fixture(t);
  provider.projects.push({ id: 'project-2', name: 'PROJECT ALPHA', clientName: 'Other Client' });
  await assert.rejects(service.create(entryInput()), (error) => error.code === 'AMBIGUOUS_PROJECT' && error.details.candidates.length === 2);
  assert.equal(provider.posts.length, 0);
  const result = await service.create(entryInput({ project: undefined, projectId: 'project-2' }));
  assert.equal(result.results[0].project.id, 'project-2');
});

test('requires real active projects and workspace-required values', async (t) => {
  const { service, provider } = await fixture(t);
  await assert.rejects(service.create(entryInput({ project: 'Missing' })), { code: 'PROJECT_NOT_FOUND' });
  provider.workspaces[0].workspaceSettings = { forceProjects: true, forceTasks: true, forceTags: true };
  assert.equal((await service.create(entryInput({ project: undefined }))).error.code, 'REQUIRED_FIELDS');
  assert.equal((await service.create(entryInput())).error.code, 'REQUIRED_FIELDS');
  assert.equal((await service.create(entryInput({ taskId: 'task-1' }))).error.code, 'REQUIRED_FIELDS');
  const result = await service.create(entryInput({ taskId: 'task-1', tagIds: ['tag-1'] }));
  assert.equal(result.ok, true);
  assert.equal(provider.posts.length, 1);
});

test('can log without a project and honors explicit nonbillable requests', async (t) => {
  const { service, provider } = await fixture(t);
  assert.equal((await service.create(entryInput({ project: undefined, billable: false }))).ok, true);
  assert.equal(provider.posts[0].body.projectId, null);
  assert.equal(provider.posts[0].body.billable, false);
});

test('surfaces provider-required custom fields and permits a corrected request', async (t) => {
  const { service, provider } = await fixture(t);
  provider.postHandlers.push(() => jsonResponse({ message: 'Custom field Cost Center is required' }, 400));
  const rejected = await service.create(entryInput());
  assert.equal(rejected.error.code, 'API_REJECTED');
  assert.match(rejected.error.reason, /Cost Center/);
  const accepted = await service.create(entryInput({ customFields: [{ customFieldId: 'field-1', value: 'Engineering' }] }));
  assert.equal(accepted.results[0].status, 'created');
  assert.equal(provider.posts[1].body.customFields[0].value, 'Engineering');
});

test('shares duplicate receipts across independent service instances', async (t) => {
  const { service, provider, directory, config, dependencies } = await fixture(t);
  await service.create(entryInput());
  const otherAgent = new ClockifyService(provider.apiFactory(), config, directory, dependencies);
  const repeated = await otherAgent.create(entryInput());
  assert.equal(repeated.results[0].status, 'already_recorded');
  assert.equal(provider.posts.length, 1);
});

test('detects pre-existing entries before posting', async (t) => {
  const { service, provider } = await fixture(t);
  const prepared = await service.prepare(entryInput());
  provider.save(prepared[0].payload);
  const result = await service.create(entryInput());
  assert.equal(result.results[0].status, 'already_exists');
  assert.equal(provider.posts.length, 0);
});

test('a response lost after creation is reconciled without a second POST', async (t) => {
  const { service, provider } = await fixture(t);
  provider.postHandlers.push((body) => { provider.save(body); throw new Error('lost connection'); });
  const uncertain = await service.create(entryInput());
  assert.equal(uncertain.error.code, 'WRITE_UNCERTAIN');
  const recovered = await service.create(entryInput());
  assert.equal(recovered.results[0].status, 'reconciled');
  assert.equal(recovered.results[0].id, 'entry-1');
  assert.equal(provider.posts.length, 1);
});

test('an uncertain absent write stays blocked, including changed descriptions', async (t) => {
  const { service, provider } = await fixture(t);
  provider.postHandlers.push(() => { throw new Error('timeout'); });
  assert.equal((await service.create(entryInput())).error.code, 'WRITE_UNCERTAIN');
  assert.equal((await service.create(entryInput())).error.code, 'WRITE_UNCERTAIN');
  assert.equal((await service.create(entryInput({ description: 'Changed work' }))).error.code, 'WRITE_UNCERTAIN');
  assert.equal(provider.posts.length, 1);
});

test('a changed request first reconciles the original and stops', async (t) => {
  const { service, provider } = await fixture(t);
  provider.postHandlers.push((body) => { provider.save(body); throw new Error('timeout'); });
  await service.create(entryInput());
  const changed = await service.create(entryInput({ description: 'Changed work' }));
  assert.equal(changed.error.code, 'RECONCILED_DIFFERENT_REQUEST');
  assert.equal(changed.error.id, 'entry-1');
  assert.equal(provider.posts.length, 1);
});

test('server errors and malformed successful responses remain uncertain', async (t) => {
  for (const response of [jsonResponse({ message: 'failed' }, 503), new Response('not json', { status: 201 }), jsonResponse({ id: 'wrong-receipt' }, 201), jsonResponse({}, 200)]) {
    const { service, provider } = await fixture(t);
    provider.postHandlers.push(() => response);
    assert.equal((await service.create(entryInput())).error.code, 'WRITE_UNCERTAIN');
    assert.equal((await service.create(entryInput())).error.code, 'WRITE_UNCERTAIN');
    assert.equal(provider.posts.length, 1);
  }
});

test('reconciliation with multiple matches stays unresolved', async (t) => {
  const { service, provider } = await fixture(t);
  provider.postHandlers.push((body) => { provider.save(body); provider.save(body); throw new Error('timeout'); });
  await service.create(entryInput());
  const result = await service.create(entryInput());
  assert.equal(result.error.code, 'WRITE_UNCERTAIN');
  assert.equal(result.error.matchingEntries.length, 2);
  assert.equal(provider.posts.length, 1);
});

test('partial batch retains success and resumes only the known rejected work', async (t) => {
  const { service, provider } = await fixture(t);
  const input = [entryInput(), entryInput({ start: '12:00' }), entryInput({ start: '15:00' })];
  provider.postHandlers.push((body) => jsonResponse(provider.save(body), 201), () => jsonResponse({ message: 'Slow down' }, 429, { 'Retry-After': '60' }));
  const partial = await service.create(input);
  assert.equal(partial.ok, false);
  assert.equal(partial.results.length, 1);
  assert.equal(partial.failedIndex, 1);
  assert.equal(partial.remaining, 1);
  assert.equal(partial.error.code, 'RATE_LIMITED');
  assert.equal(partial.error.retryAfter, '60');
  assert.equal(provider.posts.length, 2);
  const resumed = await service.create(input);
  assert.equal(resumed.results[0].status, 'already_recorded');
  assert.equal(provider.entries.length, 3);
  assert.equal(provider.posts.length, 4);
});

test('write lock blocks another agent without sending a request and is released on failure', async (t) => {
  const { service, directory, provider } = await fixture(t);
  await withLock(directory, async () => {
    await assert.rejects(service.create(entryInput()), { code: 'LOCKED' });
    assert.equal(provider.calls.length, 0);
  });
  await assert.rejects(service.create(entryInput({ description: '' })), { code: 'DESCRIPTION_REQUIRED' });
  assert.equal((await service.create(entryInput())).ok, true);
});

test('attempt records are private and a corrupt journal cannot be bypassed', async (t) => {
  const { service, directory, provider } = await fixture(t);
  await service.create(entryInput());
  const attempts = path.join(directory, 'attempts');
  const [name] = await fs.readdir(attempts);
  const file = path.join(attempts, name);
  assert.equal((await fs.stat(file)).mode & 0o777, 0o600);
  assert.equal((await fs.stat(attempts)).mode & 0o777, 0o700);
  const record = await readJson(file);
  assert.equal(record.state, 'succeeded');
  assert.equal(JSON.stringify(record).includes('fake-clockify-key'), false);
  await fs.writeFile(file, '{broken');
  const result = await service.create(entryInput({ start: '12:00' }));
  assert.equal(result.error.code, 'CORRUPT_STATE');
  assert.equal(provider.posts.length, 1);
});

test('rejects an environment key for a different account before any write', async (t) => {
  const { service, provider } = await fixture(t);
  provider.user = { id: 'different-user' };
  await assert.rejects(service.create(entryInput()), { code: 'ACCOUNT_CHANGED' });
  assert.equal(provider.posts.length, 0);
});

test('exposes reference data and uses the saved timezone for entry reads', async (t) => {
  const { service, provider } = await fixture(t);
  const context = await service.projects({ details: true, projectId: 'project-1' });
  assert.equal(context.projects[0].id, 'project-1');
  assert.equal(context.tasks[0].id, 'task-1');
  assert.equal(context.tags[0].id, 'tag-1');
  assert.deepEqual(context.customFields, []);
  await service.entries('2026-03-08');
  const call = provider.calls.at(-1);
  assert.equal(call.url.searchParams.get('start'), '2026-03-08T08:00:00.000Z');
  assert.equal(call.url.searchParams.get('end'), '2026-03-09T06:59:59.999Z');
});
