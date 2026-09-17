---
name: supermemory-index
description: Index this codebase into Supermemory. Use when the user asks to index, learn, or memorize the repository architecture, conventions, or how to run it.
---

# Index Codebase

Explore this repository, then save what you learn as several focused memories
through the hosted Supermemory MCP tools. Do not write a script. Do not dump
the whole repo into one memory.

## Explore

Auto-detect the stack from manifests and lockfiles, then read the files that
explain how the project is built, run, and structured. Budget about 20–50 tool
calls. Skip dependency and build directories (`node_modules`, `dist`, `target`,
`vendor`, `.git`, `__pycache__`, build caches).

Detect from:

| Ecosystem | Look for |
| --- | --- |
| JS/TS | `package.json`, `tsconfig.json`, lockfiles |
| Python | `pyproject.toml`, `setup.py`, `requirements.txt` |
| Go | `go.mod` |
| Rust | `Cargo.toml` |
| .NET/C# | `*.csproj`, `*.sln` |
| Java/Kotlin | `pom.xml`, `build.gradle`, `build.gradle.kts` |
| Ruby | `Gemfile` |
| PHP | `composer.json` |
| Swift | `Package.swift` |
| Elixir | `mix.exs` |

Also read:

- README and contributor docs
- CI workflows
- Architecture notes, ADRs, and module boundaries
- Conventions (lint, format, test, codegen)
- The key source files those docs point at

## Save

Use the hosted MCP `add_memory` tool. Codex typically exposes it as
`mcp__supermemory__add_memory`; if that namespaced name is unavailable, call
`add_memory`.

Save several focused memories, not one dump. Typical splits:

- What the project is and how to run it
- Architecture and module layout
- Conventions and review norms
- Important implementation details or gotchas

Each memory should stand on its own so later recall can pull the right slice.

## Confirm

When done, tell the user:

> Codebase indexed — [N] memories saved about [project name]
