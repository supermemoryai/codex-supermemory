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

async function main() {
  // Read stdin
  let rawInput = "";
  try {
    rawInput = readFileSync("/dev/stdin", "utf-8");
  } catch {
    process.exit(0);
  }

  if (!isConfigured()) {
    process.stdout.write(JSON.stringify({ additionalContext: "" }));
    process.exit(0);
  }

  let payload: CodexHookPayload = {};
  try {
    payload = JSON.parse(rawInput) as CodexHookPayload;
  } catch {
    process.stdout.write(JSON.stringify({ additionalContext: "" }));
    process.exit(0);
  }

  const query = payload.prompt || payload.input || "";
  if (!query.trim()) {
    process.stdout.write(JSON.stringify({ additionalContext: "" }));
    process.exit(0);
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
      process.stdout.write(
        JSON.stringify({
          additionalContext: `[SUPERMEMORY CONTEXT]\n${context}\n[END SUPERMEMORY CONTEXT]`,
        })
      );
    } else {
      process.stdout.write(JSON.stringify({ additionalContext: "" }));
    }
  } catch (error) {
    log("recall: error", { error: String(error) });
    process.stdout.write(JSON.stringify({ additionalContext: "" }));
  }

  process.exit(0);
}

main().catch(() => {
  process.stdout.write(JSON.stringify({ additionalContext: "" }));
  process.exit(0);
});
