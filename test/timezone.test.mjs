import test from 'node:test';
import assert from 'node:assert/strict';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { run } from '../skills/clockify-time-entry/scripts/cli.mjs';
import { loadConfig, withLock, writeJson } from '../skills/clockify-time-entry/scripts/config.mjs';
import { fixture, entryInput, TEST_KEY, jsonResponse } from './helpers.mjs';

async function configured(t) {
  const context = await fixture(t);
  const { provider, config, directory } = context;
  config.user = { id: provider.user.id, name: provider.user.name };
  provider.user.settings = { timeZone: 'Europe/Paris' };
  const file = path.join(directory, 'config.json');
  await writeJson(file, config);
  return { ...context, file };
}

test('timezone compares the saved and Clockify settings without writing anything', async (t) => {
  const { dependencies, provider, directory, file } = await configured(t);
  const before = await fs.readFile(file, 'utf8');
  const result = await run(['timezone'], dependencies);
  assert.deepEqual(result, { ok: true, timezone: 'America/Los_Angeles', clockifyTimezone: 'Europe/Paris', matchesClockify: false, automatic: true });
  assert.equal(await fs.readFile(file, 'utf8'), before);
  assert.deepEqual(provider.calls.map(({ method, endpoint }) => [method, endpoint]), [['GET', '/user']]);
  assert.deepEqual((await fs.readdir(directory)).sort(), ['config.json']);
});

test('sync updates only the saved timezone, keeping credentials, preferences, and attempts', async (t) => {
  const { dependencies, provider, directory, file, config } = await configured(t);
  config.region = 'eu';
  config.futurePreference = 'preserve this';
  await writeJson(file, config);
  const receipt = path.join(directory, 'attempts', 'existing.json');
  await writeJson(receipt, { state: 'pending', payload: { start: '2026-09-25T16:00:00Z' } });
  const receiptBefore = await fs.readFile(receipt, 'utf8');
  const result = await run(['timezone', '--sync'], dependencies);
  assert.deepEqual(result, { ok: true, previousTimezone: 'America/Los_Angeles', timezone: 'Europe/Paris', changed: true, source: 'clockify', automatic: true });
  assert.deepEqual(await loadConfig(directory, {}), { ...config, timezone: 'Europe/Paris', timezoneMode: 'clockify' });
  assert.equal(await fs.readFile(receipt, 'utf8'), receiptBefore);
  assert.equal((await fs.stat(file)).mode & 0o777, 0o600);
  assert.equal((await fs.stat(directory)).mode & 0o777, 0o700);
  assert.equal(JSON.stringify(result).includes(TEST_KEY), false);
  assert.ok(provider.calls.every((call) => call.method === 'GET' && call.endpoint === '/user' && call.url.hostname === 'euc1.clockify.me'));
  await assert.rejects(fs.stat(path.join(directory, 'write.lock')), { code: 'ENOENT' });
});

test('sync picks up subsequent Clockify changes and does not rewrite an unchanged file', async (t) => {
  const { dependencies, provider, file } = await configured(t);
  await run(['timezone', '--sync'], dependencies);
  const before = await fs.stat(file);
  assert.equal((await run(['timezone', '--sync'], dependencies)).changed, false);
  const after = await fs.stat(file);
  assert.equal(after.ino, before.ino);
  assert.equal(after.mtimeMs, before.mtimeMs);
  provider.user.settings.timeZone = 'Asia/Tokyo';
  const changed = await run(['timezone', '--sync'], dependencies);
  assert.equal(changed.previousTimezone, 'Europe/Paris');
  assert.equal(changed.timezone, 'Asia/Tokyo');
  assert.equal((await run(['timezone'], dependencies)).matchesClockify, true);
});

