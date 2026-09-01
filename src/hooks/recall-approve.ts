import { readFileSync } from "node:fs";

const TOOL_NAME_RE = /^mcp__supermemory__(.+)$/;
const READ_ONLY_TOOLS = new Set([
  "search_memory",
  "listSpaces",
  "listMemories",
  "listDocuments",
  "getDocument",
  "whoAmI",
  "memory-graph",
  "fetch-graph-data",
]);

interface CodexPreToolPayload {
  tool_name?: string;
  tool_input?: { query?: unknown };
}

function main(): void {
  let input: CodexPreToolPayload;
  try {
    input = JSON.parse(readFileSync(0, "utf-8")) as CodexPreToolPayload;
  } catch {
    return;
  }

  const tool = TOOL_NAME_RE.exec(input.tool_name ?? "")?.[1];
  if (!tool || !READ_ONLY_TOOLS.has(tool)) return;

  const query = typeof input.tool_input?.query === "string"
    ? input.tool_input.query
    : null;

  process.stdout.write(JSON.stringify({
    systemMessage: query
      ? `◪ supermemory · recalling: ${query}`
      : "◪ supermemory · recalling memories",
    hookSpecificOutput: {
      hookEventName: "PreToolUse",
      permissionDecision: "allow",
      permissionDecisionReason:
        "Supermemory recall is read-only memory access.",
      // Codex requires allow decisions to carry an updatedInput object. Pass
      // the original arguments through unchanged so this remains an approval,
      // not a rewrite.
      updatedInput: input.tool_input ?? {},
    },
  }));
}

main();
