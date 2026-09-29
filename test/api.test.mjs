import test from 'node:test';
import assert from 'node:assert/strict';
import { ClockifyApi } from '../skills/clockify-time-entry/scripts/api.mjs';
import { redact, errorResult, rememberSecret, jsonOutput } from '../skills/clockify-time-entry/scripts/errors.mjs';
import { TEST_KEY, jsonResponse } from './helpers.mjs';

test('paginates using page-size and Last-Page even for short intermediate pages', async () => {
  const pages = [];
  const api = new ClockifyApi(TEST_KEY, 'global', { fetchImpl: async (url) => {
    const page = Number(url.searchParams.get('page'));
    pages.push(page);
    assert.equal(url.searchParams.get('page-size'), '200');
    return jsonResponse([{ id: page }], 200, { 'Last-Page': page === 2 ? 'true' : 'false' });
  } });
  assert.deepEqual(await api.list('/workspaces/workspace-1/projects'), [{ id: 1 }, { id: 2 }]);
  assert.deepEqual(pages, [1, 2]);
});

test('without Last-Page, reads until a short page and never silently truncates', async () => {
  let calls = 0;
  const api = new ClockifyApi(TEST_KEY, 'global', { fetchImpl: async () => jsonResponse(++calls === 1 ? Array.from({ length: 200 }, (_, id) => ({ id })) : [{ id: 200 }]) });
  assert.equal((await api.list('/projects')).length, 201);
  assert.equal(calls, 2);
  const endless = new ClockifyApi(TEST_KEY, 'global', { fetchImpl: async () => jsonResponse([], 200, { 'Last-Page': 'false' }) });
  await assert.rejects(endless.list('/projects'), { code: 'INCOMPLETE_LIST' });
});

test('rate limits stop reads immediately and retain retry guidance', async () => {
  let calls = 0;
  const api = new ClockifyApi(TEST_KEY, 'global', { fetchImpl: async () => { calls++; return jsonResponse({}, 429, { 'Retry-After': '120' }); } });
  await assert.rejects(api.list('/projects'), (error) => error.code === 'RATE_LIMITED' && error.details.retryAfter === '120');
  assert.equal(calls, 1);
});

test('network exception details and provider validation messages cannot leak credentials', async () => {
  const api = new ClockifyApi(TEST_KEY, 'global', { fetchImpl: async () => { throw new Error(`unsafe message ${TEST_KEY}`); } });
  await assert.rejects(api.get('/user'), (error) => error.code === 'NETWORK_ERROR' && !JSON.stringify(errorResult(error)).includes(TEST_KEY));
  const echo = new ClockifyApi(TEST_KEY, 'global', { fetchImpl: async () => jsonResponse({ message: `key=${TEST_KEY}` }, 400) });
  await assert.rejects(echo.get('/user'), (error) => !redact(JSON.stringify(errorResult(error))).includes(TEST_KEY));
});

test('the production API accepts only known Clockify regions and rejects redirects', async () => {
  assert.throws(() => new ClockifyApi(TEST_KEY, 'https://example.com'), { code: 'INVALID_REGION' });
  const api = new ClockifyApi(TEST_KEY, 'uk', { fetchImpl: async (url, options) => {
    assert.equal(url.hostname, 'euw2.clockify.me');
    assert.equal(options.redirect, 'error');
    assert.equal(options.headers['X-Api-Key'], TEST_KEY);
    return jsonResponse({}, 403);
  } });
  await assert.rejects(api.get('/user'), { code: 'ACCESS_DENIED' });
});

test('output redacts credentials containing JSON metacharacters and remains parseable', () => {
  const unusualKey = 'fake-key-"quoted"-\\slash';
  rememberSecret(unusualKey);
  const output = jsonOutput({ ok: false, reason: `Rejected ${unusualKey}`, encoded: encodeURIComponent(unusualKey) });
  const parsed = JSON.parse(output);
  assert.equal(parsed.reason, 'Rejected [REDACTED]');
  assert.equal(parsed.encoded, '[REDACTED]');
});
