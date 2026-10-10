# codex-supermemory

> Persistent memory for OpenAI Codex CLI — powered by [Supermemory](https://supermemory.ai)

Codex forgets every session. `codex-supermemory` wires Supermemory into Codex CLI's
hooks system so your coding agent remembers your stack, preferences, prior decisions,
and the lessons learned across every project — automatically.

## Features

- 🧠 **Automatic recall** — relevant memories are injected for substantive prompts via
  the `UserPromptSubmit` hook, with visible recall counts and a 3-second network cap.
- 🔎 **Hosted MCP tools** — deeper search and explicit memory operations use
  `mcp.supermemory.ai` through the same credentials as the hooks.
- 💾 **Automatic capture** — completed turns are saved in the background via the `Stop` hook.
- 🏷️ **Shared Agents scoping** — Codex, Claude Code, and OpenCode use one collision-safe
  repository container.
- 🏷️ **Personal + project routing** — `sm_scope` metadata keeps automatic/personal
  memories distinguishable from explicit project knowledge in the shared container.
- **Entity-aware extraction** - the shared container uses one coding-agent context
  covering durable preferences and project/codebase facts.
- 🔒 **Privacy-aware** — anything wrapped in `<private>...</private>` is redacted
  before being sent to Supermemory.
- ⚡ **Zero-config install** — one command sets up `~/.codex/config.toml` and
  `~/.codex/hooks.json` for you.
- 🪶 **No runtime deps in hooks** — the hook scripts are pre-bundled with esbuild for
  fast cold starts.
- 🔧 **Status and index skills** — `$supermemory-status` checks authentication and
  connectivity; `$supermemory-index` explores the repo and saves focused memories
  via MCP `add_memory`. Memory operations still come from MCP, not command skills.
- ◪ **Persistent CLI mark** — compatible Codex terminals keep a quiet Supermemory badge
  at the bottom of the TUI, while hook notices report live recall and save activity.

## Quick start

1. **Install the hooks:**

   ```bash
   npx codex-supermemory install
   ```

2. **Start Codex CLI.** On your first prompt, a browser window will open to
   authenticate with Supermemory automatically.

   Alternatively, set `export SUPERMEMORY_CODEX_API_KEY="sm_..."` in your shell profile.

3. **That's it — memory is active.**

## How it works

Codex CLI supports hooks and MCP servers. `codex-supermemory` registers four hooks:

| Hook              | Event                  | What it does                                                        |
| ----------------- | ---------------------- | ------------------------------------------------------------------- |
| `recall`          | `UserPromptSubmit`     | Searches Supermemory directly, injects fresh relevant memories, and prints `◪ supermemory · recalled …`. |
| `recall-approve`  | `PreToolUse`           | Prints the MCP search query and auto-allows read-only Supermemory tools. |
| `flush`           | `Stop`                 | Captures completed turns in the background. |
| `session-start`   | `SessionStart`         | Loads persistent and recent profile context for the session. |

Prompt recall and automatic capture call the Supermemory API directly. Deeper model-initiated
search, add, list, and forget operations go through the hosted MCP server.

The installer:

- Registers the `supermemory` MCP server in `~/.codex/config.toml`
- Registers the hooks in `~/.codex/hooks.json`
- Copies pre-bundled hook scripts to `~/.codex/supermemory/`
- Installs the `supermemory-status` and `supermemory-index` skills to `~/.codex/skills/`
- Installs a static custom TUI badge to `~/.codex/pets/supermemory/`

The installer selects the badge only when no Codex pet preference already exists. Terminals
without a supported inline-image protocol may not render it; recall and capture continue to work.
Use Codex's `/pet` picker to disable or change the persistent badge.

The hooks are tolerant: if Supermemory is unreachable, the API key is missing, or
anything else fails, they exit cleanly without breaking your Codex session.

### Shared Agents containers

Codex, Claude Code, and OpenCode use one container for a repository:

- `repo_<project-name>__<remote-hash>` stores automatic capture and every explicit save.
- `sm_scope` metadata preserves optional personal/project filtering.

The hash comes from the normalized Git remote, so clones share memory while
same-named repositories do not collide. Repositories without a remote fall back to
a local path identity. Codex also reads the previous `user_project_*`,
`repo_<project-name>`, `codex_user_*`, `codex_project_*`,
`claudecode_project_*`, `opencode_user_*`, and `opencode_project_*`
containers, so existing memories remain searchable without duplicating or
migrating them. Set `SUPERMEMORY_ISOLATE_WORKTREES=true` to use the worktree
path instead of the remote identity.

Explicit `projectContainerTag`/`repoContainerTag` overrides remain the canonical
write destination. Older user/personal overrides remain in the legacy read set.

## Configuration

### API v5 and existing installations

Version 1.0.20 bundles the official `supermemory@5.0.1` SDK for document capture,
profiles, search, and the status connectivity probe. Existing container-tag
strings become namespace paths without renaming stored data. Config keys,
credential files, session document IDs, capture cursors, legacy namespace reads,
and recall approvals stay in place; no historical backfill or namespace move runs.
Re-run `npx codex-supermemory@latest install` after upgrading to refresh the copied
standalone hooks and status script. Updating npm dependencies alone doesn't
update scripts already installed in `~/.codex/supermemory`.

The hosted root `https://api.supermemory.ai` defaults to v5, including equivalent
host casing and default-port spellings. Custom REST URLs, including URL prefixes,
default to the bundled official SDK4 compatibility path so servers older than
0.0.9 remain usable. After upgrading a custom server, set
`SUPERMEMORY_API_VERSION=v5` or `apiVersion: "v5"` in the existing config. Select
`legacy` explicitly to use v3/v4 where the server still supports them. Invalid
version selections fail the operation; a failed v5 request never switches API
versions or sends data to another host. REST URL selection remains independent
of the hosted MCP and browser-auth endpoints, including their existing env fields.

The v5 profile has no query; prompt recall runs profile and memory search in
parallel. Separated search explicitly uses the guide's legacy defaults (memories,
0.6 threshold, 10 candidates, no reranking/query rewriting), then preserves the
local 0.55 floor, cross-namespace deduplication, and top-five/configured cap. The
SDK search helper retains its existing hybrid mode and configured threshold and
limit. Server-side ranking and historical-data availability aren't verified by
local contract tests. Capture keeps its three-second budget and zero SDK retries,
uses POST append/diff with the existing session ID, and advances the cursor only
after valid acceptance. Dynamic processing is asynchronous; acceptance doesn't
prove extraction completion or exactly-once billing after a lost response.

