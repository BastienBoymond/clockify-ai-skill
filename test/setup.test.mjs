import test from 'node:test';
import assert from 'node:assert/strict';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { pathToFileURL } from 'node:url';
import { setup, terminalPrompt } from '../skills/clockify-time-entry/scripts/setup.mjs';
import { run } from '../skills/clockify-time-entry/scripts/cli.mjs';
import { loadConfig, readJson } from '../skills/clockify-time-entry/scripts/config.mjs';
import { redact, errorResult } from '../skills/clockify-time-entry/scripts/errors.mjs';
import { fixture, TEST_KEY, entryInput, jsonResponse } from './helpers.mjs';

test('setup privately requests a key, validates it and installs both self-contained skills', async (t) => {
  const { dependencies, provider, directory } = await fixture(t);
  const prompts = [];
  const result = await setup({}, { ...dependencies, prompt: async (message, options) => { prompts.push({ message, options }); return TEST_KEY; } });
  assert.equal(prompts.length, 1);
  assert.equal(prompts[0].options.secret, true);
  assert.equal(result.installed.length, 2);
  assert.equal(provider.posts.length, 0);
  assert.equal(JSON.stringify(result).includes(TEST_KEY), false);
  const config = await loadConfig(directory, {});
  assert.equal(config.apiKey, TEST_KEY);
  assert.equal((await fs.stat(directory)).mode & 0o777, 0o700);
  assert.equal((await fs.stat(path.join(directory, 'config.json'))).mode & 0o777, 0o600);
  for (const target of result.installed) {
    assert.match(await fs.readFile(path.join(target.path, 'SKILL.md'), 'utf8'), /name: clockify-time-entry/);
    await fs.access(path.join(target.path, 'references', 'commands.md'));
    const { run: installedRun } = await import(pathToFileURL(path.join(target.path, 'scripts', 'cli.mjs')).href);
    const status = await installedRun(['status'], dependencies);
    assert.equal(status.configured, true);
    const inputFile = path.join(directory, `${target.agent}-entry.json`);
    await fs.writeFile(inputFile, JSON.stringify(entryInput()));
    const preview = await installedRun(['create', '--input', inputFile, '--preview'], dependencies);
    assert.equal(preview.preview, true);
    assert.equal(preview.entries[0].payload.description, 'API integration');
    await fs.writeFile(inputFile, JSON.stringify(entryInput({ description: 'Unification details '.repeat(12) })));
    await assert.rejects(installedRun(['create', '--input', inputFile, '--preview'], dependencies), { code: 'DESCRIPTION_TOO_LONG' });
    const alias = path.join(directory, `${target.agent}-helper.mjs`);
    await fs.symlink(path.join(target.path, 'scripts', 'cli.mjs'), alias);
    const invoked = spawnSync(process.execPath, [alias, 'status'], {
      encoding: 'utf8', env: { ...process.env, CLOCKIFY_API_KEY: '', CLOCKIFY_CONFIG_DIR: directory },
    });
    assert.equal(invoked.status, 0, invoked.stderr);
    assert.equal(JSON.parse(invoked.stdout).configured, true);
  }
  assert.equal(provider.posts.length, 0);
});

test('repeated setup reuses credentials/preferences and refreshes managed installs', async (t) => {
  const { dependencies, directory } = await fixture(t);
  const first = await setup({ timezone: 'Europe/Paris', agent: 'claude' }, { ...dependencies, prompt: async () => TEST_KEY });
  const skill = path.join(first.installed[0].path, 'SKILL.md');
  await fs.writeFile(skill, 'outdated installation');
  const next = await setup({ agent: 'claude' }, { ...dependencies, prompt: async () => { throw new Error('Unexpected prompt'); } });
  assert.equal(next.timezone, 'Europe/Paris');
  assert.match(await fs.readFile(skill, 'utf8'), /name: clockify-time-entry/);
  assert.equal((await loadConfig(directory, {})).apiKey, TEST_KEY);
});