test('later commands use the synced timezone while entry-specific overrides still apply', async (t) => {
  const { dependencies, provider, root } = await configured(t);
  await run(['timezone', '--sync'], dependencies);
  assert.equal((await run(['status'], dependencies)).timezone, 'Europe/Paris');
  const file = path.join(root, 'entry.json');
  await fs.writeFile(file, JSON.stringify(entryInput()));
  const preview = await run(['create', '--input', file, '--preview'], dependencies);
  assert.equal(preview.entries[0].payload.start, '2026-09-25T07:00:00.000Z');
  await fs.writeFile(file, JSON.stringify(entryInput({ timezone: 'America/Los_Angeles' })));
  const override = await run(['create', '--input', file, '--preview'], dependencies);
  assert.equal(override.entries[0].payload.start, '2026-09-25T16:00:00.000Z');
  assert.equal(provider.posts.length + provider.puts.length, 0);
});

for (const [label, settings, code] of [
  ['missing settings', undefined, 'CLOCKIFY_TIMEZONE_UNAVAILABLE'],
  ['null settings', null, 'CLOCKIFY_TIMEZONE_UNAVAILABLE'],
  ['an empty timezone', { timeZone: '' }, 'CLOCKIFY_TIMEZONE_UNAVAILABLE'],
  ['an invalid timezone', { timeZone: 'Mars/Olympus' }, 'INVALID_TIMEZONE'],
]) {
  test(`sync preserves the saved timezone when Clockify returns ${label}`, async (t) => {
    const { dependencies, provider, file } = await configured(t);
    provider.user.settings = settings;
    const before = await fs.readFile(file, 'utf8');
    await assert.rejects(run(['timezone', '--sync'], dependencies), { code });
    assert.equal(await fs.readFile(file, 'utf8'), before);
    assert.equal(provider.posts.length + provider.puts.length, 0);
  });
}

for (const [status, code] of [[401, 'AUTHENTICATION_FAILED'], [429, 'RATE_LIMITED'], [503, 'API_REJECTED']]) {
  test(`a ${status} response leaves configuration intact without a retry`, async (t) => {
    const { dependencies, provider, file } = await configured(t);
    provider.intercept = () => jsonResponse({}, status);
    const before = await fs.readFile(file, 'utf8');
    await assert.rejects(run(['timezone', '--sync'], dependencies), { code });
    assert.equal(await fs.readFile(file, 'utf8'), before);
    assert.equal(provider.calls.length, 1);
  });
}

test('a network failure releases the lock and preserves configuration', async (t) => {
  const { dependencies, provider, file, directory } = await configured(t);
  provider.intercept = () => { throw new Error('offline'); };
  const before = await fs.readFile(file, 'utf8');
  await assert.rejects(run(['timezone', '--sync'], dependencies), { code: 'NETWORK_ERROR' });
  assert.equal(await fs.readFile(file, 'utf8'), before);
  await assert.rejects(fs.stat(path.join(directory, 'write.lock')), { code: 'ENOENT' });
});

test('cannot sync timezone from a different API key owner', async (t) => {
  const { dependencies, provider, file } = await configured(t);
  provider.user.id = 'another-user';
  const before = await fs.readFile(file, 'utf8');
  await assert.rejects(run(['timezone', '--sync'], dependencies), { code: 'ACCOUNT_CHANGED' });
  assert.equal(await fs.readFile(file, 'utf8'), before);
});

test('an environment key is used but never persisted or exposed by sync', async (t) => {
  const { dependencies, provider, directory, file, config } = await configured(t);
  delete config.apiKey;
  await writeJson(file, config);
  const env = { CLOCKIFY_API_KEY: 'fake-environment-timezone-key' };
  const result = await run(['timezone', '--sync'], { ...dependencies, env });
  assert.equal(provider.calls[0].options.headers['X-Api-Key'], env.CLOCKIFY_API_KEY);
  assert.equal((await loadConfig(directory, {})).apiKey, undefined);
  assert.equal(JSON.stringify(result).includes(env.CLOCKIFY_API_KEY), false);
});

test('sync respects the shared write lock before contacting Clockify', async (t) => {
  const { dependencies, provider, directory } = await configured(t);
  await withLock(directory, async () => {
    await assert.rejects(run(['timezone', '--sync'], dependencies), { code: 'LOCKED' });
    assert.equal(provider.calls.length, 0);
  });
});