The retained `dist/services/client.js` library exports still have their original
30-second local wait and two-retry SDK cap for calls without hook options. SDK5's
retryable statuses/backoff differ from SDK4, including no automatic 409 retry.
Installed automatic hooks don't use that unbounded policy: a conflict keeps the
capture cursor for a later attempt without an immediate retry. Explicit MCP
operations still use their independent transport rather than these SDK helpers.

Display-name updates (`/v3/container-tags/...`), account details (`/v3/session`),
and the latent exact-content forget helper (`/v4/memories`) remain legacy-only
ancillary operations against the configured REST server. They have no mechanical
v5 equivalent. A v5-only server may leave names/account details unavailable or
return an explicit forget error; the plugin does not substitute semantic deletion.
Interactive MCP tools keep their independent protocol, endpoints, and approvals.

### Environment variables

| Variable                       | Purpose                                                |
| ------------------------------ | ------------------------------------------------------ |
| `SUPERMEMORY_CODEX_API_KEY`    | Your Supermemory API key (browser auth is preferred).  |
| `SUPERMEMORY_API_URL`          | Override the Supermemory API base URL (takes precedence over config). |
| `SUPERMEMORY_BASE_URL`         | Older REST URL alias, used when `SUPERMEMORY_API_URL` is unset. |
| `SUPERMEMORY_API_VERSION`      | Select `v5` or `legacy`; overrides `apiVersion` in config. |
| `SUPERMEMORY_DEBUG`            | Set to any truthy value to enable debug logging to `~/.codex-supermemory.log`. |

### `~/.codex/supermemory.json` (optional)

Drop this file in to override defaults:

