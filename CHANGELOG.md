# Changelog

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
