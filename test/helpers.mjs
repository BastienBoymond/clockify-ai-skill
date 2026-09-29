import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { ClockifyApi } from '../skills/clockify-time-entry/scripts/api.mjs';
import { ClockifyService } from '../skills/clockify-time-entry/scripts/service.mjs';

export const TEST_KEY = 'fake-clockify-key-for-tests-only';
export const NOW = new Date('2026-09-29T20:00:00Z');
export const entryInput = (overrides = {}) => ({ description: 'API integration', date: '2026-09-25', start: '09:00', durationMinutes: 120, project: 'Project Alpha', ...overrides });
export const jsonResponse = (data, status = 200, headers = {}) => new Response(JSON.stringify(data), { status, headers });

export class FakeClockify {
  user = { id: 'user-1', name: 'Test User', settings: { timeZone: 'America/Los_Angeles' } };
  workspaces = [{ id: 'workspace-1', name: 'Test Workspace', workspaceSettings: {} }];
  projects = [{ id: 'project-1', name: 'Project Alpha', clientName: 'Test Client', billable: true, archived: false }];
  tasks = [{ id: 'task-1', name: 'Implementation', status: 'ACTIVE' }];
  tags = [{ id: 'tag-1', name: 'Development', archived: false }];
  customFields = [];
  entries = [];
  calls = [];
  postHandlers = [];
  putHandlers = [];
  intercept = null;

  save(body) {
    const entry = { ...body, id: `entry-${this.entries.length + 1}`, userId: this.user.id, workspaceId: 'workspace-1', timeInterval: { start: body.start, end: body.end } };
    delete entry.start;
    delete entry.end;
    this.entries.push(entry);
    return entry;
  }

  update(id, body) {
    const index = this.entries.findIndex((entry) => entry.id === id);
    const original = this.entries[index];
    const entry = { id, userId: original.userId, workspaceId: original.workspaceId, isLocked: original.isLocked,
      description: body.description || '', projectId: body.projectId || null, taskId: body.taskId || null,
      tagIds: body.tagIds || [], billable: body.billable ?? false, type: body.type || 'REGULAR',
      customFieldValues: body.customFields || [], timeInterval: { start: body.start, end: body.end } };
    this.entries[index] = entry;
    return entry;
  }

  fetch = async (rawUrl, options) => {
    const url = new URL(rawUrl);
    const endpoint = url.pathname.replace('/api/v1', '');
    const body = options.body ? JSON.parse(options.body) : null;
    const call = { method: options.method, endpoint, url, body, options };
    this.calls.push(call);
    const override = await this.intercept?.(call);
    if (override) return override;
    if (endpoint === '/user') return jsonResponse(this.user);
    if (endpoint === '/workspaces') return jsonResponse(this.workspaces);
    if (endpoint === '/workspaces/workspace-1') return jsonResponse(this.workspaces[0]);
    if (endpoint === '/workspaces/workspace-1/projects') return jsonResponse(this.projects, 200, { 'Last-Page': 'true' });
    if (endpoint.endsWith('/tasks')) return jsonResponse(this.tasks, 200, { 'Last-Page': 'true' });
    if (endpoint.endsWith('/tags')) return jsonResponse(this.tags, 200, { 'Last-Page': 'true' });
    if (endpoint.endsWith('/custom-fields')) return jsonResponse(this.customFields);
    const specificEntry = /\/time-entries\/([^/]+)$/.exec(endpoint);
    if (specificEntry) {
      const id = decodeURIComponent(specificEntry[1]);
      const entry = this.entries.find((entry) => entry.id === id);
      if (!entry) return jsonResponse({ message: 'Entry not found' }, 404);
      if (options.method === 'GET') return jsonResponse(entry);
      if (options.method === 'PUT') {
        if (this.putHandlers.length) return this.putHandlers.shift()(body, id);
        return jsonResponse(this.update(id, body));
      }
    }
    if (endpoint.endsWith('/time-entries') && options.method === 'GET') {
      const start = url.searchParams.has('start') ? Date.parse(url.searchParams.get('start')) : -Infinity;
      const end = url.searchParams.has('end') ? Date.parse(url.searchParams.get('end')) : Infinity;
      return jsonResponse(this.entries.filter((entry) => Date.parse(entry.timeInterval.start) >= start && Date.parse(entry.timeInterval.start) <= end), 200, { 'Last-Page': 'true' });
    }
    if (endpoint === '/workspaces/workspace-1/time-entries' && options.method === 'POST') {
      if (this.postHandlers.length) return this.postHandlers.shift()(body);
      return jsonResponse(this.save(body), 201);
    }
    throw new Error(`Unexpected fake route: ${options.method} ${endpoint}`);
  };

  apiFactory = (key = TEST_KEY, region = 'global') => new ClockifyApi(key, region, { fetchImpl: this.fetch });
  get posts() { return this.calls.filter((call) => call.method === 'POST'); }
  get puts() { return this.calls.filter((call) => call.method === 'PUT'); }
}

export async function fixture(t) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'clockify-skill-test-'));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const home = path.join(root, 'home');
  const directory = path.join(root, 'configuration');
  const provider = new FakeClockify();
  const config = { version: 1, apiKey: TEST_KEY, region: 'global', timezone: 'America/Los_Angeles', user: provider.user, workspace: { id: 'workspace-1', name: 'Test Workspace' } };
  const dependencies = { directory, home, env: {}, apiFactory: provider.apiFactory, now: () => NOW };
  const service = new ClockifyService(provider.apiFactory(), config, directory, dependencies);
  return { root, home, directory, provider, config, dependencies, service };
}
