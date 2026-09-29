#!/usr/bin/env node
import { promises as fs } from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { configDirectory, loadConfig, authentication } from './config.mjs';
import { ClockifyApi } from './api.mjs';
import { ClockifyService } from './service.mjs';
import { setup } from './setup.mjs';
import { timezoneCommand } from './timezone.mjs';
import { SkillError, errorResult, jsonOutput, rememberSecret, requireValue } from './errors.mjs';

const HELP = `Clockify time-entry skill (Node.js 22+)

  clockify-skill setup [--agent both|claude|codex] [--workspace <id-or-name>]
                      [--timezone auto|<IANA-zone>] [--region global|eu|us|uk|au]
                      [--replace-key]
  clockify-skill status
  clockify-skill timezone [--sync]
  clockify-skill projects [--details] [--project <id>]
  clockify-skill entries [--date YYYY-MM-DD|today|yesterday]
  clockify-skill create --input <json-file> [--preview]
  clockify-skill update --input <json-file> [--preview]

Setup asks for your key privately in a terminal. Never put the key in chat or
command arguments. CLOCKIFY_API_KEY overrides a saved key. See README.md for
installation and the skill's references/commands.md for entry JSON examples.
Time commands follow the Clockify profile timezone automatically. Use setup
--timezone <IANA-zone> to pin a zone, or --timezone auto to follow Clockify again.
`;

function parse(args) {
  const [command, ...rest] = args;
  if (!command || command === '--help' || command === '-h' || command === 'help') return { command: 'help', options: {} };
  const allowed = {
    setup: ['agent', 'workspace', 'timezone', 'region', 'replace-key'],
    status: [], timezone: ['sync'], projects: ['details', 'project'], entries: ['date'], create: ['input', 'preview'], update: ['input', 'preview'],
  };
  requireValue(Object.hasOwn(allowed, command), 'INVALID_COMMAND', 'Use setup, status, timezone, projects, entries, create, or update. Run --help for examples.');
  const flags = new Set(['replace-key', 'details', 'preview', 'sync']);
  const options = {};
  for (let i = 0; i < rest.length; i++) {
    const arg = rest[i];
    const name = arg.startsWith('--') ? arg.slice(2) : '';
    requireValue(allowed[command].includes(name) && !Object.hasOwn(options, name), 'INVALID_OPTION', 'Unknown or repeated option. Run --help; API keys must never be command arguments.');
    if (flags.has(name)) options[name] = true;
    else {
      requireValue(rest[i + 1] && !rest[i + 1].startsWith('--'), 'INVALID_OPTION', 'An option is missing its value. Run --help.');
      options[name] = rest[++i];
    }
  }
  return { command, options };
}

export async function run(args, dependencies = {}) {
  const env = dependencies.env || process.env;
  rememberSecret(env.CLOCKIFY_API_KEY);
  const { command, options } = parse(args);
  if (command === 'help') return { help: HELP };
  requireValue(Number(process.versions.node.split('.')[0]) >= 22, 'NODE_VERSION', 'Install Node.js 22 or newer.');
  const directory = dependencies.directory || configDirectory(env, dependencies.home);
  if (command === 'setup') return setup(options, { ...dependencies, directory, env });
  if (command === 'timezone') return timezoneCommand(options, { ...dependencies, directory, env });
  const config = await loadConfig(directory, env);
  if (command === 'status') {
    const credentialAvailable = Boolean(env.CLOCKIFY_API_KEY || config?.apiKey);
    let locked = false;
    try { await fs.lstat(path.join(directory, 'write.lock')); locked = true; } catch (error) { if (error.code !== 'ENOENT') throw error; }
    return { ok: true, configured: Boolean(config?.version === 1 && config.user?.id && config.workspace?.id && credentialAvailable),
      credentialSource: env.CLOCKIFY_API_KEY ? 'environment' : config?.apiKey ? 'saved locally' : 'missing',
      workspace: config?.workspace, user: config?.user, region: config?.region, timezone: config?.timezone,
      timezoneMode: config ? (config.timezoneMode || 'clockify') : undefined,
      currentTime: (dependencies.now?.() || new Date()).toISOString(), configurationDirectory: directory, locked,
      note: 'Local configuration only. In clockify mode, time commands refresh the timezone from the profile before interpreting dates.' };
  }
  const key = authentication(config, env);
  const api = dependencies.apiFactory ? dependencies.apiFactory(key, config?.region) : new ClockifyApi(key, config?.region);
  const service = new ClockifyService(api, config, directory, dependencies);
  if (command === 'projects') return service.projects({ details: options.details, projectId: options.project });
  if (command === 'entries') return service.entries(options.date);
  requireValue(options.input, 'INPUT_REQUIRED', `Use ${command} --input <json-file>. Add --preview for a read-only preview.`);
  let input;
  try {
    const stat = await fs.stat(options.input);
    requireValue(stat.size <= 1_000_000, 'INVALID_INPUT', 'The input JSON must be smaller than 1 MB.');
    input = JSON.parse(await fs.readFile(options.input, 'utf8'));
  } catch (error) {
    if (error instanceof SyntaxError) throw new SkillError('INVALID_INPUT', 'The input file is not valid JSON.');
    if (error.code === 'ENOENT') throw new SkillError('INPUT_NOT_FOUND', 'The input file does not exist.');
    throw error;
  }
  return service[command](input, { preview: options.preview });
}

export async function main(args = process.argv.slice(2)) {
  try {
    const result = await run(args);
    process.stdout.write(result.help || `${jsonOutput(result)}\n`);
    if (result.ok === false) process.exitCode = 1;
  } catch (error) {
    process.stdout.write(`${jsonOutput({ ok: false, error: errorResult(error) })}\n`);
    process.exitCode = 1;
  }
}

// Node resolves module URLs through symlinks (including macOS /var ->
// /private/var). Resolve argv the same way for copied or symlinked helpers.
const entrypoint = process.argv[1] ? await fs.realpath(process.argv[1]).catch(() => null) : null;
if (entrypoint && import.meta.url === pathToFileURL(entrypoint).href) await main();
