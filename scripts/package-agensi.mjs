#!/usr/bin/env node
import assert from 'node:assert/strict';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { listing } from '../distribution/agensi/listing.mjs';
import { createDemo } from './agensi-demo.mjs';

const execute = promisify(execFile);
const repository = fileURLToPath(new URL('../', import.meta.url));
export const packageFiles = [
  'SKILL.md', 'references/commands.md', 'references/agensi.md',
  'scripts/api.mjs', 'scripts/cli.mjs', 'scripts/config.mjs', 'scripts/entries.mjs',
  'scripts/errors.mjs', 'scripts/service.mjs', 'scripts/setup.mjs',
  'scripts/time.mjs', 'scripts/timezone.mjs', 'scripts/update.mjs',
];

function agensiSkill(source, version) {
  const frontmatter = /^(---\r?\n[\s\S]*?)(\r?\n---)(\r?\n|$)/.exec(source);
  assert.ok(frontmatter, 'The source skill must have YAML frontmatter.');
  const fields = { summary: listing.summary, version, tags: listing.tags, keywords: listing.keywords,
    use_cases: listing.useCases, docs_url: listing.docsUrl };
  const extra = Object.entries(fields).map(([key, value]) => `${key}: ${JSON.stringify(value)}`).join('\n');
  return source.replace(frontmatter[0], `${frontmatter[1]}\n${extra}${frontmatter[2]}\n`);
}

function renderForm(demo) {
  const section = (title, body) => `## ${title}\n\n${body}\n`;
  const lines = (values) => values.join('\n');
  const bullets = (values) => values.map((value) => `- ${value}`).join('\n');
  return [
    '# Agensi submission — Clockify Time Entries\n',
    'Copy each section into its matching form field. The ZIP is the skill payload; this document and the demo evidence are submission aids.\n',
    section('Skill ZIP Upload', '`clockify-time-entry.zip` (or the commit-suffixed ZIP downloaded from GitHub Actions).'),
    section('Skill logo', 'Leave empty for this first submission.'),
    section('Skill Name', listing.name), section('Summary', listing.summary),
    section('Full Description', listing.description),
    section('The request (what the buyer types)', demo.request),
    section('The result (what your agent delivers)', demo.result),
    section('Compatibility Note', listing.compatibility),
    section('Pricing Model', `${listing.pricing.model}\n\nMonthly price: **$${listing.pricing.monthlyUsd} USD**. Do not enable yearly billing for this initial offer.`),
    section('Categories (in order)', bullets(listing.categories)),
    section('Tags', listing.tags.join(', ')), section('Use cases', bullets(listing.useCases)),
    section('Required tools & software (one per line)', lines(listing.requiredSoftware)),
    section('Tools Used', `${bullets(listing.toolsUsed.map((tool) => `[x] ${tool}`))}\n${bullets(listing.toolsNotUsed.map((tool) => `[ ] ${tool}`))}`),
    section('Needs access to', `${lines(listing.services)}\n\nSelect Clockify if available in the service list. Otherwise add the domain below as Other tool.`),
    section('Other tool', listing.otherTool),
    section('Network hosts (if the form exposes this field)', lines(listing.hosts)),
    section('File Scopes (add each pattern separately)', lines(listing.fileScopes)),
    section('Permissions — Notes', listing.permissionNotes),
    section('Known Limitations', listing.limitations),
    section('FAQ', listing.faq.map(({ question, answer }) => `### ${question}\n\n${answer}`).join('\n\n')),
    section('Screenshots', 'Leave empty for this first submission.'),
    section('Demo video URL', 'Leave empty for this first submission.'),
    section('Documentation URL', listing.docsUrl),
    section('Submission status', 'Prepared locally. Connect a payout method in Agensi before submitting a paid listing. Agensi review, approval, and a real Agensi agent session have not been verified by this package build.'),
  ].join('\n');
}

export async function buildPackage({ outputDirectory = path.join(repository, '.context', 'agensi') } = {}) {
  assert.ok(listing.name.length > 0 && listing.name.length <= 60, 'Agensi names must fit 60 characters.');
  assert.ok(listing.summary.length > 0 && listing.summary.length <= 300, 'Agensi summaries must fit 300 characters.');
  assert.ok(listing.categories.length <= 3, 'Agensi accepts at most three categories.');
  const { version } = JSON.parse(await fs.readFile(path.join(repository, 'package.json'), 'utf8'));
  const temporary = await fs.mkdtemp(path.join(os.tmpdir(), 'clockify-agensi-package-'));
  try {
    const staged = path.join(temporary, 'skill');
    for (const relative of packageFiles) {
      const source = path.join(repository, 'skills', 'clockify-time-entry', relative);
      const stat = await fs.lstat(source);
      assert.ok(stat.isFile() && !stat.isSymbolicLink(), `Package source must be a regular file: ${relative}`);
      if (relative.endsWith('.mjs')) assert.ok(stat.size < 20_000, `Agensi scripts must stay under 20 KB: ${relative}`);
      const destination = path.join(staged, relative);
      await fs.mkdir(path.dirname(destination), { recursive: true });
      const contents = await fs.readFile(source);
      await fs.writeFile(destination, relative === 'SKILL.md' ? agensiSkill(contents.toString('utf8'), version) : contents, { mode: 0o644 });
    }
    // Exercise the service that will actually ship, using only the fake provider.
    const { ClockifyService } = await import(pathToFileURL(path.join(staged, 'scripts/service.mjs')).href);
    const demo = await createDemo({ Service: ClockifyService });
    const archive = path.join(temporary, 'clockify-time-entry.zip');
    await execute('zip', ['-X', '-q', archive, ...packageFiles], { cwd: staged });
    await execute('unzip', ['-tq', archive]);
    const { size } = await fs.stat(archive);
    assert.ok(size < 50_000_000, 'Agensi ZIPs must stay under 50 MB.');
    const output = path.resolve(outputDirectory);
    await fs.mkdir(output, { recursive: true });
    const files = { zip: path.join(output, 'clockify-time-entry.zip'), fields: path.join(output, 'form-fields.md'), evidence: path.join(output, 'demo-evidence.json') };
    await fs.copyFile(archive, files.zip);
    await fs.writeFile(files.fields, renderForm(demo));
    await fs.writeFile(files.evidence, `${JSON.stringify(demo, null, 2)}\n`);
    return { ...files, version, bytes: size, fileCount: packageFiles.length };
  } finally {
    await fs.rm(temporary, { recursive: true, force: true });
  }
}

async function main(args) {
  if (args.length === 1 && ['--help', '-h'].includes(args[0])) {
    process.stdout.write('Usage: npm run package:agensi -- [--output-dir <directory>]\nRequires Node.js 22+, zip, and unzip. Builds from this repository checkout.\n');
    return;
  }
  assert.ok(args.length === 0 || (args.length === 2 && args[0] === '--output-dir' && args[1] && !args[1].startsWith('--')),
    'Use --output-dir <directory>, or no arguments for .context/agensi/.');
  const result = await buildPackage({ outputDirectory: args[1] });
  process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
}

const entrypoint = process.argv[1] ? await fs.realpath(process.argv[1]).catch(() => null) : null;
if (entrypoint && import.meta.url === pathToFileURL(entrypoint).href) {
  main(process.argv.slice(2)).catch((error) => {
    process.stderr.write(`Agensi package failed: ${error.message}\n`);
    process.exitCode = 1;
  });
}