test('multiple workspaces ask for a selection and remember it', async (t) => {
  const { dependencies, provider } = await fixture(t);
  provider.workspaces.push({ id: 'workspace-2', name: 'Second Workspace' });
  let questions = 0;
  const result = await setup({}, { ...dependencies, env: { CLOCKIFY_API_KEY: TEST_KEY }, prompt: async () => { questions++; return '2'; } });
  assert.equal(questions, 1);
  assert.equal(result.workspace.id, 'workspace-2');
  await setup({}, { ...dependencies, env: { CLOCKIFY_API_KEY: TEST_KEY }, prompt: async () => { throw new Error('Unexpected prompt'); } });
});

test('unattended setup selects an explicit workspace and does not persist an environment key', async (t) => {
  const { dependencies, provider, directory } = await fixture(t);
  provider.workspaces.push({ id: 'workspace-2', name: 'Other' });
  const result = await setup({ workspace: 'workspace-2', region: 'eu', agent: 'codex' }, { ...dependencies, env: { CLOCKIFY_API_KEY: TEST_KEY } });
  assert.equal(result.installed.length, 1);
  assert.equal(result.installed[0].agent, 'codex');
  assert.equal(result.credentialSource, 'environment (not saved)');
  assert.equal((await loadConfig(directory, {})).apiKey, undefined);
  assert.ok(provider.calls.every((call) => call.url.hostname === 'euc1.clockify.me'));
});

test('invalid key leaves no saved credentials or installed skill', async (t) => {
  const { dependencies, provider, directory, home } = await fixture(t);
  provider.intercept = () => jsonResponse({ message: `Bad key ${TEST_KEY}` }, 401);
  let error;
  try { await setup({}, { ...dependencies, prompt: async () => TEST_KEY }); } catch (caught) { error = caught; }
  assert.equal(error.code, 'AUTHENTICATION_FAILED');
  assert.equal(redact(JSON.stringify(errorResult(error))).includes(TEST_KEY), false);
  assert.equal(await readJson(path.join(directory, 'config.json')), null);
  await assert.rejects(fs.stat(path.join(home, '.claude')), { code: 'ENOENT' });
});

test('key replacement preserves a good saved key if the new key fails', async (t) => {
  const { dependencies, provider, directory } = await fixture(t);
  await setup({}, { ...dependencies, prompt: async () => TEST_KEY });
  provider.intercept = () => jsonResponse({}, 401);
  await assert.rejects(setup({ 'replace-key': true }, { ...dependencies, prompt: async () => 'fake-replacement-key' }), { code: 'AUTHENTICATION_FAILED' });
  assert.equal((await loadConfig(directory, {})).apiKey, TEST_KEY);
  provider.intercept = null;
  await setup({ 'replace-key': true }, { ...dependencies, prompt: async () => 'fake-replacement-key' });
  assert.equal((await loadConfig(directory, {})).apiKey, 'fake-replacement-key');
});

test('environment authentication overrides the saved key without exposing either', async (t) => {
  const { dependencies, provider } = await fixture(t);
  await setup({}, { ...dependencies, prompt: async () => TEST_KEY });
  const env = { CLOCKIFY_API_KEY: 'fake-environment-key' };
  const status = await run(['status'], { ...dependencies, env });
  assert.equal(status.credentialSource, 'environment');
  await run(['projects'], { ...dependencies, env });
  assert.equal(provider.calls.at(-1).options.headers['X-Api-Key'], env.CLOCKIFY_API_KEY);
  assert.equal(JSON.stringify(status).includes('fake-'), false);
  await assert.rejects(setup({ 'replace-key': true }, { ...dependencies, env }), { code: 'ENV_KEY_OVERRIDE' });
});