test('timezone requires setup and rejects unsupported options', async (t) => {
  const { dependencies, provider, directory } = await fixture(t);
  await assert.rejects(run(['timezone'], dependencies), { code: 'SETUP_REQUIRED' });
  await assert.rejects(run(['timezone', '--set', 'Europe/Paris'], dependencies), { code: 'INVALID_OPTION' });
  assert.equal(provider.calls.length, 0);
  await assert.rejects(fs.stat(directory), { code: 'ENOENT' });
});

test('both installed agents can sync using the shared configuration', async (t) => {
  const { dependencies, provider } = await configured(t);
  const installed = await run(['setup'], dependencies);
  for (const [index, target] of installed.installed.entries()) {
    provider.user.settings.timeZone = index === 0 ? 'Europe/Paris' : 'Asia/Tokyo';
    const { run: installedRun } = await import(pathToFileURL(path.join(target.path, 'scripts', 'cli.mjs')).href);
    const result = await installedRun(['timezone', '--sync'], dependencies);
    assert.equal(result.timezone, provider.user.settings.timeZone);
    assert.equal((await run(['status'], dependencies)).timezone, result.timezone);
  }
  assert.equal(provider.posts.length + provider.puts.length, 0);
});

test('existing installations automatically follow the profile before creating an entry', async (t) => {
  const { dependencies, provider, config, directory, root } = await configured(t);
  const input = path.join(root, 'entry.json');
  await fs.writeFile(input, JSON.stringify(entryInput()));
  const result = await run(['create', '--input', input], dependencies);
  assert.equal(result.results[0].start, '2026-09-25T07:00:00.000Z');
  assert.equal(result.results[0].timezone, 'Europe/Paris');
  assert.deepEqual(await loadConfig(directory, {}), { ...config, timezone: 'Europe/Paris' });
  assert.equal(provider.calls.filter((call) => call.endpoint === '/user').length, 1);
});

test('automatic preview uses the current zone without saving preferences or a journal', async (t) => {
  const { dependencies, provider, file, directory, root } = await configured(t);
  const before = await fs.readFile(file, 'utf8');
  const input = path.join(root, 'preview.json');
  await fs.writeFile(input, JSON.stringify(entryInput()));
  const result = await run(['create', '--input', input, '--preview'], dependencies);
  assert.equal(result.entries[0].payload.start, '2026-09-25T07:00:00.000Z');
  assert.equal(result.entries[0].timezone, 'Europe/Paris');
  assert.equal(await fs.readFile(file, 'utf8'), before);
  assert.deepEqual(await fs.readdir(directory), ['config.json']);
  assert.equal(provider.posts.length + provider.puts.length, 0);
});

test('relative dates and entry reads use the refreshed timezone across a date boundary', async (t) => {
  const { dependencies, provider, root, file } = await configured(t);
  provider.user.settings.timeZone = 'Asia/Tokyo';
  const input = path.join(root, 'entry.json');
  await fs.writeFile(input, JSON.stringify(entryInput({ date: 'yesterday' })));
  const preview = await run(['create', '--input', input, '--preview'], dependencies);
  assert.equal(preview.entries[0].payload.start, '2026-09-29T00:00:00.000Z');
  const before = await fs.readFile(file, 'utf8');
  const entries = await run(['entries', '--date', 'today'], dependencies);
  assert.equal(entries.timezone, 'Asia/Tokyo');
  assert.equal(entries.start, '2026-09-29T15:00:00.000Z');
  assert.equal(await fs.readFile(file, 'utf8'), before);
});

test('automatic exact-slot updates and explicit time changes use the profile timezone', async (t) => {
  const { dependencies, service, provider, root } = await configured(t);
  const [prepared] = await service.prepare(entryInput({ timezone: 'Europe/Paris' }));
  const old = provider.save(prepared.payload);
  provider.calls = [];
  const input = path.join(root, 'entry.json');
  await fs.writeFile(input, JSON.stringify(entryInput({ description: 'Actual work' })));
  const matched = await run(['create', '--input', input], dependencies);
  assert.equal(matched.results[0].status, 'updated');
  assert.equal(matched.results[0].id, old.id);
  assert.equal(provider.calls.filter((call) => call.endpoint === '/user').length, 1);
  provider.user.settings.timeZone = 'Asia/Tokyo';
  await fs.writeFile(input, JSON.stringify({ id: old.id, start: '09:00', date: '2026-09-25', durationMinutes: 60 }));
  const moved = await run(['update', '--input', input], dependencies);
  assert.equal(moved.results[0].id, old.id);
  assert.equal(moved.results[0].start, '2026-09-25T00:00:00.000Z');
  assert.equal(moved.results[0].timezone, 'Asia/Tokyo');
  assert.equal(provider.posts.length, 0);
});

