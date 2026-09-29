import path from 'node:path';
import { ClockifyApi } from './api.mjs';
import { authentication, loadConfig, withLock, writeJson } from './config.mjs';
import { requireValue } from './errors.mjs';
import { validateTimezone } from './time.mjs';

export function timezoneMode(config) {
  const mode = config?.timezoneMode || 'clockify';
  requireValue(['clockify', 'fixed'].includes(mode), 'INVALID_TIMEZONE_MODE', 'Run setup --timezone auto or setup --timezone <IANA-zone>.');
  return mode;
}

export function profileTimezone(user) {
  requireValue(typeof user?.settings?.timeZone === 'string' && user.settings.timeZone.trim(),
    'CLOCKIFY_TIMEZONE_UNAVAILABLE', 'Clockify did not return a profile timezone. Check your Clockify preferences or use setup --timezone <IANA-zone>.');
  return validateTimezone(user.settings.timeZone);
}

// Caller holds the shared lock. Update the cache without overwriting preferences
// changed after this command loaded its configuration.
export async function cacheTimezone(directory, expected, timezone) {
  const saved = await loadConfig(directory, {});
  if (!saved) return;
  requireValue(saved.user?.id === expected.user.id && saved.workspace?.id === expected.workspace.id
    && saved.region === expected.region && timezoneMode(saved) === timezoneMode(expected)
    && (timezoneMode(saved) !== 'fixed' || saved.timezone === expected.timezone),
  'CONFIG_CHANGED', 'Configuration changed before this operation acquired the lock. Run the command again.');
  if (timezoneMode(saved) === 'clockify' && saved.timezone !== timezone) {
    await writeJson(path.join(directory, 'config.json'), { ...saved, timezone });
  }
}

export async function timezoneCommand({ sync = false } = {}, {
  directory, env = process.env,
  apiFactory = (key, region) => new ClockifyApi(key, region),
} = {}) {
  const perform = async () => {
    // Reload inside the lock so syncing cannot overwrite a concurrent setup.
    const config = await loadConfig(directory, env);
    requireValue(config?.version === 1 && config.user?.id && config.workspace?.id && config.timezone,
      'SETUP_REQUIRED', 'Run clockify-skill setup before syncing the timezone.');
    const api = apiFactory(authentication(config, env), config.region);
    const user = await api.get('/user');
    requireValue(user?.id === config.user.id, 'ACCOUNT_CHANGED', 'This API key belongs to a different account. Run setup before syncing its timezone.');
    const clockifyTimezone = profileTimezone(user);
    const previousTimezone = config.timezone;
    const changed = previousTimezone !== clockifyTimezone;
    if (!sync) return { ok: true, timezone: previousTimezone, clockifyTimezone, matchesClockify: !changed, automatic: timezoneMode(config) === 'clockify' };
    if (changed || timezoneMode(config) !== 'clockify') {
      await writeJson(path.join(directory, 'config.json'), { ...config, timezone: clockifyTimezone, timezoneMode: 'clockify' });
    }
    return { ok: true, previousTimezone, timezone: clockifyTimezone, changed, source: 'clockify', automatic: true };
  };
  return sync ? withLock(directory, perform) : perform();
}