| Key                      | Type       | Default        | Description                                                                                  |
| ------------------------ | ---------- | -------------- | -------------------------------------------------------------------------------------------- |
| `apiKey`                 | `string`   | —              | API key (env var takes precedence, browser auth is preferred).                               |
| `baseUrl`                | `string`   | `https://api.supermemory.ai` | Supermemory API base URL (`SUPERMEMORY_API_URL`/`SUPERMEMORY_BASE_URL` env vars take precedence). |
| `apiVersion`             | `"v5" \| "legacy"` | auto | Hosted root API uses v5; custom REST URLs default to legacy compatibility. |
| `similarityThreshold`    | `number`   | `0.6`          | Minimum similarity score for retrieved memories.                                             |
| `maxMemories`            | `number`   | `5`            | Max memories injected per prompt.                                                            |
| `maxProfileItems`        | `number`   | `5`            | Max profile items considered from each persistent/recent section.                            |
| `injectProfile`          | `boolean`  | `true`         | Whether to fetch and inject the user profile.                                                |
| `containerTagPrefix`     | `string`   | `"codex"`      | Legacy prefix retained when reading containers created by older versions.                    |
| `userContainerTag`       | `string`   | auto           | Legacy personal container retained for backward-compatible reads.                            |
| `projectContainerTag`    | `string`   | auto (per-repo) | Explicit unified project-container override, also honored by Claude Code. Can also be set per-repo in `<repo>/.codex/supermemory.json` (see below). |
| `filterPrompt`           | `string`   | (sensible)     | Filter prompt used by Supermemory's stateful filter.                                         |
| `debug`                  | `boolean`  | `false`        | Enable debug logging.                                                                        |
| `recallMode`             | `"direct" \| "off" \| "advisory"` | `"direct"` | Directly retrieve relevant memory, disable prompt recall, or inject an advisory directive. |
| `recallDirective`        | `string`   | (sensible)     | Context injected when `recallMode` is `"advisory"`.                                        |
| `autoRecallEveryPrompt`  | `boolean`  | —              | Deprecated compatibility key; `true` maps to direct and `false` maps to off.                 |
| `autoSaveEveryTurns`     | `number`   | `3`            | Deprecated compatibility setting; completed turns are captured by `Stop`.                    |
| `signalExtraction`       | `boolean`  | `false`        | Enable signal-based filtering (only capture turns with keywords like "prefer", "decided").   |
| `signalKeywords`         | `string[]` | (defaults)     | Keywords that trigger signal extraction.                                                     |
| `signalTurnsBefore`      | `number`   | `3`            | Include N turns before a signal for context.                                                 |

Project tags combine the sanitized repository name with a normalized Git-remote
hash. Linked worktrees and clones of the same remote therefore share one container;
same-named repositories with different remotes do not collide. Without a remote,
the Git common directory is used as the fallback identity.

### `<repo>/.codex/supermemory.json` (optional, repo-local)

A checked-in `.codex/supermemory.json` at the Git root overrides the container tag
for that repo only, so a team can share one memory bucket across Codex, Claude
Code, and other agents without every member setting `projectContainerTag` in their
global config (whose value would differ per checkout). Only the tag fields are
read from the repo-local file — everything else stays global:

| Key                   | Description                                                              |
| --------------------- | ---------------------------------------------------------------------- |
| `projectContainerTag` | Project/repo container for this repo. Outranks every other source.      |
| `userContainerTag`    | Personal container added to the legacy read set for this repo.          |

Resolution order for the project tag, highest first: `<repo>/.codex/supermemory.json`
→ Claude Code's repo config → `SUPERMEMORY_REPO_TAG` → Cursor's repo config →
global `~/.codex/supermemory.json` → generated `repo_<name>__<hash>`. The
previously active tag stays in the read set, so memory written before the override
is still found.

### Entity context

Codex sends one shared coding-agent `entityContext` whenever it saves memories. It
covers durable preferences, workflows, architecture, conventions, setup, decisions,
and implementation lessons without one save type overwriting another container-level
context.

### Signal extraction (optional)

When `signalExtraction` is enabled, only conversation turns containing signal keywords
(like "prefer", "decided", "remember", "bug", "fix") are captured. This reduces noise
but may miss some context. Disabled by default — all turns are captured.

## Commands

```bash
npx codex-supermemory install     # set up hooks + MCP + skills
npx codex-supermemory uninstall   # remove hooks + config (keeps your memories)
npx codex-supermemory status      # show current install status
```

## Status

Run `$supermemory-status` inside Codex to check the saved credential, API reachability,
active project container, and account details. Browser authentication is automatic on
`SessionStart`; there is no separate login skill.

## Index a codebase

Run `$supermemory-index` inside Codex to explore the repository and save several
focused memories about architecture, conventions, and how to run it. The skill is
an agent workflow; the actual writes go through the hosted MCP `add_memory` tool.

## Privacy

Anything wrapped in `<private>...</private>` is replaced with `[REDACTED]` before
being sent to Supermemory. Use this for secrets, tokens, or anything you'd rather
not have stored.

## License

MIT
