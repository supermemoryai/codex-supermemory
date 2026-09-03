<div align="center">

# codex-supermemory

**Persistent memory for OpenAI Codex, powered by [Supermemory](https://supermemory.ai)**

[![npm version](https://img.shields.io/npm/v/codex-supermemory?color=9C5C10&label=npm)](https://www.npmjs.com/package/codex-supermemory)
[![license](https://img.shields.io/npm/l/codex-supermemory?color=9C5C10)](#license)
[![Codex CLI](https://img.shields.io/badge/Codex_CLI-hooks_%2B_MCP-9C5C10)](https://github.com/supermemoryai/codex-supermemory)

</div>

Codex forgets every session. `codex-supermemory` wires Supermemory into Codex CLI's
hooks system so your coding agent remembers your stack, preferences, prior decisions,
and the lessons learned across every project, automatically.

<div align="center">

[Quick start](#quick-start) · [Features](#features) · [How it works](#how-it-works) · [Shared containers](#shared-agents-containers) · [Configuration](#configuration) · [Commands](#commands) · [Status](#status) · [Privacy](#privacy)

</div>

---

## Quick start

1. **Install the hooks:**

   ```bash
   npx codex-supermemory install
   ```

2. **Start Codex CLI.** A browser window opens automatically at session start to
   authenticate with Supermemory.

   Alternatively, set `export SUPERMEMORY_CODEX_API_KEY="sm_..."` in your shell profile.

3. **That's it: memory is active.**

## Features

|  |  |
| --- | --- |
| 🧠 **Automatic recall**<br>Relevant memories are injected for substantive prompts via `UserPromptSubmit`, with visible recall counts and a 3-second network cap. | 🔎 **Hosted MCP tools**<br>Deeper search and explicit memory operations use `mcp.supermemory.ai` through the same credentials as the hooks. |
| 💾 **Automatic capture**<br>Completed turns are saved in the background via the `Stop` hook. | 🏷️ **Shared Agents scoping**<br>Codex, Claude Code, and OpenCode use one collision-safe repository container. |
| 🏷️ **Personal + project routing**<br>`sm_scope` metadata keeps automatic/personal memories distinguishable from explicit project knowledge. | 🧩 **Entity-aware extraction**<br>One coding-agent context covers durable preferences and project/codebase facts. |
| 🔒 **Privacy-aware**<br>Anything wrapped in `<private>...</private>` is redacted before being sent to Supermemory. | ⚡ **Zero-config install**<br>One command sets up `~/.codex/config.toml` and `~/.codex/hooks.json` for you. |
| 🪶 **No runtime deps in hooks**<br>Hook scripts are pre-bundled with esbuild for fast cold starts. | 🔧 **Focused status skill**<br>`$supermemory-status` checks authentication and connectivity; memory operations come from MCP. |
| ◪ **Persistent CLI mark**<br>A state-aware TUI badge whose accent color follows Codex's live agent state, plus live hook notices. | 🔔 **Update notices**<br>`SessionStart` checks npm for a newer release and surfaces a one-line notice, non-blocking. |


## How it works

Codex CLI supports hooks and MCP servers. `codex-supermemory` registers four hooks, in lifecycle order:

**`SessionStart`** → **`UserPromptSubmit`** → **`PreToolUse`** → **`Stop`**

| Step | Hook | Event | What it does |
| --- | --- | --- | --- |
| 1 | `session-start` | `SessionStart` | Loads persistent and recent profile context for the session. |
| 2 | `recall` | `UserPromptSubmit` | Searches Supermemory directly, injects fresh relevant memories, and prints `◪ supermemory · recalled …`. |
| 3 | `recall-approve` | `PreToolUse` | Prints the MCP search query and auto-allows read-only Supermemory tools. |
| 4 | `flush` | `Stop` | Captures the completed turn in the background. |

Prompt recall and automatic capture call the Supermemory API directly. Deeper model-initiated
search, add, list, and forget operations go through the hosted MCP server.

The installer:

- Registers the `supermemory` MCP server in `~/.codex/config.toml`
- Registers the hooks in `~/.codex/hooks.json`
- Copies pre-bundled hook scripts to `~/.codex/supermemory/`
- Installs only the `supermemory-status` skill to `~/.codex/skills/`
- Installs a state-aware custom TUI badge to `~/.codex/pets/supermemory/`

The installer selects the badge only when no Codex pet preference already exists. Terminals
without a supported inline-image protocol may not render it; recall and capture continue to work.
Use Codex's `/pet` picker to disable or change the persistent badge.

The hooks are tolerant: if Supermemory is unreachable, the API key is missing, or
anything else fails, they exit cleanly without breaking your Codex session.

### Shared Agents containers

Codex, Claude Code, and OpenCode use one container for a repository:

```
repo_<project-name>__<remote-hash>   stores automatic capture and every explicit save
sm_scope                             metadata preserving optional personal/project filtering
```

The hash comes from the normalized Git remote, so clones share memory while
same-named repositories do not collide. Repositories without a remote fall back to
a local path identity. Codex also reads the previous `user_project_*`,
`repo_<project-name>`, `codex_user_*`, `codex_project_*`,
`claudecode_project_*`, `opencode_user_*`, `opencode_project_*`,
`cursor_user_*`, and `cursor_project_*` containers, so existing memories
remain searchable without duplicating or migrating them. Set
`SUPERMEMORY_ISOLATE_WORKTREES=true` to use the worktree path instead of the
remote identity.

Explicit `projectContainerTag`/`repoContainerTag` overrides remain the canonical
write destination. Older user/personal overrides remain in the legacy read set.

## Configuration

### Environment variables

| Variable | Purpose |
| --- | --- |
| `SUPERMEMORY_CODEX_API_KEY` | Your Supermemory API key (browser auth is preferred). |
| `SUPERMEMORY_API_URL` / `SUPERMEMORY_BASE_URL` | Override the Supermemory API base URL (takes precedence over config). |
| `SUPERMEMORY_MCP_URL` | Override the hosted MCP endpoint (default `https://mcp.supermemory.ai/mcp`). |
| `SUPERMEMORY_AUTH_URL` | Override the browser-auth base URL (default `https://console.supermemory.ai/auth/connect`). |
| `SUPERMEMORY_AUTH_TIMEOUT` | Browser-auth timeout in milliseconds, bounded by the `SessionStart` hook timeout. |
| `SUPERMEMORY_REPO_TAG` | Explicit project-container override, checked before the `projectContainerTag` config value. |
| `SUPERMEMORY_ISOLATE_WORKTREES` | Set to `true` to key the project container on the worktree path instead of the Git remote. |
| `SUPERMEMORY_DEBUG` | Set to any truthy value to enable debug logging to `~/.codex-supermemory.log`. |

<details>
<summary><strong>All <code>~/.codex/supermemory.json</code> keys (optional overrides)</strong></summary>
<br>

| Key | Type | Default | Description |
| --- | --- | --- | --- |
| `apiKey` | `string` | - | API key (env var takes precedence, browser auth is preferred). |
| `baseUrl` | `string` | `https://api.supermemory.ai` | Supermemory API base URL (`SUPERMEMORY_API_URL`/`SUPERMEMORY_BASE_URL` env vars take precedence). |
| `similarityThreshold` | `number` | `0.6` | Minimum similarity score for retrieved memories. |
| `maxMemories` | `number` | `5` | Max memories injected per prompt. |
| `maxProfileItems` | `number` | `5` | Max profile items considered from each persistent/recent section. |
| `injectProfile` | `boolean` | `true` | Whether to fetch and inject the user profile. |
| `containerTagPrefix` | `string` | `"codex"` | Legacy prefix retained when reading containers created by older versions. |
| `userContainerTag` | `string` | auto | Legacy personal container retained for backward-compatible reads. |
| `projectContainerTag` | `string` | auto (per-repo) | Explicit unified project-container override, also honored by Claude Code. |
| `filterPrompt` | `string` | (sensible) | Filter prompt used by Supermemory's stateful filter. |
| `debug` | `boolean` | `false` | Enable debug logging. |
| `recallMode` | `"direct" \| "off" \| "advisory"` | `"direct"` | Directly retrieve relevant memory, disable prompt recall, or inject an advisory directive. |
| `recallDirective` | `string` | (sensible) | Context injected when `recallMode` is `"advisory"`. |
| `autoRecallEveryPrompt` | `boolean` | - | Deprecated compatibility key; `true` maps to direct and `false` maps to off. |
| `autoSaveEveryTurns` | `number` | `3` | Deprecated compatibility setting; completed turns are captured by `Stop`. |
| `signalExtraction` | `boolean` | `false` | Enable signal-based filtering (only capture turns with keywords like "prefer", "decided"). |
| `signalKeywords` | `string[]` | (defaults) | Keywords that trigger signal extraction. |
| `signalTurnsBefore` | `number` | `3` | Include N turns before a signal for context. |

</details>

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
but may miss some context. Disabled by default; all turns are captured.

## Commands

```bash
npx codex-supermemory install     # set up hooks + MCP + status skill
npx codex-supermemory uninstall   # remove hooks + saved credential (memories stay in Supermemory)
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

---

<div align="center">
<sub>◪ is the supermemory mark. Whenever you see it (statusline, notices, Codex's answers), that information came from supermemory.</sub>
</div>
