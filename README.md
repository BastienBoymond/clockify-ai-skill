# Clockify time-entry skill

Log completed work in Clockify from Claude Code or Codex. Set up a Clockify API
key once, then ask either agent:

> Log two hours on September 25, 2026 starting at 09:00 on Project Alpha,
> description: API integration.

The skill asks for a start time when logging new work if you only provide a
duration. It creates entries on free intervals and updates the existing entry
when exactly one has the same start and end. Partial overlaps or multiple matches
require choosing the entry to correct. Proposed descriptions are short activity
labels, usually 3–8 words. The helper rejects new descriptions exceeding 12 words
or 100 characters, and multiline descriptions, so the agent must summarize them
before writing. It uses your existing Clockify account and projects.
No MCP server, model API key, or runtime npm dependencies are needed.

## Quick start

Requires **Node.js 22+** on macOS, Linux, or WSL and network access to Clockify.

From a checkout:

```sh
node bin/clockify-skill.mjs setup
```

Once this version is available on the repository's default branch, install from
GitHub in a terminal (requires Git):

```sh
npx --yes --package=github:BastienBoymond/clockify-ai-skill clockify-skill setup
```

Setup prompts privately for your Clockify API key. Generate one in Clockify's
**Profile settings → Preferences → Advanced → Manage API keys**. It validates the
key, asks you to select a workspace if necessary, reads your Clockify timezone,
and installs the skill for both agents. It creates no time entries.

Start a new agent session after installation. Invoke it naturally or explicitly:

- Claude Code: `/clockify-time-entry`
- Codex: `$clockify-time-entry`

Try “Preview 90 minutes yesterday starting at 14:00, description: design review.”
Then request logging when you want an entry created. A logging request needs no
second confirmation from the skill; the agent host's permissions still apply.

## Setup options

```sh
node bin/clockify-skill.mjs setup --agent claude
node bin/clockify-skill.mjs setup --agent codex --timezone Europe/Paris
node bin/clockify-skill.mjs setup --timezone auto
node bin/clockify-skill.mjs setup --workspace existing-workspace-id --region eu
node bin/clockify-skill.mjs setup --replace-key
```

`--agent` defaults to `both`. Regional choices are `global` (default), `eu`, `us`,
`uk`, and `au`. Select your actual Clockify data region explicitly; the helper
does not probe several hosts with your key. Subdomain workspaces may require a
key generated for that workspace.

Both agents share preferences and attempt records under
`${XDG_CONFIG_HOME:-~/.config}/clockify-ai-skill/`. Files are owner-readable and
owner-writable (600), inside directories accessible only to the owner (700).
The API key is stored locally as plaintext protected by these permissions; it is
not encrypted. Never commit this directory, paste a key into chat, or pass one
as a command argument. `CLOCKIFY_CONFIG_DIR` overrides the directory for isolated
installations and tests; keep it outside repositories and use the same directory
for both agents.

An existing `CLOCKIFY_API_KEY` environment variable takes precedence over a saved
key and is never persisted by setup. Configure it through your shell's secret
management or agent environment; it must also be available to later commands.
Unset it before `setup --replace-key`. Setup reuses a saved workspace and timezone
mode. A new account or region requires a new workspace selection.

**Timezone changes in Clockify are picked up automatically** on the next entry
read, preview, creation, or update. The helper reads the profile before resolving
local times or dates such as “today,” using the authentication request it already
needs. Both agents use this behavior by default, including older installations.
An operation uses one timezone throughout its batch. Previews and reads stay
read-only; write commands also refresh the locally cached timezone.

To pin a timezone, use `setup --timezone Europe/Paris`. Return to automatic mode
with `setup --timezone auto`. A timezone supplied in an individual entry takes
precedence. Existing entries keep their UTC timestamps unless you change their
times explicitly. If the profile cannot be read, the helper stops before writing
instead of assuming the last cached timezone.

You can still refresh the cache immediately and enable automatic mode:

```sh
node bin/clockify-skill.mjs timezone --sync
```

Or ask either agent: “Sync my timezone from Clockify.” Run `timezone` without
`--sync` to compare the cached value with the current profile without changing
anything. `status` remains offline and displays the cached timezone and mode.

Skill copies are installed into `~/.claude/skills/clockify-time-entry` and
`~/.agents/skills/clockify-time-entry`. Each contains its own helper, so deleting
the checkout or npm cache does not break it. The same setup command updates
managed copies. An unrelated existing skill at either destination causes a
conflict instead of being overwritten. Other skills are not modified.

