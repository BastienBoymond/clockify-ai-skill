# Helper commands

Invoke `node "<absolute-skill-directory>/scripts/cli.mjs" <command>`. Resolve the
directory from the loaded SKILL.md, not the current repository. Commands other
than `setup` and `--help` use JSON output. Failures have `ok: false` and a nonzero
exit code. Setup also returns JSON, with private prompts on the terminal.

- `setup [--agent both|claude|codex] [--workspace <id-or-name>] [--timezone auto|<IANA-zone>] [--region global|eu|us|uk|au] [--replace-key]`
- `status`: local configuration, timezone, UTC current time, and lock state;
  does not contact Clockify or expose the key. `timezoneMode` is `clockify` or
  `fixed`; the reported timezone is the last cached value.
- `timezone`: compare the saved timezone with the authenticated Clockify profile
  using one `GET /user` call. Returns `timezone`, `clockifyTimezone`, and
  `matchesClockify` and `automatic`; does not write any preferences.
- `timezone --sync`: copy the profile timezone into the shared local
  configuration and enable automatic mode. Returns `previousTimezone`,
  `timezone`, `changed`, `source: "clockify"`, and `automatic: true`. Uses the
  saved key or `CLOCKIFY_API_KEY`; no setup or reinstallation is needed.
- `projects`: accessible active projects, including IDs, client names, and
  billable defaults. Matching is by exact name, ignoring case, or explicit ID.
- `projects --details [--project <id>]`: additionally lists workspace
  requirements, tags, custom fields, and the selected project's active tasks.
- `entries [--date YYYY-MM-DD|today|yesterday]`: the authenticated user's entries
  for that local date; defaults to today. Running entries may appear in reads.
- `create --input <json-file> [--preview]`: create on a free interval, update the
  sole exact-interval match, or return overlap candidates requiring a choice.
- `update --input <json-file> [--preview]`: modify an explicitly selected entry
  by ID, supplying only the fields to change. Both commands support read-only
  preview without Clockify or local configuration/journal writes.

## Entry input

One object, or an array of up to 100 objects:

```json
{
  "description": "API integration",
  "date": "2026-09-25",
  "start": "09:00",
  "durationMinutes": 120,
  "project": "Project Alpha"
}
```

Required: a nonempty `description`, `start`, and exactly one of `end` or
`durationMinutes` (positive whole minutes). The helper rejects future end times.
Durations are always rounded **up to the next multiple of 15 minutes**: a
50-minute request is logged as 60, and 09:00–10:07 becomes 09:00–10:15.
`start` stays as supplied and `end` moves; previews and results show the rounded
interval. The future-end check uses the supplied end, so work that just
finished can be logged even if its rounded end is a few minutes ahead.
New descriptions must fit on one line, at most **12 words and 100 characters**;
aim for a natural 3–8 word activity label. This is enforced for both writes and
previews. Whitespace separates words; characters are Unicode code points.
`date` is required with clock-only times; accepts YYYY-MM-DD, today, or yesterday.
For other relative dates, resolve a calendar date using the user's timezone.
`timezone` optionally overrides the default IANA timezone for that entry.

Automatic mode (`timezoneMode: "clockify"`, also the default for old configs)
reads `settings.timeZone` from the authenticated profile before interpreting
dates on every `entries`, `create`, and `update` invocation, including previews.
It reuses one identity request for the whole operation and freezes that timezone
throughout a batch. Writes update the cached preference under the shared lock;
previews and reads use the current value without saving it. Missing/invalid
profile settings or failed authentication stop the operation before any entry
write and preserve the saved preference.

`setup --timezone <IANA-zone>` selects fixed mode; `setup --timezone auto` or
`timezone --sync` restores automatic mode. Per-entry timezone overrides still
take precedence. No Clockify settings or existing timestamps are changed by
timezone synchronization. Recover an earlier uncertain write with its original
timezone or absolute UTC timestamps, even after the profile timezone changes.

`start` and `end` accept `HH:mm[:ss]` with `date`, or full
`YYYY-MM-DDTHH:mm[:ss]` timestamps. Without an offset they use the selected
timezone. Explicit `Z` or `±HH:mm` offsets identify an instant and override that
timezone for parsing. Ambiguous or nonexistent local times are rejected; ask for
the intended time/offset. Duration means elapsed time, including on DST days.
For overnight work, include both calendar dates; no overnight rollover is
assumed. Timestamps support millisecond precision, including preserved API times.

Optional fields:

- `project` (existing exact name) or `projectId`, never both. On a new entry,
  omission leaves no project unless workspace policy requires one. On an
  exact-interval update, omission preserves the existing project.
- `billable`: boolean; defaults to the project's setting (otherwise false) for
  creation, and preserves the current value for updates unless supplied.
- `taskId`, `tagIds`: existing IDs; checked against the chosen workspace/project.
- `customFields`: Clockify values shaped as
  `[{"customFieldId":"existing-id","value":"user-supplied value"}]`.
  Clockify validates field types, allowed values, and additional required fields.
  On rejection, inspect `error.reason`, discover fields with `projects --details`,
  and ask for missing values. Never fabricate them.

## Updating existing work

