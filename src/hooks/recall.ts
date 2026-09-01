import { readFileSync, existsSync } from "node:fs";
import { join } from "node:path";
import { homedir } from "node:os";
import { isConfigured, CONFIG, getContainerCatalog } from "../config.js";
import { getTags } from "../services/tags.js";
import { formatCombinedContext } from "../services/context.js";
import { log } from "../services/logger.js";
import { getSeenFacts, addSeenFacts } from "../services/factCache.js";
import { getSessionId } from "../services/session.js";
import { getHookProfileWithSearchMany } from "../services/hookRecallClient.js";
import { prepareRecallQuery, shouldRecallPrompt } from "../services/recallPolicy.js";

const LOGGED_OUT_FILE = join(homedir(), ".codex", "supermemory", ".logged-out");

interface CodexHookPayload {
  session_id?: string;
  prompt?: string;
  input?: string;
  transcript_path?: string | null;
  cwd?: string;
  [key: string]: unknown;
}

function exitWithContext(additionalContext: string, systemMessage?: string): never {
  if (additionalContext || systemMessage) {
    process.stdout.write(
      JSON.stringify({
        ...(systemMessage ? { systemMessage } : {}),
        ...(additionalContext
          ? {
              hookSpecificOutput: {
                hookEventName: "UserPromptSubmit",
                additionalContext,
              },
            }
          : {}),
      })
    );
  }
  process.exit(0);
}

async function main() {
  let rawInput = "";
  try {
    rawInput = readFileSync(0, "utf-8");
  } catch {
    process.exit(0);
  }

  if (!isConfigured()) {
    if (existsSync(LOGGED_OUT_FILE)) {
      log("recall: logged out marker present, skipping browser auth");
      exitWithContext("");
    }

    // UserPromptSubmit has a 5s backstop and must never launch the interactive
    // browser flow. SessionStart and /supermemory-login own authentication.
    exitWithContext(
      "[SUPERMEMORY] Memory is installed but NOT active — missing API key.\n" +
      "Run /supermemory-login to authenticate, or set SUPERMEMORY_CODEX_API_KEY in your shell profile."
    );
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

  const cwd = payload.cwd || process.cwd();
  const tags = getTags(cwd);
  const sessionId = getSessionId(payload.session_id, tags.project);

  log("recall: start", {
    query: query.slice(0, 100),
    tags,
    sessionId,
    recallMode: CONFIG.recallMode,
  });

  if (CONFIG.recallMode === "off") {
    exitWithContext("");
  }

  if (CONFIG.recallMode === "advisory") {
    exitWithContext(CONFIG.recallDirective);
  }

  if (!shouldRecallPrompt(query)) exitWithContext("");

  try {
    const profileResult = await getHookProfileWithSearchMany(
      tags.allReads,
      prepareRecallQuery(query),
    );

    if (!profileResult.success) {
      exitWithContext("", "◪ supermemory · recall unavailable; continuing without recalled context");
    }

    const seen = getSeenFacts(sessionId);
    const { text, newFacts } = formatCombinedContext(
      profileResult,
      CONFIG.maxMemories,
      CONFIG.maxProfileItems,
      seen,
    );

    log("recall: done", {
      contextLength: text.length,
      newFactCount: newFacts.length,
      seenCount: seen.size,
    });

    const containerCatalog = getContainerCatalog();

    if (newFacts.length > 0) {
      addSeenFacts(sessionId, newFacts);
      let additionalContext = `[SUPERMEMORY CONTEXT]\n${text}\n[END SUPERMEMORY CONTEXT]`;

      if (containerCatalog) {
        additionalContext += `\n\n[SUPERMEMORY CONTAINERS]\n${containerCatalog}\n[END SUPERMEMORY CONTAINERS]`;
      }

      log("recall: emit context", {
        additionalContextLength: additionalContext.length,
      });
      exitWithContext(additionalContext);
    } else if (containerCatalog) {
      const additionalContext = `[SUPERMEMORY CONTAINERS]\n${containerCatalog}\n[END SUPERMEMORY CONTAINERS]`;
      log("recall: emit container catalog only", {
        additionalContextLength: additionalContext.length,
      });
      exitWithContext(additionalContext);
    } else {
      exitWithContext("");
    }
  } catch (error) {
    log("recall: error", { error: String(error) });
    exitWithContext("", "◪ supermemory · recall unavailable; continuing without recalled context");
  }
}

main().catch(() => {
  exitWithContext("");
});
