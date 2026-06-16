import { readFileSync } from "node:fs";
import { log } from "../services/logger.js";

// ---------------------------------------------------------------------------
// Auto-approve reasoned recall (PreToolUse).
//
// Reasoned recall is decided by the model, but it runs through the
// supermemory-search skill — a shell (Bash) tool call, which would normally
// trigger a permission prompt. The capture/flush path runs silently; recall
// should feel the same.
//
// This PreToolUse hook returns `permissionDecision: "allow"` ONLY for a clean
// `node … search-memory.js` invocation. Every other command — and any search
// command laced with shell chaining/redirection — falls through to Codex's
// normal permission flow untouched (we emit nothing). We never deny: denying is
// what would break a user's legitimate command, so on anything unexpected we
// stay out of the way.
//
// The hook is registered with the "Bash" matcher, so Codex only invokes it for
// shell calls; we re-assert tool_name === "Bash" here as defense-in-depth, and
// the command checks below are the real security gate.
// ---------------------------------------------------------------------------

// Codex's canonical shell tool name (and the registered PreToolUse matcher).
const SHELL_TOOL_NAME = "Bash";

// Matches a Bash command that actually *runs* the search script (a `node`
// invocation ahead of the script), not e.g. `rm search-memory.js`.
const SEARCH_BASH_RE = /node[\s\S]*search-memory\.js/;
// Refuse to auto-approve if the command chains/redirects to anything else, so a
// laced command like `node …search-memory.js; rm -rf ~` still prompts.
const SHELL_OPS = /[;&|`>]|\$\(/;

interface CodexPreToolUsePayload {
  tool_name?: string;
  tool_input?: { command?: unknown } | null;
  [key: string]: unknown;
}

function isSupermemorySearch(
  toolName: string | undefined,
  toolInput: CodexPreToolUsePayload["tool_input"],
): boolean {
  if (toolName !== SHELL_TOOL_NAME) return false;
  const command = String(toolInput?.command ?? "");
  if (!command) return false;
  return SEARCH_BASH_RE.test(command) && !SHELL_OPS.test(command);
}

function main(): void {
  let rawInput = "";
  try {
    rawInput = readFileSync(0, "utf-8");
  } catch {
    // No stdin — nothing to approve. Let Codex's normal flow proceed.
    process.exit(0);
  }

  let payload: CodexPreToolUsePayload = {};
  try {
    payload = JSON.parse(rawInput) as CodexPreToolUsePayload;
  } catch {
    process.exit(0);
  }

  try {
    if (isSupermemorySearch(payload.tool_name, payload.tool_input)) {
      log("recall-approve: auto-approving search", { toolName: payload.tool_name });
      process.stdout.write(
        JSON.stringify({
          hookSpecificOutput: {
            hookEventName: "PreToolUse",
            permissionDecision: "allow",
            permissionDecisionReason:
              "Supermemory reasoned recall runs automatically (read-only memory search).",
          },
        })
      );
      process.exit(0);
    }
  } catch (error) {
    // Fail open — never block a tool call because our approve hook errored.
    log("recall-approve: error", { error: String(error) });
  }

  // Not our search (or an error above): stay out of Codex's permission flow.
  process.exit(0);
}

main();
