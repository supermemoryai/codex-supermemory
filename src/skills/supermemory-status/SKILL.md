---
name: supermemory-status
description: Show Supermemory connection status for Codex. Use when the user asks whether Supermemory is connected, which account or API key is active, memory hook health, or plugin status.
allowed-tools: Bash(node:*)
---

# Supermemory Status

Show whether Supermemory is connected and which credential source is active:

```bash
node ~/.codex/supermemory/status.js
```

## Windows Sandbox

On Windows, if running the command from Codex and sandbox execution is likely to fail for `~/.codex` paths, request escalated shell execution immediately instead of trying the sandbox first. Use a narrow approval reason such as:

> Run Supermemory status from the Codex home directory so it can read the installed credentials.

Use this when the user asks whether memory is active, what Supermemory account is connected, or whether Codex can currently use Supermemory.

Never print the full API key. The script masks credentials; preserve that masking in the response.
