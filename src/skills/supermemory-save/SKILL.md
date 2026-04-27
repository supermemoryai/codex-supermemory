---
name: supermemory-save
description: Save important project knowledge to memory. Use when user wants to preserve architectural decisions, significant bug fixes, design patterns, or important implementation details for future reference.
allowed-tools: Bash(node:*)
---

# Super Save

Save important project knowledge based on what the user wants to preserve.

## Step 1: Understand User Request

Analyze what the user is asking to save from the conversation.

## Step 2: Format Content

Format the content to capture the key context:

```
[SAVE:<date>]

<User> wanted to <goal/problem>.

The approach taken was <approach/solution>.

Decision: <decision made>.

<key details, files if relevant>

[/SAVE]
```

Example:
```
[SAVE:2025-06-15]

User wanted to create a skill for saving project knowledge.

The approach taken was using a separate container tag for shared team knowledge.

Decision: Keep it simple - no transcript fetching, just save what user asks for.

Files: src/save-memory.ts, src/skills/super-save/SKILL.md

[/SAVE]
```

Keep it natural. Capture the conversation flow.

## Step 3: Save

```bash
node ~/.codex/supermemory/save-memory.js "FORMATTED_CONTENT"
```
