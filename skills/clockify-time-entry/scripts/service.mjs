import { promises as fs } from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { segment } from './api.mjs';
import { readJson, writeJson, withLock } from './config.mjs';
import { normalizeInterval, dayRange, validateTimezone } from './time.mjs';
import { timezoneMode, profileTimezone, cacheTimezone } from './timezone.mjs';
import { SkillError, requireValue, errorResult } from './errors.mjs';
import { FIELDS, canonical, identity, sameEntry, overlaps, sameInterval, candidate, requireShortDescription, requireResolvedWrites } from './entries.mjs';
import { updateEntries, updateOne, reconcileUpdate } from './update.mjs';

function requireFields(settings, entry, project) {
  requireValue(!settings.forceProjects || project, 'REQUIRED_FIELDS', 'This workspace requires a project. Ask the user which project to use.', { fields: ['project'] });
  requireValue(!settings.forceTasks || entry.taskId, 'REQUIRED_FIELDS', 'This workspace requires a task. Use projects --details --project <id> and ask which task to use.', { fields: ['taskId'] });
  requireValue(!settings.forceTags || entry.tagIds?.length, 'REQUIRED_FIELDS', 'This workspace requires tags. Use projects --details and ask which tags to use.', { fields: ['tagIds'] });
  requireValue(!entry.taskId || project, 'REQUIRED_FIELDS', 'A task requires its existing project.', { fields: ['project'] });
}

function validateBatch(prepared) {
  for (let i = 0; i < prepared.length; i++) for (let j = 0; j < i; j++) {
    requireValue(!overlaps(prepared[i].payload, prepared[j].payload), 'OVERLAPPING_REQUESTS', 'Several requested entries overlap each other. Clarify their times before logging them.', { indices: [j, i] });
  }
  return prepared;
}

function validateInputs(input) {
  const entries = Array.isArray(input) ? input : [input];
  requireValue(entries.length > 0 && entries.length <= 100, 'INVALID_INPUT', 'Supply one entry or an array of 1 to 100 entries.');
  for (const entry of entries) {
    requireValue(entry && typeof entry === 'object' && !Array.isArray(entry), 'INVALID_INPUT', 'Each entry must be a JSON object.');
    requireValue(Object.keys(entry).every((key) => FIELDS.has(key)), 'UNKNOWN_FIELD', 'Unknown entry field. See references/commands.md for the supported input.');
    requireValue(typeof entry.description === 'string' && entry.description.trim().length > 0, 'DESCRIPTION_REQUIRED', 'Supply a nonempty work description as a short activity label.');
    requireValue(entry.start, 'START_REQUIRED', 'Ask the user for a start time; never assume 09:00 or end at now.');
    requireValue(!(entry.project !== undefined && entry.projectId !== undefined), 'INVALID_PROJECT', 'Supply project or projectId, not both.');
    for (const field of ['project', 'projectId', 'taskId']) if (entry[field] !== undefined) requireValue(typeof entry[field] === 'string' && entry[field].trim(), 'INVALID_INPUT', `${field} must be a nonempty string.`);
    if (entry.billable !== undefined) requireValue(typeof entry.billable === 'boolean', 'INVALID_INPUT', 'billable must be true or false.');
    if (entry.tagIds !== undefined) requireValue(Array.isArray(entry.tagIds) && entry.tagIds.every((id) => typeof id === 'string' && id), 'INVALID_INPUT', 'tagIds must contain existing tag IDs.');
    if (entry.customFields !== undefined) requireValue(Array.isArray(entry.customFields) && entry.customFields.every((field) => field && typeof field.customFieldId === 'string' && Object.hasOwn(field, 'value')), 'INVALID_INPUT', 'customFields must contain customFieldId and a user-supplied value.');
  }
  return entries;
}

export class ClockifyService {
  constructor(api, config, directory, { now = () => new Date() } = {}) {
    this.api = api;
    this.config = config;
    this.directory = directory;
    this.now = now;
    requireValue(config?.version === 1 && config.user?.id && config.workspace?.id && config.timezone, 'SETUP_REQUIRED', 'Run clockify-skill setup before using this command.');
    this.base = `/workspaces/${segment(config.workspace.id)}`;
  }

  async verifyIdentity() {
    const user = this.timeContext?.user || await this.api.get('/user');
    requireValue(user?.id === this.config.user.id, 'ACCOUNT_CHANGED', 'This API key belongs to a different account. Run setup to select its workspace before continuing.');
    return user;
  }

