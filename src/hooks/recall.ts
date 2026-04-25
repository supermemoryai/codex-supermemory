import { readFileSync } from "node:fs";
import { isConfigured, CONFIG } from "../config.js";
import { SupermemoryClient } from "../services/client.js";
import { getTags } from "../services/tags.js";
import { formatContextForPrompt } from "../services/context.js";
import { log } from "../services/logger.js";

interface CodexHookPayload {
  session_id?: string;
  prompt?: string;
  input?: string;
  [key: string]: unknown;
}

// Output shape required by Codex UserPromptSubmitCommandOutputWire.
// The Rust struct uses #[serde(rename_all = "camelCase")] so keys are camelCase.
function exitWithContext(additionalContext: string): never {
  process.stdout.write(
    JSON.stringify({
      hookSpecificOutput: {
        hookEventName: "UserPromptSubmit",
        additionalContext,
      },
    })
  );
  process.exit(0);
}

async function main() {
  // Read stdin
  let rawInput = "";
  try {
    rawInput = readFileSync("/dev/stdin", "utf-8");
  } catch {
    process.exit(0);
  }

  if (!isConfigured()) {
    exitWithContext("");
  }

  let payload: CodexHookPayload = {};
  try {
    payload = JSON.parse(rawInput) as CodexHookPayload;
  } catch {
    exitWithContext("");
  }

  const query = payload.prompt || payload.input || "";
  if (!query.trim()) {
    exitWithContext("");
  }

  const cwd = process.cwd();
  const tags = getTags(cwd);
  log("recall: start", { query: query.slice(0, 100), tags });

  const client = new SupermemoryClient();

  try {
    const [searchResult, profileResult] = await Promise.all([
      client.searchMemories(query, tags.project),
      CONFIG.injectProfile
        ? client.getProfile(tags.user, query)
        : Promise.resolve({ success: false as const, profile: null }),
    ]);

    const context = formatContextForPrompt(
      searchResult,
      profileResult,
      CONFIG.maxMemories,
      CONFIG.maxProfileItems
    );

    log("recall: done", { contextLength: context.length });

    if (context.trim()) {
      exitWithContext(`[SUPERMEMORY CONTEXT]\n${context}\n[END SUPERMEMORY CONTEXT]`);
    } else {
      exitWithContext("");
    }
  } catch (error) {
    log("recall: error", { error: String(error) });
    exitWithContext("");
  }
}

main().catch(() => {
  exitWithContext("");
});
