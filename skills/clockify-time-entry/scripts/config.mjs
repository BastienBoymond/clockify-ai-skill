import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { SkillError, rememberSecret, requireValue } from './errors.mjs';

export function configDirectory(env = process.env, home = os.homedir()) {
  return path.resolve(env.CLOCKIFY_CONFIG_DIR || path.join(env.XDG_CONFIG_HOME || path.join(home, '.config'), 'clockify-ai-skill'));
}

export async function privateDirectory(directory) {
  await fs.mkdir(directory, { recursive: true, mode: 0o700 });
  const stat = await fs.lstat(directory);
  requireValue(stat.isDirectory() && !stat.isSymbolicLink(), 'UNSAFE_PATH', 'The configuration directory must be a real directory.');
  await fs.chmod(directory, 0o700);
}

export async function readJson(file, fallback = null) {
  try {
    const stat = await fs.lstat(file);
    requireValue(stat.isFile() && !stat.isSymbolicLink(), 'UNSAFE_PATH', 'Configuration and journal files must be regular files.');
    requireValue((stat.mode & 0o077) === 0, 'INSECURE_PERMISSIONS', 'A configuration or journal file is readable by other users. Set its permissions to 600 before continuing.');
    return JSON.parse(await fs.readFile(file, 'utf8'));
  } catch (error) {
    if (error.code === 'ENOENT') return fallback;
    if (error instanceof SyntaxError) throw new SkillError('CORRUPT_STATE', 'A configuration or journal file is invalid JSON. Restore it before continuing; do not discard uncertain write records.');
    throw error;
  }
}

export async function writeJson(file, data) {
  await privateDirectory(path.dirname(file));
  const temporary = `${file}.${randomUUID()}.tmp`;
  let handle;
  try {
    handle = await fs.open(temporary, 'wx', 0o600);
    await handle.writeFile(`${JSON.stringify(data, null, 2)}\n`);
    await handle.sync();
    await handle.close();
    handle = null;
    await fs.rename(temporary, file);
    // Commit the directory entry as well as file contents before a provider
    // mutation can proceed. Supported platforms are POSIX (including WSL).
    const parent = await fs.open(path.dirname(file), 'r');
    try { await parent.sync(); } finally { await parent.close(); }
  } finally {
    await handle?.close();
    await fs.rm(temporary, { force: true });
  }
}

export async function loadConfig(directory, env = process.env) {
  const config = await readJson(path.join(directory, 'config.json'));
  if (config?.apiKey) rememberSecret(config.apiKey);
  if (env.CLOCKIFY_API_KEY) rememberSecret(env.CLOCKIFY_API_KEY);
  return config;
}

export function authentication(config, env = process.env) {
  const apiKey = env.CLOCKIFY_API_KEY || config?.apiKey;
  requireValue(typeof apiKey === 'string' && apiKey.trim() && !/[\r\n]/.test(apiKey), 'SETUP_REQUIRED', 'Run clockify-skill setup in an interactive terminal, or supply CLOCKIFY_API_KEY through your environment.');
  rememberSecret(apiKey);
  return apiKey;
}

export async function withLock(directory, fn) {
  await privateDirectory(directory);
  const lock = path.join(directory, 'write.lock');
  try {
    await fs.mkdir(lock, { mode: 0o700 });
  } catch (error) {
    if (error.code === 'EEXIST') throw new SkillError('LOCKED', 'Another setup, timezone sync, or entry write holds the lock. If it crashed, verify that it has stopped before removing write.lock; preserve the attempts directory.', { lock });
    throw error;
  }
  try {
    await writeJson(path.join(lock, 'owner.json'), { pid: process.pid, hostname: os.hostname(), startedAt: new Date().toISOString() });
    return await fn();
  } finally {
    await fs.rm(lock, { recursive: true, force: true });
  }
}