  async withTimezoneContext(fn, { persist = false } = {}) {
    if (this.timeContext) return fn();
    const user = await this.verifyIdentity();
    const timezone = timezoneMode(this.config) === 'fixed' ? validateTimezone(this.config.timezone) : profileTimezone(user);
    if (persist) await cacheTimezone(this.directory, this.config, timezone);
    // Freeze one profile timezone for the entire operation, including a batch.
    // Previews and reads use the current value without writing local preferences.
    this.timeContext = { user, timezone };
    try { return await fn(); } finally { this.timeContext = null; }
  }

  async projects({ details = false, projectId } = {}) {
    await this.verifyIdentity();
    const projects = await this.api.list(`${this.base}/projects`, { archived: false });
    const result = { ok: true, projects: projects.map(({ id, name, clientName, billable }) => ({ id, name, clientName, billable })) };
    if (details) {
      const workspace = await this.api.get(this.base);
      result.requirements = workspace.workspaceSettings || {};
      result.tags = await this.api.list(`${this.base}/tags`, { archived: false });
      if (projectId) result.tasks = await this.api.list(`${this.base}/projects/${segment(projectId)}/tasks`, { 'is-active': true });
      try { result.customFields = await this.api.get(`${this.base}/custom-fields`, { 'entity-type': 'TIMEENTRY' }); }
      catch (error) {
        if (![403, 404].includes(error.details?.httpStatus)) throw error;
        result.customFieldsUnavailable = 'Clockify did not allow custom-field discovery; its entry validation still applies.';
      }
    }
    return result;
  }

  async entries(date = 'today') {
    return this.withTimezoneContext(async () => {
      const timezone = this.timeContext.timezone;
      const range = dayRange(date, timezone, this.now());
      const entries = await this.fetchEntries(range);
      return { ok: true, workspace: this.config.workspace, timezone, ...range, entries };
    });
  }

  fetchEntries(range) {
    return this.api.list(`${this.base}/user/${segment(this.config.user.id)}/time-entries`, { start: range.start, end: range.end });
  }

  getEntry(id) { return this.api.get(`${this.base}/time-entries/${segment(id)}`); }

  async overlappingEntries(interval) {
    // Provider date bounds can hide an entry containing the requested interval.
    // Read every page without date filters, then test intersections locally.
    return (await this.api.list(`${this.base}/user/${segment(this.config.user.id)}/time-entries`))
      .filter((entry) => overlaps(entry, interval));
  }

  update(input, options) { return updateEntries(this, input, options); }

  async prepare(input, { preserved, deferRequired = false, round = true } = {}) {
    const entries = validateInputs(input);
    const now = this.now();
    const timezone = this.timeContext?.timezone || this.config.timezone;
    const normalized = entries.map((entry) => ({ entry, interval: normalizeInterval(entry, timezone, now, { round }) }));
    await this.verifyIdentity();
    const workspace = await this.api.get(this.base);
    const settings = workspace.workspaceSettings || {};
    const sameProject = (entry) => preserved && entry.project === undefined && (entry.projectId || null) === (preserved.projectId || null);
    const projectList = normalized.some(({ entry }) => !sameProject(entry) && (entry.project !== undefined || entry.projectId !== undefined))
      ? await this.api.list(`${this.base}/projects`, { archived: false }) : [];
    const taskLists = new Map();
    let tags;
    const prepared = [];
    for (const { entry, interval } of normalized) {
      let project;
      if (sameProject(entry)) {
        project = preserved.projectId ? { id: preserved.projectId } : undefined;
      } else if (entry.project !== undefined || entry.projectId !== undefined) {
        const matches = projectList.filter((candidate) => !candidate.archived && (entry.projectId !== undefined
          ? candidate.id === entry.projectId : candidate.name?.toLocaleLowerCase() === entry.project.trim().toLocaleLowerCase()));
        requireValue(matches.length > 0, 'PROJECT_NOT_FOUND', 'No accessible active project matches. Use projects and ask the user which existing project to use.');
        requireValue(matches.length === 1, 'AMBIGUOUS_PROJECT', 'Multiple projects match. Ask the user to choose, then use projectId.', { candidates: matches.map(({ id, name, clientName }) => ({ id, name, clientName })) });
        [project] = matches;
      }
      if (!deferRequired) requireFields(settings, entry, project);
      if (entry.taskId && !(sameProject(entry) && entry.taskId === preserved?.taskId) && !(deferRequired && !project)) {
        requireValue(project, 'REQUIRED_FIELDS', 'A task requires its existing project.', { fields: ['project'] });
        if (!taskLists.has(project.id)) taskLists.set(project.id, await this.api.list(`${this.base}/projects/${segment(project.id)}/tasks`, { 'is-active': true }));
        requireValue(taskLists.get(project.id).some((task) => task.id === entry.taskId && task.status !== 'DONE'), 'TASK_NOT_FOUND', 'The task is not an active task on the selected project.');
      }
      if (entry.tagIds?.length && JSON.stringify([...entry.tagIds].sort()) !== JSON.stringify([...(preserved?.tagIds || [])].sort())) {
        tags ??= await this.api.list(`${this.base}/tags`, { archived: false });
        requireValue(entry.tagIds.every((id) => tags.some((tag) => tag.id === id && !tag.archived)), 'TAG_NOT_FOUND', 'One or more tags are unavailable in this workspace.');
      }
      prepared.push({
        payload: {
          description: entry.description, start: interval.start, end: interval.end, type: 'REGULAR',
          projectId: project?.id || null, billable: entry.billable ?? project?.billable ?? false,
          ...(entry.taskId ? { taskId: entry.taskId } : {}),
          ...(entry.tagIds ? { tagIds: [...new Set(entry.tagIds)].sort() } : {}),
          ...(entry.customFields ? { customFields: entry.customFields } : {}),
        },
        project: project ? { id: project.id, name: project.name } : null,
        timezone: interval.timezone, durationMinutes: interval.durationMinutes,
        input: entry,
        requirements: { forceProjects: settings.forceProjects, forceTasks: settings.forceTasks, forceTags: settings.forceTags },
      });
    }
    return prepared;
  }

