---
name: supermemory-search
description: Search your coding memory. Use when user asks about past work, previous sessions, how something was implemented, what they worked on before, or wants to recall information from earlier sessions.
allowed-tools: Bash(node:*)
---

# Super Search

Search Supermemory for past coding sessions, decisions, and saved information.

## How to Search

Run the search script with the user's query and optional scope flag:

```bash
node ~/.codex/supermemory/search-memory.js [--user|--project|--both] "USER_QUERY_HERE"
```

### Scope Flags

- `--both` (default): Search both personal and project memories in parallel
- `--user`: Search personal/user memories across sessions
- `--project`: Search project-specific memories

### Options

- `--no-profile`: Skip fetching the user profile summary (included by default)

## Examples

- User asks "what did I work on yesterday":

  ```bash
  node ~/.codex/supermemory/search-memory.js "work yesterday recent activity"
  ```

- User asks "how did we implement auth" (project-specific):

  ```bash
  node ~/.codex/supermemory/search-memory.js --project "authentication implementation"
  ```

- User asks "what are my coding preferences":
  ```bash
  node ~/.codex/supermemory/search-memory.js --user "coding preferences style"
  ```

## Present Results

The script outputs formatted memory results with relevance information. Present them clearly to the user and offer to search again with different terms if needed.