## Commands and input

The checkout executable is `node bin/clockify-skill.mjs`. Installed agents invoke
`node /absolute/path/to/clockify-time-entry/scripts/cli.mjs`.

```sh
node bin/clockify-skill.mjs status
node bin/clockify-skill.mjs timezone
node bin/clockify-skill.mjs timezone --sync
node bin/clockify-skill.mjs projects
node bin/clockify-skill.mjs entries --date yesterday
node bin/clockify-skill.mjs create --input entry.json --preview
node bin/clockify-skill.mjs create --input entry.json
node bin/clockify-skill.mjs update --input patch.json --preview
node bin/clockify-skill.mjs update --input patch.json
```

Example `entry.json`:

```json
{
  "description": "API integration",
  "date": "2026-09-25",
  "start": "09:00",
  "durationMinutes": 120,
  "project": "Project Alpha"
}
```

Use your actual date, time, and project. Input can also be an array of entries.
For end times, timezones, tasks, tags, custom fields, and result schemas, see the
[command reference](skills/clockify-time-entry/references/commands.md).

To correct an existing entry, supply its ID and only changed fields in
`patch.json`:

```json
{
  "id": "existing-entry-id",
  "description": "MCP unification and assistant fixes"
}
```

Existing times, project, task, tags, billability, and custom fields are preserved
unless explicitly changed. The entry keeps its ID; no replacement entry is
created. For example, a planned 08:30–13:00 block becomes the actual work summary
on that same block. If the earlier version already created two blocks, choose
the ID to correct; duplicates are not deleted automatically.

## Reliability and troubleshooting

- **Setup cannot prompt:** run the setup command yourself in an interactive
  terminal. Agents should provide the command, not request the key in chat.
  Unattended setup needs an environment key and `--workspace` if there are several.
- **Invalid key or denied access:** replace the key, check workspace access, and
  verify the region and any subdomain-specific key requirement.
- **Project ambiguity or required fields:** select an existing project ID, or run
  `projects --details --project <id>` to discover tasks, tags, and custom fields.
  Additional custom-field validation is performed by Clockify.
- **Description too long:** summarize it as a 3–8 word activity label, at most
  12 words and 100 characters on one line, then resubmit. The helper rejects
  verbose descriptions instead of truncating them. This applies to previews,
  creation, and supplied update descriptions. Time-only corrections preserve
  existing text; historical entries are not rewritten automatically.
- **Rate limit:** wait for the returned retry interval. Clockify's Free plan can
  limit a workspace to 30 API requests/hour. The helper paginates reads and never
  retries automatically. `status` is local and consumes no API requests.
- **Occupied interval:** an exact match updates the same ID using only supplied
  fields. An unchanged request makes no write. Other overlaps return candidates
  so you can choose. A prior receipt cannot silently recreate a moved/deleted entry.
- **Uncertain write:** the shared journal prevents new writes until it is resolved.
  Re-run the same resolved request with its original timezone or UTC timestamps,
  even if your profile timezone has changed. If unresolved, inspect
  Clockify; do not delete the journal or bypass it with another tool.
- **Partial batch:** confirmed entries are reported separately. Later entries
  stop at the first failure; success is never claimed for an incomplete batch.
- **Stale lock after a crash:** verify the process recorded in
  `write.lock/owner.json` has stopped before removing only the lock directory.
  Preserve `attempts/`. See the command reference for recovery details.

This version creates and updates completed regular entries for the key owner.
Timers, Git-based allocation, deletions, project creation, and other users'
entries are out of scope. The helper re-reads an entry before updating to detect
intervening changes; Clockify does not expose a conditional update token here.
Local locking cannot make edits outside this helper atomic. Checking all overlaps
may require several API pages for a large history; incomplete reads stop writes.

## Development

```sh
npm test
npm run check
npm pack --dry-run
```

Tests use mocked Clockify responses and temporary installation directories. They
do not read real credentials or create real time entries. Terminal prompt tests
use Python 3's standard-library PTY support when it is available. CI tests Node
22 and 24 on macOS and Linux. Actual credential setup and live logging are
separate from these automated checks.

Official references: [Clockify API](https://docs.clockify.me/),
[API key settings](https://clockify.me/help/administration/api-webhook-settings),
[Claude Code skills](https://code.claude.com/docs/en/skills),
[Codex skills](https://learn.chatgpt.com/docs/build-skills).