  scope() { return { region: this.config.region, workspaceId: this.config.workspace.id, userId: this.config.user.id }; }

  fingerprint(payload) {
    return createHash('sha256').update(JSON.stringify(canonical({ ...this.scope(), entry: identity(payload) }))).digest('hex');
  }

  async attempts() {
    const directory = path.join(this.directory, 'attempts');
    let files;
    try { files = await fs.readdir(directory); } catch (error) { if (error.code === 'ENOENT') return []; throw error; }
    const result = [];
    for (const file of files.filter((file) => file.endsWith('.json'))) {
      const record = await readJson(path.join(directory, file));
      requireValue(record?.version === 1 && record.scope && record.payload && /^[a-f0-9]{64}$/.test(record.fingerprint) && file === `${record.fingerprint}.json` && ['pending', 'succeeded', 'rejected'].includes(record.state) && (!record.operation || record.operation === 'update'), 'CORRUPT_STATE', 'An attempt record is invalid. Restore it before logging time.');
      if (record.operation === 'update') requireValue(typeof record.entryId === 'string' && record.entryId && record.before && record.requestKey, 'CORRUPT_STATE', 'An update attempt record is incomplete. Restore it before logging time.');
      result.push(record);
    }
    return result;
  }

  result(entry, prepared, status) {
    return { status, id: entry.id, description: entry.description, project: prepared.project,
      workspace: this.config.workspace, start: entry.timeInterval.start, end: entry.timeInterval.end,
      timezone: prepared.timezone, durationMinutes: (Date.parse(entry.timeInterval.end) - Date.parse(entry.timeInterval.start)) / 60_000 };
  }

  async create(input, { preview = false } = {}) {
    validateInputs(input);
    if (preview) {
      return this.withTimezoneContext(async () => {
        const entries = [];
        for (const prepared of validateBatch(await this.prepare(input, { deferRequired: true }))) entries.push(await this.createOne(prepared, { preview: true }));
        return { ok: true, preview: true, workspace: this.config.workspace, entries };
      });
    }
    return withLock(this.directory, () => this.withTimezoneContext(async () => {
      const prepared = validateBatch(await this.prepare(input, { deferRequired: true }));
      const results = [];
      for (const entry of prepared) {
        try { results.push(await this.createOne(entry)); }
        catch (error) {
          return { ok: false, results, failedIndex: results.length, remaining: prepared.length - results.length - 1, error: errorResult(error) };
        }
      }
      return { ok: true, results };
    }, { persist: true }));
  }

