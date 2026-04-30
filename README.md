# codex-supermemory

> Persistent memory for OpenAI Codex CLI — powered by [Supermemory](https://supermemory.ai)

Codex forgets every session. `codex-supermemory` wires Supermemory into Codex CLI's
hooks system so your coding agent remembers your stack, preferences, prior decisions,
and the lessons learned across every project — automatically.

## Features

- 🧠 **Automatic recall** — relevant memories are injected into every prompt via the
  `UserPromptSubmit` hook.
- 💾 **Automatic capture** — conversations are stored at the end of every session via
  the `Stop` hook.
- 🏷️ **Project + user scoping** — memories are tagged per-project and per-user so
  context never leaks across repos.
- 🔒 **Privacy-aware** — anything wrapped in `<private>...</private>` is redacted
  before being sent to Supermemory.
- ⚡ **Zero-config install** — one command sets up `~/.codex/config.toml` and
  `~/.codex/hooks.json` for you.
- 🪶 **No runtime deps in hooks** — the hook scripts are pre-bundled with esbuild for
  fast cold starts.

## Quick start

1. **Get an API key** at [console.supermemory.ai/keys](https://console.supermemory.ai/keys).

2. **Set it in your shell profile** (`~/.zshrc`, `~/.bashrc`, etc.):

   ```bash
   export SUPERMEMORY_CODEX_API_KEY="sm_..."
   ```

3. **Install the hooks:**

   ```bash
   npx codex-supermemory install
   ```

4. **Restart Codex CLI.** That's it — memory is active.

## How it works

Codex CLI supports a hooks system that lets external scripts run at specific
lifecycle events. `codex-supermemory` registers two:

| Hook              | Event                  | What it does                                                        |
| ----------------- | ---------------------- | ------------------------------------------------------------------- |
| `recall`          | `UserPromptSubmit`     | Searches Supermemory for relevant past memories and your profile, then injects them into the prompt as `additionalContext`. |
| `capture`         | `Stop`                 | Stores the full conversation transcript in Supermemory, tagged with both your project and user containers. |

The installer:

- Enables the `codex_hooks` feature flag in `~/.codex/config.toml`
- Registers the two hooks in `~/.codex/hooks.json`
- Copies pre-bundled hook scripts to `~/.codex/supermemory/`

The hooks are tolerant: if Supermemory is unreachable, the API key is missing, or
anything else fails, they exit cleanly without breaking your Codex session.

## Configuration

### Environment variables

| Variable                       | Purpose                                                |
| ------------------------------ | ------------------------------------------------------ |
| `SUPERMEMORY_CODEX_API_KEY`    | **Required.** Your Supermemory API key.                |
| `SUPERMEMORY_DEBUG`            | Set to any truthy value to enable debug logging to `~/.codex-supermemory.log`. |

### `~/.codex/supermemory.json` (optional)

Drop this file in to override defaults:

| Key                      | Type      | Default        | Description                                                                                  |
| ------------------------ | --------- | -------------- | -------------------------------------------------------------------------------------------- |
| `apiKey`                 | `string`  | —              | API key (env var takes precedence).                                                          |
| `similarityThreshold`    | `number`  | `0.6`          | Minimum similarity score for retrieved memories.                                             |
| `maxMemories`            | `number`  | `5`            | Max memories injected per prompt.                                                            |
| `maxProfileItems`        | `number`  | `5`            | Max profile items considered.                                                                |
| `injectProfile`          | `boolean` | `true`         | Whether to fetch and inject the user profile.                                                |
| `containerTagPrefix`     | `string`  | `"codex"`      | Prefix for auto-generated container tags.                                                    |
| `userContainerTag`       | `string`  | auto           | Override the user container tag.                                                             |
| `projectContainerTag`    | `string`  | auto (per-cwd) | Override the project container tag.                                                          |
| `filterPrompt`           | `string`  | (sensible)     | Filter prompt used by Supermemory's stateful filter.                                         |
| `debug`                  | `boolean` | `false`        | Enable debug logging.                                                                        |
| `autoSaveEveryTurns`     | `number`  | `3`            | Save new transcript messages every N prompts via the prompt hook. Set to `0` to disable periodic checkpoints. |

User and project tags are auto-derived from your `git config user.email` and the
current working directory (both hashed) when not explicitly set.

## Commands

```bash
codex-supermemory install     # set up hooks + config
codex-supermemory uninstall   # remove hooks + config (keeps your memories)
codex-supermemory status      # show current install status
```

## Privacy

Anything wrapped in `<private>...</private>` is replaced with `[REDACTED]` before
being sent to Supermemory. Use this for secrets, tokens, or anything you'd rather
not have stored.

## License

MIT
