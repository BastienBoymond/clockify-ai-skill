# Running through Agensi

Agensi delivers skill instructions and reference files into the agent's context.
It allows shipped scripts to run from temporary files, without installing the
skill. This mode still requires a local shell, Node.js 22+, filesystem access,
network access to Clockify, and a persistent configuration directory.

## Load the temporary helper

Use Agensi's `get_skill` with the current listing slug and `file` to fetch every
file under `scripts/` in the returned file index. Fetch all of them because the
CLI imports the other modules. Write each script exactly as received, preserving
its filename and the relative `scripts/` layout under one private temporary
directory named `clockify-agensi-*` in the operating system's temporary folder.
If a file is missing or truncated, stop instead of reconstructing it. Do not
save SKILL.md, references, or UI metadata to disk. Read references through
`get_skill` as needed.

Invoke `node "<temporary-directory>/scripts/cli.mjs" <command>` by absolute path.
Keep input JSON without credentials in this temporary directory as well.
Run `status` first; an existing Clockify configuration can be reused.

## First-time setup and preference changes

If configuration is missing, give the user this command with the actual
temporary directory substituted, to run in their own interactive terminal:

```sh
node "<temporary-directory>/scripts/cli.mjs" setup --no-install
```

Keep the temporary files available while the user runs setup. Do not request
their API key in chat, read credential files, or pass a key in command arguments.
The helper privately prompts for it and stores it locally with owner-only
permissions. A saved key is plaintext, not encrypted. An already configured
`CLOCKIFY_API_KEY` environment variable overrides the saved key and is not saved
by setup. It must be available to later commands too.

Use `--no-install` on every setup invocation in this mode, including key
replacement, regional setup, and fixed/automatic timezone changes. Do not use
`--agent`: Agensi is loading the skill for this session. Setup configures the
account and workspace but creates no time entries or installed skill copies.

## Persistent state and cleanup

Use the same configuration directory as local skill installations:
`${XDG_CONFIG_HOME:-~/.config}/clockify-ai-skill/`, or the existing
`CLOCKIFY_CONFIG_DIR` override. Keep it outside the temporary helper directory
and outside project repositories. Never choose a new configuration directory
for each session: the shared write lock and attempts journal protect against
duplicate or uncertain writes across sessions and agents.

Follow the normal command reference for previews, logging, and reconciliation.
After the operation completes, remove only the temporary helper directory you
created, including its credential-free input files. Do not clean up while setup
or another helper command is running or while the user still needs to run setup.
Never remove the persistent configuration or attempts journal, including after
an uncertain result. If the session is interrupted, retain the directory path
for cleanup when no command is using it.

Load the latest skill and fetch its scripts again for the next session. Do not
reuse a saved skill copy or install it into project or agent skill directories.