test('unmanaged skill collisions are detected before prompting or updating either agent', async (t) => {
  const { dependencies, home, directory } = await fixture(t);
  const conflict = path.join(home, '.agents', 'skills', 'clockify-time-entry');
  await fs.mkdir(conflict, { recursive: true });
  await fs.writeFile(path.join(conflict, 'SKILL.md'), 'User-maintained content');
  await assert.rejects(setup({}, { ...dependencies, prompt: async () => { throw new Error('Should not prompt'); } }), { code: 'INSTALL_CONFLICT' });
  assert.equal(await fs.readFile(path.join(conflict, 'SKILL.md'), 'utf8'), 'User-maintained content');
  await assert.rejects(fs.stat(directory), { code: 'ENOENT' });
});

test('noninteractive secret prompts give instructions instead of echoing or accepting a key', async () => {
  await assert.rejects(terminalPrompt('Key:', { secret: true, input: { isTTY: false }, output: { isTTY: false } }), { code: 'INTERACTIVE_SETUP_REQUIRED' });
});

test('rejects insecure or symlinked credential files', async (t) => {
  const { dependencies, directory, root } = await fixture(t);
  await setup({}, { ...dependencies, prompt: async () => TEST_KEY });
  const file = path.join(directory, 'config.json');
  await fs.chmod(file, 0o644);
  await assert.rejects(loadConfig(directory, {}), { code: 'INSECURE_PERMISSIONS' });
  await fs.chmod(file, 0o600);
  const other = path.join(root, 'other.json');
  await fs.rename(file, other);
  await fs.symlink(other, file);
  await assert.rejects(loadConfig(directory, {}), { code: 'UNSAFE_PATH' });
});

test('status and help work without credentials or filesystem writes', async (t) => {
  const { dependencies, provider, directory } = await fixture(t);
  const status = await run(['status'], dependencies);
  assert.equal(status.configured, false);
  assert.match((await run(['--help'], dependencies)).help, /Clockify/);
  assert.equal(provider.calls.length, 0);
  await assert.rejects(fs.stat(directory), { code: 'ENOENT' });
});

test('unknown options never reflect a supplied credential into errors', async (t) => {
  const { dependencies } = await fixture(t);
  await assert.rejects(run(['setup', '--api-key', TEST_KEY], dependencies), (error) => error.code === 'INVALID_OPTION' && !error.message.includes(TEST_KEY));
});

test('hidden terminal input is not echoed and cancellation restores terminal mode', { skip: spawnSync('python3', ['--version']).status !== 0 }, () => {
  const moduleUrl = new URL('../skills/clockify-time-entry/scripts/setup.mjs', import.meta.url).href;
  const script = String.raw`
import os, pty, select, subprocess, sys, termios, time, json
module_url, node = sys.argv[1:]
for cancel in (False, True):
    master, slave = pty.openpty()
    source = 'import {terminalPrompt} from ' + json.dumps(module_url) + '; try { const key = await terminalPrompt("Key: ", {secret:true}); console.log("received=" + key.length); } catch { console.log("cancelled"); }'
    child = subprocess.Popen([node, '--input-type=module', '-e', source], stdin=slave, stdout=slave, stderr=slave)
    output = b''
    deadline = time.time() + 10
    while b'Key: ' not in output and time.time() < deadline:
        if select.select([master], [], [], .1)[0]: output += os.read(master, 4096)
    assert b'Key: ' in output, output
    os.write(master, b'\x03' if cancel else b'fake-private-key\r')
    while child.poll() is None and time.time() < deadline:
        if select.select([master], [], [], .1)[0]: output += os.read(master, 4096)
    if child.poll() is None:
        child.kill()
        raise AssertionError('prompt did not terminate')
    while select.select([master], [], [], .1)[0]: output += os.read(master, 4096)
    assert b'fake-private-key' not in output, output
    assert (b'cancelled' if cancel else b'received=16') in output, output
    assert termios.tcgetattr(slave)[3] & termios.ECHO, 'terminal echo was not restored'
    os.close(master)
    os.close(slave)
`;
  const result = spawnSync('python3', ['-c', script, moduleUrl, process.execPath], { encoding: 'utf8', timeout: 25_000 });
  assert.equal(result.status, 0, result.stderr || result.error?.message);
});