test('a batch uses one timezone even if the profile changes during its writes', async (t) => {
  const { dependencies, service, provider, root } = await configured(t);
  const second = entryInput({ start: '12:00', description: 'Afternoon fixes' });
  const [prepared] = await service.prepare({ ...second, timezone: 'Europe/Paris' });
  const old = provider.save(prepared.payload);
  provider.calls = [];
  provider.postHandlers.push((body) => {
    provider.user.settings.timeZone = 'Asia/Tokyo';
    return jsonResponse(provider.save(body), 201);
  });
  const input = path.join(root, 'entries.json');
  await fs.writeFile(input, JSON.stringify([entryInput(), { ...second, description: 'Afternoon review' }]));
  const result = await run(['create', '--input', input], dependencies);
  assert.equal(result.results[0].start, '2026-09-25T07:00:00.000Z');
  assert.equal(result.results[1].start, '2026-09-25T10:00:00.000Z');
  assert.equal(result.results[1].id, old.id);
  assert.equal(provider.calls.filter((call) => call.endpoint === '/user').length, 1);
  await fs.writeFile(input, JSON.stringify(entryInput()));
  const next = await run(['create', '--input', input, '--preview'], dependencies);
  assert.equal(next.entries[0].payload.start, '2026-09-25T00:00:00.000Z');
});

test('a fixed setup timezone is honored until automatic mode is explicitly restored', async (t) => {
  const { dependencies, provider, root, directory } = await configured(t);
  await run(['setup', '--timezone', 'America/Los_Angeles'], dependencies);
  provider.user.settings = null;
  const input = path.join(root, 'entry.json');
  await fs.writeFile(input, JSON.stringify(entryInput()));
  const fixed = await run(['create', '--input', input, '--preview'], dependencies);
  assert.equal(fixed.entries[0].payload.start, '2026-09-25T16:00:00.000Z');
  assert.equal((await run(['status'], dependencies)).timezoneMode, 'fixed');
  provider.user.settings = { timeZone: 'Europe/Paris' };
  await run(['setup', '--timezone', 'auto'], dependencies);
  assert.equal((await loadConfig(directory, {})).timezoneMode, 'clockify');
  const automatic = await run(['create', '--input', input, '--preview'], dependencies);
  assert.equal(automatic.entries[0].payload.start, '2026-09-25T07:00:00.000Z');
});

test('explicit sync resumes automatic mode even when the two timezone values match', async (t) => {
  const { dependencies, config, directory, file } = await configured(t);
  await writeJson(file, { ...config, timezone: 'Europe/Paris', timezoneMode: 'fixed' });
  const result = await run(['timezone', '--sync'], dependencies);
  assert.equal(result.changed, false);
  assert.equal(result.automatic, true);
  assert.equal((await loadConfig(directory, {})).timezoneMode, 'clockify');
});

for (const [label, settings, code] of [
  ['missing', null, 'CLOCKIFY_TIMEZONE_UNAVAILABLE'],
  ['invalid', { timeZone: 'Mars/Olympus' }, 'INVALID_TIMEZONE'],
]) {
  test(`automatic mode stops before logging if the profile timezone is ${label}`, async (t) => {
    const { dependencies, provider, root, file } = await configured(t);
    provider.user.settings = settings;
    const before = await fs.readFile(file, 'utf8');
    const input = path.join(root, 'entry.json');
    await fs.writeFile(input, JSON.stringify(entryInput()));
    await assert.rejects(run(['create', '--input', input], dependencies), { code });
    assert.equal(await fs.readFile(file, 'utf8'), before);
    assert.equal(provider.posts.length + provider.puts.length, 0);
  });
}

