# Changelog

## Unreleased

- Skip Supermemory profile, recall, and capture for Codex subagents, internal helper
  sessions, and `codex exec` runs by default. Opt back in with `captureSubagents` /
  `captureHeadless` or `SUPERMEMORY_CAPTURE_SUBAGENTS` / `SUPERMEMORY_CAPTURE_HEADLESS`.
- Treat Conductor and Vibe Kanban exec runs as interactive; `captureOrchestrated: false`
  skips them. Resumed exec sessions are captured.
- Send a one-line marker instead of a 200+ character opening prompt captured for the same
  container in the last 24 hours (`dedupeOpeningPrompt`), and reuse the last successful
  recall for an exact query within 10 minutes (`dedupeRecallQueries`).

## 1.0.20

- Use the official Supermemory 5.0.1 SDK for hosted capture, profile, search, and
  connectivity checks; rebuild standalone hooks and status with the SDK included.
- Preserve existing namespace strings, configuration, credentials, session IDs,
  metadata, cursors, recall budgets, fan-out, and MCP routing/approvals.
- Retain an exact-pinned SDK4 compatibility path for older custom servers and
  legacy-only ancillary operations. Support explicit `v5`/`legacy` selection
  without failed-request fallback or hosted rerouting.
- Validate document acceptance before committing a capture cursor and preserve
  POST append/diff semantics for subsequent session deltas.
- Include SDK licenses with both npm artifacts and installed standalone scripts.
- Respect a PR-supplied release version instead of bumping it a second time;
  ordinary main changes still trigger the publisher's next patch bump.
