---
name: supermemory-switch-organization
description: Change which Supermemory organization (org) Codex uses. Use when the user asks to list, choose, change, or switch the organization or workspace connected to Supermemory.
allowed-tools: Bash(node:*)
---

# Switch Supermemory Organization

Open Supermemory's browser authorization page, let the user choose an organization,
verify the resulting credential, and activate it for Codex:

```bash
node ~/.codex/supermemory/switch-organization.js
```

## Windows Sandbox

On Windows, if running the command from Codex, request escalated shell execution
immediately instead of trying the sandbox first. The script lives under `~/.codex`,
updates credentials there, and opens the browser. Use a narrow approval reason such as:

> Open Supermemory organization selection and update this Codex installation's saved credential.

Never print the full API key. Report the organization name printed after verification.
If the script warns that an environment variable or legacy config key overrides browser
credentials, explain that the selected organization is saved but will not become active
until every listed override is removed and Codex is restarted.

If selection is cancelled, times out, or fails verification, tell the user that the
previously saved browser credential remains unchanged.
