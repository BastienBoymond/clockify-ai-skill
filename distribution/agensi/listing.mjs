export const listing = {
  name: 'Clockify Time Entries',
  summary: 'Log and correct Clockify time entries from your AI agent. Preview changes, follow your Clockify timezone, and avoid duplicate entries.',
  pricing: { model: 'Subscription', monthlyUsd: 5, yearly: false },
  tags: ['Clockify', 'time tracking', 'timesheets', 'productivity', 'automation'],
  keywords: ['Clockify', 'time entries', 'timesheets', 'freelancers', 'Claude Code', 'Codex'],
  categories: ['Productivity', 'Workflow Automation', 'Business & Operations'],
  useCases: [
    'Log completed client work from a natural-language request.',
    'Preview rounded time blocks before saving them.',
    'Correct an existing entry while preserving fields you did not ask to change.',
    'Keep time entries aligned with your Clockify profile timezone.',
  ],
  docsUrl: 'https://github.com/BastienBoymond/clockify-ai-skill#readme',
  description: `Turn a short work summary into Clockify time entries from Claude Code or Codex. Built for developers and freelancers who already use Clockify and want to log or correct their own work from the agent they use every day.

### What you can do

- Log completed work using a date, start time, duration, and an existing Clockify project.
- Ask for a read-only preview before saving anything.
- Correct descriptions, times, or project details on an existing entry. Fields you omit stay unchanged.
- Follow your Clockify profile timezone automatically, or choose a fixed timezone.
- Handle multiple entries in one request, with clear reporting if only part of the batch succeeds.

For example: “Preview 50 minutes on October 26, 2026, starting at 09:00 on Project Alpha, description: Fix API pagination.” The preview shows 09:00–10:00 because requested durations round up to the next 15 minutes. Start times stay unchanged.

### Designed for reliable corrections

An exact interval match updates the existing entry instead of creating a second block. Partial overlaps require choosing the entry to correct. If a network problem leaves a write uncertain, the helper checks the original request before allowing new writes.

### Getting started

You need Node.js 22+, a supported agent with local terminal and file access, and your own Clockify account and API key. Setup asks for the key privately in your terminal and remembers the workspace and timezone. No additional Clockify MCP server or runtime npm packages are required. Through Agensi, the helper runs temporarily and keeps only its configuration and write journal between sessions.

### Subscription and source availability

The $5/month subscription provides access to the current skill through Agensi and supports its creator. The same project's source code is publicly available on [GitHub](https://github.com/BastienBoymond/clockify-ai-skill); this is not exclusive content. The subscription does not include Clockify or AI-agent subscriptions, a hosted automation service, guaranteed future features, or dedicated support.`,
  compatibility: 'Designed for Claude Code and Codex with Node.js 22+ on macOS, Linux, or Windows through WSL. Requires a local terminal, file read/write permissions, network access, and a Clockify account with an API key. The Agensi connection delivers the skill; no additional Clockify MCP server is needed. Other agents have not been validated.',
  requiredSoftware: [
    'Node.js 22+',
    'macOS, Linux, or Windows through WSL',
    'Claude Code or Codex with local terminal and file access',
    'Clockify account and API key',
    'Agensi connection for loading the skill',
  ],
  toolsUsed: ['Terminal / Shell', 'Read Files', 'Write Files', 'Network Access', 'Environment Variables'],
  toolsNotUsed: ['Browser'],
  services: ['Clockify'],
  otherTool: 'clockify.me',
  hosts: ['api.clockify.me', 'euc1.clockify.me', 'use2.clockify.me', 'euw2.clockify.me', 'apse2.clockify.me'],
  fileScopes: [
    '$TMPDIR/clockify-agensi-*/**',
    '/tmp/clockify-agensi-*/**',
    '~/.config/clockify-ai-skill/**',
    '$XDG_CONFIG_HOME/clockify-ai-skill/**',
    '$CLOCKIFY_CONFIG_DIR/**',
  ],
  permissionNotes: 'The terminal runs the bundled Node.js helper. File access is limited to its temporary scripts and credential-free request JSON, plus persistent Clockify configuration, locks, and attempt records. File-scope variables refer to their expanded local paths; the XDG_CONFIG_HOME and CLOCKIFY_CONFIG_DIR scopes apply only when configured. The helper reads CLOCKIFY_API_KEY when supplied and uses CLOCKIFY_CONFIG_DIR or XDG_CONFIG_HOME for configuration location overrides. It contacts only the selected Clockify API region for account, project, and time-entry operations. It does not inspect Git repositories or require browser automation. A saved API key is plaintext with owner-only file permissions, not encrypted; an environment-provided key is not saved. Never enter your API key in chat. Previews perform reads only; logging and correction requests authorize their corresponding writes, subject to agent permissions.',
  limitations: `Requested durations round up to the next 15 minutes; this is not configurable. New descriptions must be one line, at most 12 words and 100 characters. A start time is required for new work.

The helper logs regular entries for the authenticated user in the configured workspace. It does not run timers, infer hours from Git, delete or merge entries, create projects, or log another user's time. Future-ended blocks require an explicit request. Locked entries cannot be changed.

Clockify API limits and workspace-required fields still apply. Large histories may require several API requests for overlap checks. A network failure can leave a result uncertain and block further writes until it is reconciled. Edits made outside this helper cannot be made atomic with its updates.

Native Windows without WSL and agents other than Claude Code or Codex have not been validated.`,
  faq: [
    { question: 'What does the subscription include?', answer: 'Access to the current skill through Agensi for $5/month. Clockify and AI-agent subscriptions are separate. It does not include a hosted service, dedicated support, or a promise of future features. The source code is also publicly available on GitHub.' },
    { question: 'Where do I enter my Clockify API key?', answer: 'Run the setup command provided by the skill in your own interactive terminal. The input is hidden. A saved key stays on your machine as plaintext protected by owner-only file permissions. You can instead supply CLOCKIFY_API_KEY through your environment. Never paste the key into chat.' },
    { question: 'Can I preview changes before saving?', answer: 'Yes. Ask for a preview and the helper reads Clockify, resolves the proposed entries, and shows the result without writing time entries or its persistent configuration and journal.' },
    { question: 'Will correcting an entry change its other details?', answer: 'Only the fields you ask to change are supplied to the update. Existing times, project, task, tags, billability, and custom fields are preserved when omitted. The entry keeps its ID.' },
    { question: 'Why did 50 minutes become one hour?', answer: 'Requested durations always round up to the next 15 minutes. A 50-minute request becomes 60 minutes; the start stays the same and the end moves. Previews show this before saving. Description-only corrections preserve existing times.' },
    { question: 'What happens if an entry already exists?', answer: 'One entry with exactly the same interval is updated in place, or left unchanged if it already matches. Partial overlaps or multiple matches require you to select the entry to correct. Existing duplicates are not deleted automatically.' },
    { question: 'Do I need to update the timezone manually?', answer: 'By default, the helper reads your Clockify profile timezone before reading or preparing entries. You can also configure a fixed timezone. Existing timestamps remain unchanged unless you explicitly edit the times.' },
    { question: 'Does this track my work automatically or read Git history?', answer: 'No. You provide the work description and time period. This skill does not run a background tracker, start timers, or infer hours from repository activity.' },
    { question: 'Is the demo a live Clockify recording?', answer: 'No. It is a reproducible read-only preview using fictional data and a simulated Clockify API. The bundled helper produces the displayed intervals, and no real account is contacted.' },
  ],
};
