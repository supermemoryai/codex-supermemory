# codex-supermemory

> Persistent memory for OpenAI Codex CLI — powered by [Supermemory](https://supermemory.ai)

Codex forgets every session. `codex-supermemory` wires Supermemory into Codex CLI's
hooks system so your coding agent remembers your stack, preferences, prior decisions,
and the lessons learned across every project — automatically.

## Features

- 🧠 **Automatic recall** — relevant memories are injected into every prompt via the
  `UserPromptSubmit` hook.
- 💾 **Automatic capture** — conversations are stored incrementally (every N turns) and
  at session end via the `Stop` hook.
- 🏷️ **Project + user scoping** — memories are tagged per-project and per-user so
  context never leaks across repos.
- 📦 **Custom container tags** — define custom memory containers (e.g., `work`, `personal`,
  `code_style`). The AI automatically picks the right container based on your instructions
  when saving, searching, or forgetting memories.
- 🔒 **Privacy-aware** — anything wrapped in `<private>...</private>` is redacted
  before being sent to Supermemory.
- ⚡ **Zero-config install** — one command sets up `~/.codex/config.toml` and
  `~/.codex/hooks.json` for you.
- 🪶 **No runtime deps in hooks** — the hook scripts are pre-bundled with esbuild for
  fast cold starts.
- 🔧 **Fallback skills** — explicit `/supermemory-search`, `/supermemory-save`, and
  `/supermemory-forget` commands available when hooks don't cover your use case.

## Quick start

1. **Install the hooks:**

   ```bash
   npx codex-supermemory install
   ```

2. **Start Codex CLI.** On your first prompt, a browser window will open to
   authenticate with Supermemory automatically.

   Alternatively, authenticate manually:
   - Use `$supermemory-login` inside Codex
   - Or set `export SUPERMEMORY_CODEX_API_KEY="sm_..."` in your shell profile

3. **That's it — memory is active.**

## How it works

Codex CLI supports a hooks system that lets external scripts run at specific
lifecycle events. `codex-supermemory` registers two hooks:

| Hook              | Event                  | What it does                                                        |
| ----------------- | ---------------------- | ------------------------------------------------------------------- |
| `recall`          | `UserPromptSubmit`     | Captures new turns (every N prompts), then searches Supermemory for relevant memories and your profile, injecting them into the prompt as `additionalContext`. |
| `flush`           | `Stop`                 | Captures any remaining turns at session end so the final conversation turns are never lost. |

**Incremental capture**: Memories are saved every N turns (default: 3) during the session.
This means memories from earlier in your session are immediately available for recall
in the same session. The flush hook ensures any trailing turns are captured when the
session ends.

The installer:

- Enables the `codex_hooks` feature flag in `~/.codex/config.toml`
- Registers the hooks in `~/.codex/hooks.json`
- Copies pre-bundled hook scripts to `~/.codex/supermemory/`
- Installs skills to `~/.codex/skills/`

The hooks are tolerant: if Supermemory is unreachable, the API key is missing, or
anything else fails, they exit cleanly without breaking your Codex session.

## Configuration

### Environment variables

| Variable                       | Purpose                                                |
| ------------------------------ | ------------------------------------------------------ |
| `SUPERMEMORY_CODEX_API_KEY`    | Your Supermemory API key (browser auth is preferred).  |
| `SUPERMEMORY_DEBUG`            | Set to any truthy value to enable debug logging to `~/.codex-supermemory.log`. |

### `~/.codex/supermemory.json` (optional)

Drop this file in to override defaults:

| Key                            | Type       | Default        | Description                                                                                  |
| ------------------------------ | ---------- | -------------- | -------------------------------------------------------------------------------------------- |
| `apiKey`                       | `string`   | —              | API key (env var takes precedence, browser auth is preferred).                               |
| `similarityThreshold`          | `number`   | `0.6`          | Minimum similarity score for retrieved memories.                                             |
| `maxMemories`                  | `number`   | `5`            | Max memories injected per prompt.                                                            |
| `maxProfileItems`              | `number`   | `5`            | Max profile items considered.                                                                |
| `injectProfile`                | `boolean`  | `true`         | Whether to fetch and inject the user profile.                                                |
| `containerTagPrefix`           | `string`   | `"codex"`      | Prefix for auto-generated container tags.                                                    |
| `userContainerTag`             | `string`   | auto           | Override the user container tag.                                                             |
| `projectContainerTag`          | `string`   | auto (per-cwd) | Override the project container tag.                                                          |
| `filterPrompt`                 | `string`   | (sensible)     | Filter prompt used by Supermemory's stateful filter.                                         |
| `debug`                        | `boolean`  | `false`        | Enable debug logging.                                                                        |
| `autoSaveEveryTurns`           | `number`   | `3`            | Save memories every N turns (incremental capture).                                           |
| `signalExtraction`             | `boolean`  | `false`        | Enable signal-based filtering (only capture turns with keywords like "prefer", "decided").   |
| `signalKeywords`               | `string[]` | (defaults)     | Keywords that trigger signal extraction.                                                     |
| `signalTurnsBefore`            | `number`   | `3`            | Include N turns before a signal for context.                                                 |
| `enableCustomContainers`       | `boolean`  | `false`        | Enable AI-driven routing to custom containers.                                               |
| `customContainers`             | `array`    | `[]`           | Custom containers with `tag` and `description` (see below).                                  |
| `customContainerInstructions`  | `string`   | `""`           | Free-text instructions for the AI on how to route memories to containers.                    |

User and project tags are auto-derived from your `git config user.email` and the
current working directory (both hashed) when not explicitly set.

### Signal extraction (optional)

When `signalExtraction` is enabled, only conversation turns containing signal keywords
(like "prefer", "decided", "remember", "bug", "fix") are captured. This reduces noise
but may miss some context. Disabled by default — all turns are captured.

## Commands

```bash
npx codex-supermemory install     # set up hooks + config + skills
npx codex-supermemory uninstall   # remove hooks + config (keeps your memories)
npx codex-supermemory status      # show current install status
```

## Skills (fallback commands)

These Codex skills are available as explicit commands when you need more control.
All memory skills support `--container <tag>` to target a specific custom container.

| Skill                  | Usage                                                       | Description                              |
| ---------------------- | ----------------------------------------------------------- | ---------------------------------------- |
| `/supermemory-search`  | `/supermemory-search [--container <tag>] <query>`           | Search memories manually.                |
| `/supermemory-save`    | `/supermemory-save [--container <tag>] <content>`           | Save a specific memory explicitly.       |
| `/supermemory-forget`  | `/supermemory-forget [--container <tag>] <content>`         | Remove a memory.                         |
| `/supermemory-login`   | `/supermemory-login`                                        | Re-authenticate with Supermemory.        |

Skills are fallback commands — the hooks handle most use cases automatically.

## Custom Container Tags

Custom container tags let you organize memories into separate buckets (e.g., `work`,
`personal`, `code_style`). The AI reads the container descriptions from your config
and automatically picks the right container when saving memories.

### Setup

Add these fields to `~/.codex/supermemory.json`:

```json
{
  "enableCustomContainers": true,
  "customContainers": [
    { "tag": "personal", "description": "Personal life — family, health, hobbies, routines" },
    { "tag": "work", "description": "Work-related — projects, deadlines, meetings, colleagues" },
    { "tag": "code_style", "description": "Coding preferences — languages, tools, patterns, conventions" }
  ],
  "customContainerInstructions": "Route coding preferences to code_style. Personal topics to personal. Default to project container for ambiguous content."
}
```

### How it works

1. You define containers with a `tag` (identifier) and a `description` (plain English
   explaining what belongs there).
2. On every prompt, the container catalog is injected into the AI's context so it knows
   what containers are available.
3. When the AI saves a memory (via `/supermemory-save`), it picks the best matching
   container based on the descriptions and uses `--container <tag>`.
4. When searching or forgetting, the AI can also target specific containers.
5. Automatic capture (background saving) always goes to the default project/user
   containers — only explicit saves get routed to custom containers.

Each container tag automatically becomes a **Space** on the
[Supermemory dashboard](https://app.supermemory.ai), so you can view and manage
memories organized by category.

### Container config reference

| Field              | Type     | Description                                        |
| ------------------ | -------- | -------------------------------------------------- |
| `tag`              | `string` | Unique identifier for the container (e.g. `work`). |
| `description`      | `string` | Plain English description for AI routing.           |

## Privacy

Anything wrapped in `<private>...</private>` is replaced with `[REDACTED]` before
being sent to Supermemory. Use this for secrets, tokens, or anything you'd rather
not have stored.

## License

MIT
