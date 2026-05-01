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
lifecycle events. `codex-supermemory` registers one hook:

| Hook              | Event                  | What it does                                                        |
| ----------------- | ---------------------- | ------------------------------------------------------------------- |
| `recall`          | `UserPromptSubmit`     | Captures new turns (every N prompts), then searches Supermemory for relevant memories and your profile, injecting them into the prompt as `additionalContext`. |

**Incremental capture**: Memories are saved every N turns (default: 3) during the session.
This means memories from earlier in your session are immediately available for recall
in the same session.

The installer:

- Enables the `codex_hooks` feature flag in `~/.codex/config.toml`
- Registers the hook in `~/.codex/hooks.json`
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

| Key                      | Type       | Default        | Description                                                                                  |
| ------------------------ | ---------- | -------------- | -------------------------------------------------------------------------------------------- |
| `apiKey`                 | `string`   | —              | API key (env var takes precedence, browser auth is preferred).                               |
| `similarityThreshold`    | `number`   | `0.6`          | Minimum similarity score for retrieved memories.                                             |
| `maxMemories`            | `number`   | `5`            | Max memories injected per prompt.                                                            |
| `maxProfileItems`        | `number`   | `5`            | Max profile items considered.                                                                |
| `injectProfile`          | `boolean`  | `true`         | Whether to fetch and inject the user profile.                                                |
| `containerTagPrefix`     | `string`   | `"codex"`      | Prefix for auto-generated container tags.                                                    |
| `userContainerTag`       | `string`   | auto           | Override the user container tag.                                                             |
| `projectContainerTag`    | `string`   | auto (per-cwd) | Override the project container tag.                                                          |
| `filterPrompt`           | `string`   | (sensible)     | Filter prompt used by Supermemory's stateful filter.                                         |
| `debug`                  | `boolean`  | `false`        | Enable debug logging.                                                                        |
| `autoSaveEveryTurns`     | `number`   | `3`            | Save memories every N turns (incremental capture).                                           |
| `signalExtraction`       | `boolean`  | `false`        | Enable signal-based filtering (only capture turns with keywords like "prefer", "decided").   |
| `signalKeywords`         | `string[]` | (defaults)     | Keywords that trigger signal extraction.                                                     |
| `signalTurnsBefore`      | `number`   | `3`            | Include N turns before a signal for context.                                                 |

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

These Codex skills are available as explicit commands when you need more control:

| Skill                  | Usage                                      | Description                              |
| ---------------------- | ------------------------------------------ | ---------------------------------------- |
| `/supermemory-search`  | `/supermemory-search <query>`              | Search memories manually.                |
| `/supermemory-save`    | `/supermemory-save <content>`              | Save a specific memory explicitly.       |
| `/supermemory-forget`  | `/supermemory-forget <content>`            | Remove a memory.                         |
| `/supermemory-login`   | `/supermemory-login`                       | Re-authenticate with Supermemory.        |

Skills are fallback commands — the hooks handle most use cases automatically.

## Privacy

Anything wrapped in `<private>...</private>` is replaced with `[REDACTED]` before
being sent to Supermemory. Use this for secrets, tokens, or anything you'd rather
not have stored.

## License

MIT
