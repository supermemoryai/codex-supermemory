import { readFileSync } from "node:fs";
import { log } from "../services/logger.js";

const SHELL_TOOL_NAME = "Bash";
const SEARCH_BASH_RE = /node[\s\S]*search-memory\.js/;
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
    log("recall-approve: error", { error: String(error) });
  }

  process.exit(0);
}

main();
