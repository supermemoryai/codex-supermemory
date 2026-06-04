---
name: supermemory-logout
description: Log out of Supermemory in Codex. Use when the user wants to disconnect Supermemory, remove saved credentials, switch accounts, clear auth state, or stop memory from using the current saved API key.
allowed-tools: Bash(node:*)
---

# Supermemory Logout

Remove saved Supermemory credentials for Codex:

```bash
node ~/.codex/supermemory/logout.js
```

Logout creates an intentional disconnected marker so the automatic recall hook will not reopen browser auth on the next prompt. `/supermemory-status` should report disconnected after logout. `/supermemory-login` clears the marker and reconnects.

On Windows, if running the command from Codex, request escalated shell execution immediately instead of trying the sandbox first. The script removes auth files under `~/.codex`. Use a narrow approval reason such as:

> Run Supermemory logout from the Codex home directory so it can remove saved credentials.

If `SUPERMEMORY_CODEX_API_KEY` is set in the parent shell, the script cannot unset it. Tell the user to unset that environment variable or restart Codex if the script reports it is still active.

Never print the full API key.