`create` searches the authenticated user's entries for overlaps. One entry with
exactly the same start and end is updated in place, retaining its ID. A partial
overlap or more than one intersecting entry returns `OVERLAPPING_ENTRIES` with
IDs, descriptions, and times. Ask which entry to modify; do not guess. Entries
that just touch at an endpoint do not overlap. Overlapping inputs in a single
create batch are rejected before writing.

To correct a selected entry, `update --input patch.json` accepts one object or
an array, with `id` and only the fields the user wants to change:

```json
{
  "id": "existing-entry-id",
  "description": "MCP unification and assistant fixes"
}
```

`DESCRIPTION_TOO_LONG` and `DESCRIPTION_MULTILINE` reject the proposed text
without sending a write for that entry. Summarize the activities and resubmit;
do not cut the text at a character boundary or bypass the helper. A correction
omitting `description` preserves existing text, including older long descriptions.
Pending writes from older versions can still be reconciled unchanged; this
performs reads only and does not send the old long description again.

Omitted fields keep their existing values, including times, project, task,
tags, billability, and custom fields. `durationMinutes` adjusts the end using
the existing start unless a new start is supplied. Any update supplying
`start`, `end`, or `durationMinutes` is rounded up to the next quarter hour,
so a start-only change can also move the end; corrections without time fields
keep the existing interval exactly, even when it is not a quarter-hour multiple. Clock-only times require
`date`; use explicit calendar dates to move or extend an entry overnight.
`projectId: null` and `taskId: null` explicitly remove those associations;
`tagIds: []` clears tags. Custom fields are patched by ID: values not mentioned
are retained, including zero and false; supply `value: null` to explicitly clear
a value, subject to Clockify's validation. A project change may require selecting
or clearing its previous task. Archived associations can remain unchanged.

Only completed regular entries belonging to the authenticated user and saved
workspace are eligible. Locked entries cannot be modified. Time changes must
not overlap another entry. An explicitly selected ID can have its description
corrected even if an existing duplicate is present; this does not delete or
merge the duplicate. Preview returns `action`, `id`, `before`, and the proposed
`payload`, exposing precisely what would change.

Both agents must share the default configuration directory and journal. Never
include `userId`, credentials, or endpoint URLs in entry JSON. The helper logs
only for the key owner. It does not create projects or other reference data.

## Results and recovery

Successful writes return `ok: true` and `results[]`. Each result has `status`,
`id`, description, project, workspace, UTC start/end, timezone, and duration.

- `created`: Clockify confirmed this new entry and its receipt was saved.
- `already_exists`: a matching entry was found in Clockify; no creation occurred.
- `updated`: the existing ID was modified and its receipt was saved.
- `unchanged`: an explicit update already matches the current entry; no PUT.
- `already_recorded`: a previously created entry still matches; no new write.
- `reconciled`: a previous uncertain write was found in Clockify; no new POST.
- `reconciled_update`: the selected ID matches the earlier uncertain update;
  no PUT or POST was resent.

Changed descriptions, projects, tags, billability, or custom fields on an exact
interval update the same entry. Only fields present in the request change.
Prior creation receipts do not prove that an entry still exists: if it has been
moved or deleted externally, the helper asks for review rather than recreating it.

Partial failure returns `ok: false`, completed `results`, zero-based
`failedIndex`, `remaining`, and an `error`. Batch structure is validated before
writes; per-entry checks (including description limits) and provider errors can
still cause partial success. On a known rejection, correct the entry and rerun;
confirmed earlier entries are deduplicated.

`WRITE_UNCERTAIN` means a timeout, lost response, ambiguous provider result, or
receipt failure may have happened after a write. Run the exact request again to
perform reconciliation with provider reads only. An unresolved attempt prevents
new POSTs or PUTs in the same account/workspace, even if the description or timezone
changes. Already-matching entries can still be skipped during batch recovery. Update
recovery checks the same entry ID and all proposed writable values; creation
recovery requires one matching entry. Preserve the fingerprint and journal and
inspect Clockify if the outcome remains unresolved.
Do not delete attempt files, switch configuration directories, or send raw API
requests as a workaround. `RECONCILED_DIFFERENT_REQUEST` means an earlier request
was found while attempting changed work for that period; review that entry first.

`LOCKED` prevents concurrent setup/writes. Wait for the other process. After a
crash, inspect `write.lock/owner.json` in the reported configuration directory and
verify that its process has stopped before manually removing only `write.lock`.
Keep `attempts/` intact so the next call can reconcile any pending write.

`RATE_LIMITED` includes `retryAfter` when supplied by Clockify. Stop and wait;
there are no automatic retries. `ACCOUNT_CHANGED` requires setup again because
the environment key belongs to a different user. `AUTHENTICATION_FAILED` calls
for key replacement or a corrected region, not repeated entry creation.

Updates re-read the entry immediately before PUT to detect intervening edits.
Clockify's endpoint has no conditional-write token, so edits made outside this
helper between that last read and PUT cannot be made atomic. Local copies share
a lock. Full overlap detection reads all pages without date filters so an older
containing entry is not missed; large histories can consume
several requests. Pagination or rate-limit failures stop the operation.
