---
name: supermemory-add
description: Add a personal memory for the current project. Use when the user explicitly asks Codex to remember a preference, intention, learning, or personal context rather than shared project knowledge.
allowed-tools: Bash(node:*)
---

# Supermemory Add

Save a personal memory associated with the current project:

```bash
node ~/.codex/supermemory/add-memory.js "MEMORY_CONTENT"
```

Use this for personal preferences, goals, learnings, and explicit “remember this” requests. For architecture, conventions, setup, bug fixes, or decisions that should describe the repository itself, use `/supermemory-save` instead.
