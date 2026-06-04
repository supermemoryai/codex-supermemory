---
name: supermemory-login
description: Log in to Supermemory. Use when the user needs to authenticate, set up their API key, or when memory features report a missing key.
allowed-tools: Bash(node:*)
---

# Supermemory Login

Authenticate with Supermemory to enable persistent memory across Codex sessions.

## Usage

```bash
node ~/.codex/supermemory/login.js
```

## Windows Sandbox

On Windows, if running the command from Codex, request escalated shell execution immediately instead of trying the sandbox first. The script lives under `~/.codex`, reads/writes auth state there, and may open the browser. Use a narrow approval reason such as:

> Run Supermemory login from the Codex home directory so it can read credentials and open the browser auth flow.

This opens a browser window for authentication. Once complete, the API key is saved automatically and memory features activate immediately.

If the browser does not open, the script prints a URL to visit manually.

Never print the full API key. If the script reports that Supermemory is already authenticated, tell the user memory is active and do not ask them to log in again.
