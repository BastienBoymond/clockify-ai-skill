import test from 'node:test';
import assert from 'node:assert/strict';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { buildPackage, packageFiles } from '../scripts/package-agensi.mjs';
import { demoInput } from '../scripts/agensi-demo.mjs';
import { listing } from '../distribution/agensi/listing.mjs';
import { fixture, TEST_KEY } from './helpers.mjs';

const execute = promisify(execFile);
const repository = fileURLToPath(new URL('../', import.meta.url));

test('Agensi ZIP contains only the self-contained skill and its generated metadata', async (t) => {
  const { root } = await fixture(t);
  const outputDirectory = path.join(root, 'output with spaces');
  const result = await buildPackage({ outputDirectory });
  const { stdout } = await execute('unzip', ['-Z1', result.zip]);
  const names = stdout.trim().split('\n');
  assert.deepEqual(names.sort(), [...packageFiles].sort());
  assert.equal(names.filter((name) => path.basename(name) === 'SKILL.md').length, 1);
  assert.ok(!names.some((name) => /(^|\/)(\.git|\.env|\.context|config\.json|attempts|test|node_modules)(\/|$)/.test(name)));
  await execute('unzip', ['-tq', result.zip]);
  assert.ok(result.bytes < 50_000_000);
  const { stdout: skill } = await execute('unzip', ['-p', result.zip, 'SKILL.md']);
  assert.match(skill, /^---\nname: clockify-time-entry\n/);
  const frontmatter = skill.split('\n---\n')[0];
  const field = (key) => JSON.parse(frontmatter.split('\n').find((line) => line.startsWith(`${key}: `)).slice(key.length + 2));
  assert.equal(field('summary'), listing.summary);
  assert.equal(field('version'), result.version);
  assert.deepEqual(field('tags'), listing.tags);
  assert.deepEqual(field('use_cases'), listing.useCases);
  assert.equal(field('docs_url'), listing.docsUrl);
  for (const name of names.filter((name) => name !== 'SKILL.md')) {
    const { stdout: bundled } = await execute('unzip', ['-p', result.zip, name], { encoding: 'buffer' });
    assert.deepEqual(bundled, await fs.readFile(path.join(repository, 'skills/clockify-time-entry', name)));
  }
  const evidence = JSON.parse(await fs.readFile(result.evidence, 'utf8'));
  assert.equal(evidence.liveClockifyVerified, false);
  assert.deepEqual(evidence.checks, { clockifyWrites: 0, realNetworkRequests: 0, persistentStateCreated: false });
  assert.equal(evidence.totalMinutes, 150);
  assert.deepEqual(evidence.rows.map(({ start, end }) => [start, end]), [['09:00', '10:00'], ['10:30', '12:00']]);
  assert.ok(evidence.result.length >= 700);
  const fields = await fs.readFile(result.fields, 'utf8');
  assert.ok(fields.includes(evidence.request) && fields.includes(evidence.result));
  assert.ok(!fields.includes(TEST_KEY) && !JSON.stringify(evidence).includes(TEST_KEY));
  assert.equal(listing.pricing.model, 'Subscription');
  assert.equal(listing.pricing.monthlyUsd, 5);
  assert.ok(listing.name.length <= 60 && listing.summary.length <= 300 && listing.categories.length <= 3);

  // Rebuilding replaces only the three generated outputs, never the output directory.
  await fs.writeFile(path.join(outputDirectory, 'keep.txt'), 'Unrelated user file');
  await fs.writeFile(result.zip, 'Old or interrupted archive');
  await buildPackage({ outputDirectory });
  await execute('unzip', ['-tq', result.zip]);
  assert.equal(await fs.readFile(path.join(outputDirectory, 'keep.txt'), 'utf8'), 'Unrelated user file');
});

test('extracted Agensi runtime configures and previews from another directory without skill installation', async (t) => {
  const { root, home, directory, dependencies, provider } = await fixture(t);
  const result = await buildPackage({ outputDirectory: path.join(root, 'output') });
  const extracted = path.join(root, 'extracted');
  const elsewhere = path.join(root, 'unrelated-project');
  await fs.mkdir(elsewhere);
  await execute('unzip', ['-q', result.zip, '-d', extracted]);
  const cli = path.join(extracted, 'scripts/cli.mjs');
  const env = { ...process.env, CLOCKIFY_API_KEY: '', CLOCKIFY_CONFIG_DIR: directory };
  const { stdout: help } = await execute(process.execPath, [cli, '--help'], { cwd: elsewhere, env });
  assert.match(help, /setup.*--no-install/);
  const { stdout: before } = await execute(process.execPath, [cli, 'status'], { cwd: elsewhere, env });
  assert.equal(JSON.parse(before).configured, false);
  provider.user.settings.timeZone = 'Europe/Paris';
  const runtime = await import(pathToFileURL(cli).href);
  const isolated = { ...dependencies, now: () => new Date('2026-10-27T09:00:00Z'), prompt: async () => TEST_KEY };
  const configured = await runtime.run(['setup', '--no-install'], isolated);
  assert.deepEqual(configured.installed, []);
  assert.equal(configured.timezone, 'Europe/Paris');
  const input = path.join(elsewhere, 'input.json');
  await fs.writeFile(input, JSON.stringify(demoInput));
  const preview = await runtime.run(['create', '--input', input, '--preview'], isolated);
  assert.equal(preview.ok, true);
  assert.deepEqual(preview.entries.map(({ durationMinutes }) => durationMinutes), [60, 90]);
  assert.equal(provider.posts.length + provider.puts.length, 0);
  await assert.rejects(fs.stat(path.join(home, '.claude')), { code: 'ENOENT' });
  await assert.rejects(fs.stat(path.join(home, '.agents')), { code: 'ENOENT' });
  await assert.rejects(fs.stat(path.join(directory, 'attempts')), { code: 'ENOENT' });

  // A new temporary runtime reuses the same persistent state after cleanup.
  await fs.rm(extracted, { recursive: true });
  const next = path.join(root, 'next-session');
  await execute('unzip', ['-q', result.zip, '-d', next]);
  const { stdout: after } = await execute(process.execPath, [path.join(next, 'scripts/cli.mjs'), 'status'], { cwd: elsewhere, env });
  assert.equal(JSON.parse(after).configured, true);
  assert.equal(JSON.parse(after).timezone, 'Europe/Paris');
});

test('package CLI accepts an output directory from another working directory', async (t) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'clockify-agensi-cli-test-'));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const output = path.join(root, 'custom output');
  const cli = path.join(repository, 'scripts/package-agensi.mjs');
  const { stdout } = await execute(process.execPath, [cli, '--output-dir', output], { cwd: root });
  assert.equal(JSON.parse(stdout).zip, path.join(output, 'clockify-time-entry.zip'));
  await execute('unzip', ['-tq', path.join(output, 'clockify-time-entry.zip')]);
  await assert.rejects(execute(process.execPath, [cli, '--output-dir'], { cwd: root }));
});
