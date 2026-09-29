import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { randomUUID } from 'node:crypto';
import { createInterface } from 'node:readline/promises';
import { ClockifyApi, REGIONS } from './api.mjs';
import { authentication, loadConfig, writeJson, withLock, readJson } from './config.mjs';
import { validateTimezone } from './time.mjs';
import { timezoneMode, profileTimezone } from './timezone.mjs';
import { SkillError, requireValue, rememberSecret } from './errors.mjs';

const sourceSkill = fileURLToPath(new URL('../', import.meta.url));
const SKILL_NAME = 'clockify-time-entry';

export async function terminalPrompt(message, { secret = false, input = process.stdin, output = process.stderr } = {}) {
  requireValue(input.isTTY && output.isTTY, 'INTERACTIVE_SETUP_REQUIRED', 'Run setup in your own interactive terminal to enter the key privately. Do not paste it into chat. For unattended setup, provide CLOCKIFY_API_KEY and --workspace when needed.');
  if (!secret) {
    const reader = createInterface({ input, output });
    try { return (await reader.question(message)).trim(); } finally { reader.close(); }
  }
  const wasRaw = input.isRaw;
  input.setRawMode(true);
  // Disable echo before displaying the prompt, including for immediate pastes.
  output.write(message);
  input.resume();
  return new Promise((resolve, reject) => {
    let value = '';
    const finish = (error) => {
      input.removeListener('data', onData);
      input.removeListener('end', onEnd);
      input.removeListener('error', onEnd);
      input.setRawMode(Boolean(wasRaw));
      input.pause();
      output.write('\n');
      if (error) reject(error); else resolve(value.trim());
    };
    const onEnd = () => finish(new SkillError('SETUP_CANCELLED', 'Setup was cancelled before credentials were saved.'));
    const onData = (chunk) => {
      for (const char of chunk.toString('utf8')) {
        if (char === '\u0003' || char === '\u0004') return onEnd();
        if (char === '\r' || char === '\n') return finish();
        if (char === '\u007f' || char === '\b') value = value.slice(0, -1);
        else if (char >= ' ') value += char;
      }
    };
    input.on('data', onData);
    input.once('end', onEnd);
    input.once('error', onEnd);
  });
}

async function installationTargets(agent, home) {
  requireValue(['both', 'claude', 'codex'].includes(agent), 'INVALID_AGENT', '--agent must be both, claude, or codex.');
  const locations = { claude: path.join(home, '.claude', 'skills', SKILL_NAME), codex: path.join(home, '.agents', 'skills', SKILL_NAME) };
  const targets = (agent === 'both' ? ['claude', 'codex'] : [agent]).map((name) => ({ agent: name, path: locations[name] }));
  for (const target of targets) {
    try {
      const stat = await fs.lstat(target.path);
      requireValue(stat.isDirectory() && !stat.isSymbolicLink(), 'INSTALL_CONFLICT', 'An unmanaged path already occupies the skill installation location.', { path: target.path });
      const marker = await readJson(path.join(target.path, '.clockify-install.json'));
      requireValue(marker?.package === 'clockify-ai-skill', 'INSTALL_CONFLICT', 'An existing skill at this location was not installed by this setup. Move it aside explicitly before installing.', { path: target.path });
    } catch (error) { if (error.code !== 'ENOENT') throw error; }
  }
  return targets;
}

async function install(targets, source = sourceSkill) {
  for (const target of targets) {
    const staging = `${target.path}.install-${randomUUID()}`;
    const backup = `${target.path}.backup-${randomUUID()}`;
    let hadPrevious = false;
    try {
      await fs.mkdir(path.dirname(target.path), { recursive: true });
      await fs.cp(source, staging, { recursive: true, dereference: false });
      await writeJson(path.join(staging, '.clockify-install.json'), { package: 'clockify-ai-skill', version: 1 });
      try { await fs.rename(target.path, backup); hadPrevious = true; }
      catch (error) { if (error.code !== 'ENOENT') throw error; }
      try { await fs.rename(staging, target.path); }
      catch (error) { if (hadPrevious) await fs.rename(backup, target.path); throw error; }
      await fs.rm(backup, { recursive: true, force: true });
    } finally { await fs.rm(staging, { recursive: true, force: true }); }
  }
  return targets;
}

