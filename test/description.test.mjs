import test from 'node:test';
import assert from 'node:assert/strict';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { canonical, entryPayload } from '../skills/clockify-time-entry/scripts/entries.mjs';
import { writeJson } from '../skills/clockify-time-entry/scripts/config.mjs';
import { fixture, entryInput } from './helpers.mjs';

const verbose = 'MCP tooling unification shipped with golden snapshots of every model-visible tool set, per-call invocation metrics on every surface, declared effects in tool metadata, and contract violation monitoring, alongside assistant fixes and marketing improvements.';
const concise = 'MCP unification and assistant fixes';
const digest = (value) => createHash('sha256').update(JSON.stringify(canonical(value))).digest('hex');

async function seed(service, provider, description = 'Original work') {
  const [prepared] = await service.prepare(entryInput({ description }));
  return provider.save(prepared.payload);
}

for (const [name, description, code] of [
  ['the verbose work recap', verbose, 'DESCRIPTION_TOO_LONG'],
  ['13 short words', Array(13).fill('fix').join(' '), 'DESCRIPTION_TOO_LONG'],
  ['101 characters', 'é'.repeat(101), 'DESCRIPTION_TOO_LONG'],
  ['multiple lines', 'MCP unification\nAssistant fixes', 'DESCRIPTION_MULTILINE'],
  ['Unicode line separators', 'MCP unification\u2028Assistant fixes', 'DESCRIPTION_MULTILINE'],
]) {
  test(`rejects ${name} without writing or silently truncating`, async (t) => {
    const { service, provider, directory } = await fixture(t);
    const result = await service.create(entryInput({ description }));
    assert.equal(result.error.code, code);
    assert.equal(result.error.maxWords, 12);
    assert.equal(result.error.maxCharacters, 100);
    assert.equal(provider.posts.length + provider.puts.length, 0);
    await assert.rejects(fs.stat(path.join(directory, 'attempts')), { code: 'ENOENT' });
  });
}

test('accepts descriptions at the word and Unicode character limits', async (t) => {
  for (const description of [Array(12).fill('fix').join(' '), '界'.repeat(100)]) {
    const { service, provider } = await fixture(t);
    const result = await service.create(entryInput({ description }));
    assert.equal(result.results[0].status, 'created');
    assert.equal(provider.posts[0].body.description, description);
  }
});

test('exact-slot and explicit updates reject long descriptions and preserve the entry', async (t) => {
  const { service, provider } = await fixture(t);
  const old = await seed(service, provider);
  const automatic = await service.create(entryInput({ description: verbose }));
  assert.equal(automatic.error.code, 'DESCRIPTION_TOO_LONG');
  const explicit = await service.update({ id: old.id, description: verbose });
  assert.equal(explicit.error.code, 'DESCRIPTION_TOO_LONG');
  assert.equal(provider.entries[0].description, old.description);
  assert.equal(provider.posts.length + provider.puts.length, 0);
});

test('previews apply the same limit without journal or provider writes', async (t) => {
  const { service, provider, directory } = await fixture(t);
  const old = await seed(service, provider);
  await assert.rejects(service.create(entryInput({ description: verbose }), { preview: true }), { code: 'DESCRIPTION_TOO_LONG' });
  const update = await service.update({ id: old.id, description: verbose }, { preview: true });
  assert.equal(update.error.code, 'DESCRIPTION_TOO_LONG');
  assert.equal(provider.posts.length + provider.puts.length, 0);
  await assert.rejects(fs.stat(directory), { code: 'ENOENT' });
});

test('a time-only correction preserves legacy text, which can later be shortened in place', async (t) => {
  const { service, provider } = await fixture(t);
  const old = await seed(service, provider, verbose);
  const extended = await service.update({ id: old.id, durationMinutes: 150 });
  assert.equal(extended.results[0].status, 'updated');
  assert.equal(provider.puts[0].body.description, verbose);
  const shortened = await service.update({ id: old.id, description: concise });
  assert.equal(shortened.results[0].id, old.id);
  assert.equal(shortened.results[0].durationMinutes, 150);
  assert.equal(provider.entries[0].description, concise);
  assert.equal(provider.entries.length, 1);
  assert.equal(provider.posts.length, 0);
});

test('rejecting a later long description preserves and deduplicates earlier batch successes', async (t) => {
  const { service, provider } = await fixture(t);
  const first = entryInput({ description: concise });
  const partial = await service.create([first, entryInput({ start: '12:00', description: verbose })]);
  assert.equal(partial.results[0].status, 'created');
  assert.equal(partial.failedIndex, 1);
  assert.equal(partial.error.code, 'DESCRIPTION_TOO_LONG');
  assert.equal(provider.posts.length, 1);
  const resumed = await service.create([first, entryInput({ start: '12:00', description: 'Marketing fixes' })]);
  assert.equal(resumed.results[0].status, 'already_recorded');
  assert.equal(resumed.results[1].status, 'created');
  assert.equal(provider.posts.length, 2);
});

test('an older pending creation with long text can still be reconciled without resending', async (t) => {
  const { service, provider, directory } = await fixture(t);
  const [prepared] = await service.prepare(entryInput({ description: verbose }));
  const fingerprint = service.fingerprint(prepared.payload);
  await writeJson(path.join(directory, 'attempts', `${fingerprint}.json`), {
    version: 1, fingerprint, scope: service.scope(), payload: prepared.payload, state: 'pending',
  });
  provider.save(prepared.payload);
  const result = await service.create(entryInput({ description: verbose }));
  assert.equal(result.results[0].status, 'reconciled');
  assert.equal(provider.posts.length + provider.puts.length, 0);
});

test('an older pending update with long text can still be reconciled without resending', async (t) => {
  const { service, provider, directory } = await fixture(t);
  const old = await seed(service, provider);
  const before = entryPayload(old);
  const payload = { ...before, description: verbose };
  const scope = service.scope();
  const fingerprint = digest({ operation: 'update', scope, id: old.id, before, payload });
  await writeJson(path.join(directory, 'attempts', `${fingerprint}.json`), {
    version: 1, operation: 'update', scope, fingerprint, entryId: old.id,
    before, payload, state: 'pending', requestKey: digest({ id: old.id, changes: { description: verbose } }),
  });
  provider.update(old.id, payload);
  const result = await service.update({ id: old.id, description: verbose });
  assert.equal(result.results[0].status, 'reconciled_update');
  assert.equal(provider.posts.length + provider.puts.length, 0);
});
