import { SkillError, rememberSecret, requireValue } from './errors.mjs';

export const REGIONS = Object.freeze({
  global: 'https://api.clockify.me/api/v1',
  eu: 'https://euc1.clockify.me/api/v1',
  us: 'https://use2.clockify.me/api/v1',
  uk: 'https://euw2.clockify.me/api/v1',
  au: 'https://apse2.clockify.me/api/v1',
});

export const segment = (value) => encodeURIComponent(value);

export class ClockifyApi {
  constructor(apiKey, region = 'global', { fetchImpl = globalThis.fetch, timeoutMs = 20_000 } = {}) {
    requireValue(Object.hasOwn(REGIONS, region), 'INVALID_REGION', 'Choose global, eu, us, uk, or au.');
    rememberSecret(apiKey);
    this.apiKey = apiKey;
    this.base = REGIONS[region];
    this.fetch = fetchImpl;
    this.timeoutMs = timeoutMs;
  }

  async request(method, endpoint, { query = {}, body } = {}) {
    const write = method === 'POST' || method === 'PUT';
    const url = new URL(this.base + endpoint);
    for (const [key, value] of Object.entries(query)) if (value !== undefined) url.searchParams.set(key, String(value));
    let response;
    let raw;
    try {
      response = await this.fetch(url, {
        method, redirect: 'error', signal: AbortSignal.timeout(this.timeoutMs),
        headers: { 'X-Api-Key': this.apiKey, Accept: 'application/json', ...(body ? { 'Content-Type': 'application/json' } : {}) },
        ...(body ? { body: JSON.stringify(body) } : {}),
      });
      raw = await response.text();
    } catch {
      throw new SkillError(write ? 'WRITE_UNCERTAIN' : 'NETWORK_ERROR', write
        ? 'Clockify may have saved this entry. Do not retry the write; run the same request to reconcile it.'
        : 'Could not read Clockify. Check the connection and selected region, then try again.');
    }
    if (!response.ok) {
      const details = { httpStatus: response.status };
      if (response.headers.get('retry-after')) details.retryAfter = response.headers.get('retry-after');
      if (write && (response.status >= 500 || response.status === 408 || response.status < 400)) {
        throw new SkillError('WRITE_UNCERTAIN', 'Clockify returned an uncertain write result. Reconcile the same request before any retry.', details);
      }
      const code = ({ 401: 'AUTHENTICATION_FAILED', 403: 'ACCESS_DENIED', 429: 'RATE_LIMITED' })[response.status] || 'API_REJECTED';
      const messages = {
        AUTHENTICATION_FAILED: 'Clockify rejected the API key. Run setup --replace-key and check the region.',
        ACCESS_DENIED: 'Clockify denied access. Check workspace membership, permissions, and regional or subdomain-specific API key settings.',
        RATE_LIMITED: 'Clockify rate limit reached. Wait before making another request; no automatic retry was made.',
        API_REJECTED: 'Clockify rejected this request. Check required fields, project access, and locked dates.',
      };
      // Only the API's short validation message is useful; never dump bodies or headers.
      try { const value = JSON.parse(raw); if (typeof value.message === 'string') details.reason = value.message.slice(0, 1000); } catch {}
      throw new SkillError(code, messages[code], details);
    }
    if (write && response.status !== (method === 'POST' ? 201 : 200)) throw new SkillError('WRITE_UNCERTAIN', 'Clockify did not return the expected write response. Reconcile before retrying.');
    try {
      return { data: JSON.parse(raw), headers: response.headers };
    } catch {
      throw new SkillError(write ? 'WRITE_UNCERTAIN' : 'INVALID_API_RESPONSE', 'Clockify returned an unreadable response.');
    }
  }

  async get(endpoint, query) { return (await this.request('GET', endpoint, { query })).data; }
  async post(endpoint, body) { return (await this.request('POST', endpoint, { body })).data; }
  async put(endpoint, body) { return (await this.request('PUT', endpoint, { body })).data; }

  async list(endpoint, query = {}) {
    const items = [];
    for (let page = 1; page <= 100; page++) {
      const { data, headers } = await this.request('GET', endpoint, { query: { ...query, page, 'page-size': 200 } });
      requireValue(Array.isArray(data), 'INVALID_API_RESPONSE', 'Clockify returned an invalid list.');
      items.push(...data);
      const last = headers.get('last-page');
      if (last === 'true' || (last !== 'false' && data.length < 200)) return items;
    }
    throw new SkillError('INCOMPLETE_LIST', 'Clockify returned more than 100 pages. Narrow the date range before continuing.');
  }
}
