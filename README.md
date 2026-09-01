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
- 🔧 **Focused status skill** — `$supermemory-status` checks authentication and connectivity;
  memory operations come from MCP instead of separate command skills.

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
- Installs only the `supermemory-status` skill to `~/.codex/skills/`

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

### Environment variables

| Variable                       | Purpose                                                |
| ------------------------------ | ------------------------------------------------------ |
| `SUPERMEMORY_CODEX_API_KEY`    | Your Supermemory API key (browser auth is preferred).  |
| `SUPERMEMORY_API_URL`          | Override the Supermemory API base URL (takes precedence over config). |
| `SUPERMEMORY_DEBUG`            | Set to any truthy value to enable debug logging to `~/.codex-supermemory.log`. |

### `~/.codex/supermemory.json` (optional)

Drop this file in to override defaults:

| Key                      | Type       | Default        | Description                                                                                  |
| ------------------------ | ---------- | -------------- | -------------------------------------------------------------------------------------------- |
| `apiKey`                 | `string`   | —              | API key (env var takes precedence, browser auth is preferred).                               |
| `baseUrl`                | `string`   | `https://api.supermemory.ai` | Supermemory API base URL (`SUPERMEMORY_API_URL`/`SUPERMEMORY_BASE_URL` env vars take precedence). |
| `similarityThreshold`    | `number`   | `0.6`          | Minimum similarity score for retrieved memories.                                             |
| `maxMemories`            | `number`   | `5`            | Max memories injected per prompt.                                                            |
| `maxProfileItems`        | `number`   | `5`            | Max profile items considered from each persistent/recent section.                            |
| `injectProfile`          | `boolean`  | `true`         | Whether to fetch and inject the user profile.                                                |
| `containerTagPrefix`     | `string`   | `"codex"`      | Legacy prefix retained when reading containers created by older versions.                    |
| `userContainerTag`       | `string`   | auto           | Legacy personal container retained for backward-compatible reads.                            |
| `projectContainerTag`    | `string`   | auto (per-repo) | Explicit unified project-container override, also honored by Claude Code.                    |
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
npx codex-supermemory install     # set up hooks + MCP + status skill
npx codex-supermemory uninstall   # remove hooks + config (keeps your memories)
npx codex-supermemory status      # show current install status
```

## Status

Run `$supermemory-status` inside Codex to check the saved credential, API reachability,
active project container, and account details. Browser authentication is automatic on
`SessionStart`; there is no separate login skill.

## Privacy

Anything wrapped in `<private>...</private>` is replaced with `[REDACTED]` before
being sent to Supermemory. Use this for secrets, tokens, or anything you'd rather
not have stored.

## License

MIT