test('a timezone change cannot bypass an uncertain creation, including legacy receipts', async (t) => {
  for (const legacy of [false, true]) {
    const { dependencies, provider, root, directory } = await configured(t);
    provider.user.settings.timeZone = 'America/Los_Angeles';
    const input = path.join(root, 'entry.json');
    await fs.writeFile(input, JSON.stringify(entryInput()));
    provider.postHandlers.push((body) => { provider.save(body); throw new Error('lost response'); });
    assert.equal((await run(['create', '--input', input], dependencies)).error.code, 'WRITE_UNCERTAIN');
    const attempts = path.join(directory, 'attempts');
    const [name] = await fs.readdir(attempts);
    const receiptFile = path.join(attempts, name);
    const receipt = JSON.parse(await fs.readFile(receiptFile, 'utf8'));
    assert.equal(receipt.timezone, 'America/Los_Angeles');
    if (legacy) { delete receipt.timezone; await writeJson(receiptFile, receipt); }
    provider.user.settings.timeZone = 'Europe/Paris';
    const blocked = await run(['create', '--input', input], dependencies);
    assert.equal(blocked.error.code, 'WRITE_UNCERTAIN');
    assert.equal(blocked.error.originalStart, '2026-09-25T16:00:00.000Z');
    assert.equal(provider.posts.length + provider.puts.length, 1);
    await fs.writeFile(input, JSON.stringify(entryInput({ timezone: 'America/Los_Angeles' })));
    const reconciled = await run(['create', '--input', input], dependencies);
    assert.equal(reconciled.results[0].status, 'reconciled');
    assert.equal(provider.entries.length, 1);
    assert.equal(provider.posts.length + provider.puts.length, 1);
  }
});

test('a changed timezone cannot redirect an uncertain request onto another existing entry', async (t) => {
  const { dependencies, service, provider, root } = await configured(t);
  const [other] = await service.prepare(entryInput({ timezone: 'Europe/Paris', description: 'Other work' }));
  const otherEntry = provider.save(other.payload);
  provider.user.settings.timeZone = 'America/Los_Angeles';
  const input = path.join(root, 'entry.json');
  await fs.writeFile(input, JSON.stringify(entryInput()));
  provider.postHandlers.push(() => { throw new Error('unknown result'); });
  assert.equal((await run(['create', '--input', input], dependencies)).error.code, 'WRITE_UNCERTAIN');
  provider.user.settings.timeZone = 'Europe/Paris';
  const blocked = await run(['create', '--input', input], dependencies);
  assert.equal(blocked.error.code, 'WRITE_UNCERTAIN');
  assert.equal(provider.entries.find((entry) => entry.id === otherEntry.id).description, 'Other work');
  assert.equal(provider.puts.length, 0);
});

test('partial batch recovery can skip confirmed entries while reconciling a pending one', async (t) => {
  const { dependencies, provider, root } = await configured(t);
  provider.user.settings.timeZone = 'America/Los_Angeles';
  const batch = [entryInput(), entryInput({ start: '12:00' })];
  const input = path.join(root, 'entries.json');
  await fs.writeFile(input, JSON.stringify(batch));
  provider.postHandlers.push((body) => jsonResponse(provider.save(body), 201), (body) => { provider.save(body); throw new Error('lost response'); });
  const partial = await run(['create', '--input', input], dependencies);
  assert.equal(partial.results[0].status, 'created');
  assert.equal(partial.error.code, 'WRITE_UNCERTAIN');
  provider.user.settings.timeZone = 'Europe/Paris';
  await fs.writeFile(input, JSON.stringify(batch.map((entry) => ({ ...entry, timezone: 'America/Los_Angeles' }))));
  const resumed = await run(['create', '--input', input], dependencies);
  assert.equal(resumed.results[0].status, 'already_recorded');
  assert.equal(resumed.results[1].status, 'reconciled');
  assert.equal(provider.posts.length, 2);
  assert.equal(provider.puts.length, 0);
});
