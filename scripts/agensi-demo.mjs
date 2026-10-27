import assert from 'node:assert/strict';
import { access } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { ClockifyService } from '../skills/clockify-time-entry/scripts/service.mjs';
import { FakeClockify } from '../test/helpers.mjs';

export const demoInput = [
  { date: '2026-10-26', start: '09:00', durationMinutes: 50, description: 'Fix API pagination', project: 'Project Alpha' },
  { date: '2026-10-26', start: '10:30', durationMinutes: 80, description: 'Review integration tests', project: 'Project Alpha' },
];

export const demoPrompt = `Preview my completed work for October 26, 2026 on Project Alpha: 50 minutes from 09:00 fixing API pagination, then 80 minutes from 10:30 reviewing integration tests. My Clockify profile timezone is Europe/Paris. Show a detailed table with the requested durations, rounded intervals, proposed actions, and total. Explain the checks performed. Do not save anything.`;

export async function createDemo({ Service = ClockifyService } = {}) {
  const provider = new FakeClockify();
  provider.user.settings.timeZone = 'Europe/Paris';
  const directory = path.join(os.tmpdir(), `clockify-agensi-demo-${randomUUID()}`);
  const config = { version: 1, region: 'global', timezone: 'Europe/Paris', timezoneMode: 'clockify',
    user: provider.user, workspace: { id: 'workspace-1', name: 'Test Workspace' } };
  const service = new Service(provider.apiFactory(), config, directory, { now: () => new Date('2026-10-27T09:00:00Z') });
  const preview = await service.create(structuredClone(demoInput), { preview: true });
  assert.equal(preview.ok, true);
  assert.equal(preview.preview, true);
  assert.deepEqual(preview.entries.map(({ durationMinutes }) => durationMinutes), [60, 90]);
  assert.deepEqual(preview.entries.map(({ action }) => action), ['create', 'create']);
  assert.equal(provider.posts.length + provider.puts.length, 0);
  assert.ok(provider.calls.every(({ method }) => method === 'GET'));
  await assert.rejects(access(directory), { code: 'ENOENT' });
  const clock = new Intl.DateTimeFormat('en-GB', { timeZone: 'Europe/Paris', hour: '2-digit', minute: '2-digit', hourCycle: 'h23' });
  const rows = preview.entries.map((entry) => ({
    description: entry.payload.description, requestedMinutes: entry.input.durationMinutes,
    start: clock.format(new Date(entry.payload.start)), end: clock.format(new Date(entry.payload.end)),
    durationMinutes: entry.durationMinutes, action: entry.action,
  }));
  assert.deepEqual(rows.map(({ start, end }) => [start, end]), [['09:00', '10:00'], ['10:30', '12:00']]);
  const totalMinutes = rows.reduce((sum, row) => sum + row.durationMinutes, 0);
  const table = rows.map((row) => `| ${row.description} | ${row.requestedMinutes} min | ${row.start}–${row.end} | ${row.durationMinutes} min | Would ${row.action} |`).join('\n');
  const result = `## Read-only preview

**Sample data with a simulated Clockify API. No real account was contacted.**

Prepared two proposed entries for **October 26, 2026**, on **Project Alpha**, using the **Europe/Paris** timezone returned by the sample profile. Nothing was saved.

| Description | Requested | Proposed interval | Rounded duration | Action |
| --- | --- | --- | --- | --- |
${table}

**Requested total:** 130 minutes (2 h 10). **Proposed total:** ${totalMinutes} minutes (2 h 30).

Both start times stay unchanged. Each requested duration rounds up to the next 15 minutes: 50 becomes 60 minutes, and 80 becomes 90 minutes.

### Checks performed

- Project Alpha exists and is active in the simulated workspace.
- The sample Clockify profile supplies the Europe/Paris timezone.
- Both descriptions fit the helper's length and single-line limits.
- The proposed intervals do not overlap each other, and the simulated account contains no conflicting entries.
- The helper made read requests only. It did not create or update a time entry, configuration file, lock, or attempt record.

### Next step

Review the rounded end times. In your own configured account, ask the agent to log these entries only if the proposed intervals match the work you want recorded. That request performs a fresh check against your actual Clockify entries.`;
  assert.ok(result.length >= 700);
  return {
    mode: 'simulated-clockify-api', liveClockifyVerified: false,
    request: demoPrompt, input: structuredClone(demoInput), preview, rows, totalMinutes, result,
    checks: { clockifyWrites: 0, realNetworkRequests: 0, persistentStateCreated: false },
  };
}