export async function setup(options, {
  directory, env = process.env, home = os.homedir(), prompt = terminalPrompt,
  apiFactory = (key, region) => new ClockifyApi(key, region),
  source = sourceSkill,
} = {}) {
  const targets = await installationTargets(options.agent || 'both', home);
  return withLock(directory, async () => {
    const existing = await loadConfig(directory, env);
    const region = options.region || existing?.region || 'global';
    requireValue(Object.hasOwn(REGIONS, region), 'INVALID_REGION', '--region must be global, eu, us, uk, or au.');
    const mode = options.timezone === 'auto' ? 'clockify' : options.timezone ? 'fixed' : timezoneMode(existing);
    const fixedTimezone = mode === 'fixed' ? validateTimezone(options.timezone || existing?.timezone) : undefined;
    let apiKey;
    let fromEnvironment = false;
    if (options['replace-key']) {
      requireValue(!env.CLOCKIFY_API_KEY, 'ENV_KEY_OVERRIDE', 'Unset CLOCKIFY_API_KEY before using --replace-key; environment credentials take precedence.');
    } else if (env.CLOCKIFY_API_KEY) {
      apiKey = env.CLOCKIFY_API_KEY;
      fromEnvironment = true;
    } else if (existing?.apiKey) apiKey = existing.apiKey;
    if (!apiKey) apiKey = await prompt('Generate a Clockify API key at https://app.clockify.me/user/settings (Preferences → Advanced → Manage API keys).\nClockify API key (hidden): ', { secret: true });
    rememberSecret(apiKey);
    authentication({ apiKey }, {});
    const api = apiFactory(apiKey, region);
    const user = await api.get('/user');
    requireValue(typeof user?.id === 'string' && user.id, 'INVALID_API_RESPONSE', 'Clockify did not return a valid authenticated user.');
    const timezone = mode === 'clockify' ? profileTimezone(user) : fixedTimezone;
    const workspaces = await api.get('/workspaces');
    requireValue(Array.isArray(workspaces) && workspaces.length > 0 && workspaces.every((workspace) => typeof workspace.id === 'string' && workspace.id && typeof workspace.name === 'string'), 'NO_WORKSPACES', 'No usable Clockify workspace was found for this key and region.');
    let workspace;
    if (options.workspace) {
      const matches = workspaces.filter((item) => item.id === options.workspace || item.name.toLowerCase() === options.workspace.toLowerCase());
      requireValue(matches.length === 1, 'INVALID_WORKSPACE', '--workspace must identify exactly one workspace. Use its ID if names are duplicated.', { workspaces: workspaces.map(({ id, name }) => ({ id, name })) });
      [workspace] = matches;
    } else if (existing?.user?.id === user.id && existing.region === region) workspace = workspaces.find((item) => item.id === existing.workspace?.id);
    if (!workspace && workspaces.length === 1) [workspace] = workspaces;
    if (!workspace) {
      const choices = workspaces.map((item, index) => `${index + 1}. ${item.name} (${item.id})`).join('\n');
      const answer = await prompt(`Choose your default Clockify workspace:\n${choices}\nWorkspace number: `);
      const index = Number(answer) - 1;
      requireValue(Number.isInteger(index) && index >= 0 && index < workspaces.length, 'INVALID_WORKSPACE', 'Choose one of the listed workspace numbers, or rerun setup with --workspace <id>.');
      workspace = workspaces[index];
    }
    const config = { version: 1, region, timezone, timezoneMode: mode, user: { id: user.id, name: user.name }, workspace: { id: workspace.id, name: workspace.name }, ...(!fromEnvironment ? { apiKey } : {}) };
    await writeJson(path.join(directory, 'config.json'), config);
    const installed = await install(targets, source);
    return { ok: true, user: config.user, workspace: config.workspace, timezone, timezoneMode: mode, region,
      credentialSource: fromEnvironment ? 'environment (not saved)' : 'saved locally', installed,
      next: 'Start a new Claude Code or Codex session, then ask it to log completed work with a start time.' };
  });
}
