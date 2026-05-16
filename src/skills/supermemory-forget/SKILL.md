---
name: supermemory-forget
description: Remove outdated or incorrect information from memory. Use when user says something is no longer true, wants to delete a memory, or information has changed.
allowed-tools: Bash(node:*)
---

# Forget

Remove outdated or incorrect information from Supermemory.

## When to Use

- User says something is no longer true or has changed
- User explicitly asks to forget or delete a memory
- Information has become outdated or incorrect

## How to Forget

Describe the content to forget — the system will find and remove matching memories:

```bash
node ~/.codex/supermemory/forget-memory.js "DESCRIPTION_OF_WHAT_TO_FORGET"
```

To forget from a specific custom container:

```bash
node ~/.codex/supermemory/forget-memory.js --container <tag> "DESCRIPTION_OF_WHAT_TO_FORGET"
```

## Examples

- User says "I no longer use React, I switched to Vue":

  ```bash
  node ~/.codex/supermemory/forget-memory.js "user prefers React for frontend development"
  ```

- User says "forget that API endpoint, it changed":

  ```bash
  node ~/.codex/supermemory/forget-memory.js "API endpoint for user authentication"
  ```

## After Forgetting

Confirm to the user that the memory has been removed. If they mentioned new information to replace it, use the supermemory-save skill to save the updated information.