  async createOne(prepared, { preview = false } = {}) {
    const { payload } = prepared;
    const fingerprint = this.fingerprint(payload);
    const file = path.join(this.directory, 'attempts', `${fingerprint}.json`);
    const records = (await this.attempts()).filter((record) => JSON.stringify(canonical(record.scope)) === JSON.stringify(canonical(this.scope())));
    let current = records.find((record) => record.fingerprint === fingerprint);

    // Pending attempts remain authoritative across agent processes and skill copies.
    // A changed description cannot bypass an uncertain write for the same period.
    for (const record of records.filter((record) => record.state === 'pending' && (overlaps(record.payload, payload) || (record.before && overlaps(record.before, payload))))) {
      if (record.operation === 'update') return reconcileUpdate(this, record, prepared.input, { preview });
      let candidates;
      try { candidates = (await this.fetchEntries(record.payload)).filter((item) => sameEntry(item, record.payload)); }
      catch { throw new SkillError('WRITE_UNCERTAIN', 'An earlier write remains unresolved because reconciliation failed. No new entry was sent.', { fingerprint: record.fingerprint }); }
      if (candidates.length !== 1) throw new SkillError('WRITE_UNCERTAIN', 'An earlier write is still uncertain. Check Clockify before doing anything else; absence from a read is not proof that creation failed.', { fingerprint: record.fingerprint, matchingEntries: candidates.map((item) => item.id) });
      record.state = 'succeeded';
      record.entry = candidates[0];
      if (!preview) await writeJson(path.join(this.directory, 'attempts', `${record.fingerprint}.json`), record);
      if (record.fingerprint === fingerprint) return this.result(record.entry, prepared, 'reconciled');
      throw new SkillError('RECONCILED_DIFFERENT_REQUEST', 'The previous uncertain entry was found. Review it before submitting a changed request for the same period.', { id: record.entry.id });
    }

    // Old pending requests may be reconciled unchanged, but new writes must
    // satisfy the concise-description contract even if an agent ignores it.
    requireShortDescription(payload.description);
    const intersecting = await this.overlappingEntries(payload);
    const exact = intersecting.filter((item) => sameInterval(item, payload));
    requireValue(intersecting.length === 0 || (intersecting.length === 1 && exact.length === 1), 'OVERLAPPING_ENTRIES', 'This interval overlaps existing work. Ask which entry to modify, then use update with its ID; no write was sent.', { candidates: intersecting.map(candidate) });
    if (exact.length === 1) {
      const result = await updateOne(this, { id: exact[0].id, ...prepared.input }, { preview, expectedInterval: payload });
      if (result.status === 'unchanged') result.status = current?.state === 'succeeded' ? 'already_recorded' : 'already_exists';
      return result;
    }
    // A receipt must not silently claim that an entry deleted or moved in the
    // Clockify UI still occupies this interval.
    requireValue(current?.state !== 'succeeded', 'ENTRY_CHANGED', 'The previously recorded entry is no longer on this interval. Review it before creating another entry.', { id: current?.entry?.id });
    // A changed profile timezone can move the same local request outside a
    // pending interval. Absence of overlap must never authorize a second write.
    requireResolvedWrites(records);
    requireFields(prepared.requirements, prepared.input, prepared.project);
    if (preview) return { ...prepared, action: 'create' };
    current = { version: 1, fingerprint, scope: this.scope(), payload, timezone: prepared.timezone, state: 'pending', attemptedAt: this.now().toISOString() };
    await writeJson(file, current);
    let entry;
    try {
      entry = await this.api.post(`${this.base}/time-entries`, payload);
      requireValue(sameEntry(entry, payload) && (!entry.userId || entry.userId === this.config.user.id) && (!entry.workspaceId || entry.workspaceId === this.config.workspace.id), 'WRITE_UNCERTAIN', 'Clockify\'s response did not confirm the requested entry. Reconcile before retrying.');
    } catch (error) {
      if (error instanceof SkillError && error.code !== 'WRITE_UNCERTAIN') {
        current.state = 'rejected';
        current.error = { code: error.code, httpStatus: error.details.httpStatus };
        await writeJson(file, current);
        throw error;
      }
      throw new SkillError('WRITE_UNCERTAIN', 'The write may have succeeded. Re-run this exact request only to reconcile; the helper will not resend an unresolved write.', { fingerprint });
    }
    current.state = 'succeeded';
    current.entry = entry;
    try { await writeJson(file, current); }
    catch { throw new SkillError('WRITE_UNCERTAIN', 'Clockify returned success but the local receipt could not be saved. Reconcile this request before retrying.', { id: entry.id, fingerprint }); }
    return this.result(entry, prepared, 'created');
  }
}
