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

This opens a browser window for authentication. Once complete, the API key is saved automatically and memory features activate immediately.

If the browser does not open, the script prints a URL to visit manually.
