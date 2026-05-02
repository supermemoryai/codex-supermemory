import { readFileSync, existsSync, writeFileSync, unlinkSync, mkdirSync } from "node:fs";
import { join, dirname } from "node:path";
import { homedir } from "node:os";
import { isConfigured, CONFIG, reloadApiKey } from "../config.js";
import { SupermemoryClient } from "../services/client.js";
import { getTags } from "../services/tags.js";
import { formatCombinedContext } from "../services/context.js";
import { log } from "../services/logger.js";
import { startAuthFlow, AUTH_BASE_URL } from "../services/auth.js";
import { captureEntries, resolveTranscriptPath } from "../services/capture.js";
import { getSeenFacts, addSeenFacts } from "../services/factCache.js";

const AUTH_ATTEMPTED_FILE = join(homedir(), ".codex", "supermemory", ".auth-attempted");

interface CodexHookPayload {
  session_id?: string;
  prompt?: string;
  input?: string;
  transcript_path?: string | null;
  cwd?: string;
  [key: string]: unknown;
}

// Output shape required by Codex UserPromptSubmitCommandOutputWire.
// Empty context is emitted as a silent exit so Codex doesn't render a
// "hook context:" label with no content.
function exitWithContext(additionalContext: string): never {
  if (additionalContext) {
    process.stdout.write(
      JSON.stringify({
        hookSpecificOutput: {
          hookEventName: "UserPromptSubmit",
          additionalContext,
        },
      })
    );
  }
  process.exit(0);
}

async function main() {
  // Read stdin via fd 0
  let rawInput = "";
  try {
    rawInput = readFileSync(0, "utf-8");
  } catch {
    process.exit(0);
  }

  if (!isConfigured()) {
    const alreadyAttempted = existsSync(AUTH_ATTEMPTED_FILE);

    if (!alreadyAttempted) {
      try {
        mkdirSync(dirname(AUTH_ATTEMPTED_FILE), { recursive: true });
        writeFileSync(AUTH_ATTEMPTED_FILE, new Date().toISOString());
      } catch {}

      try {
        log("recall: no API key, starting browser auth flow");
        await startAuthFlow();
        reloadApiKey();
        try { unlinkSync(AUTH_ATTEMPTED_FILE); } catch {}
        log("recall: auth flow completed");
      } catch (authErr) {
        const isTimeout =
          authErr instanceof Error && authErr.message === "AUTH_TIMEOUT";
        exitWithContext(
          "[SUPERMEMORY] Memory is installed but NOT active — missing API key.\n" +
          (isTimeout
            ? "Authentication timed out. Please complete login in the browser.\n"
            : "Authentication failed.\n") +
          `If the browser did not open, visit: ${AUTH_BASE_URL}\n` +
          "Run /supermemory-login to try again, or set SUPERMEMORY_CODEX_API_KEY manually."
        );
      }
    } else {
      exitWithContext(
        "[SUPERMEMORY] Memory is installed but NOT active — missing API key.\n" +
        "Run /supermemory-login to authenticate, or set SUPERMEMORY_CODEX_API_KEY in your shell profile."
      );
    }
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

  const sessionId = payload.session_id || `codex_${Date.now()}`;
  const cwd = payload.cwd || process.cwd();
  const tags = getTags(cwd);

  log("recall: start", { query: query.slice(0, 100), tags, sessionId });

  // Find transcript path - either from payload or by searching
  const transcriptPath = resolveTranscriptPath(payload.transcript_path, sessionId);
  if (transcriptPath) {
    log("recall: found transcript", { sessionId, transcriptPath });
  }

  const client = new SupermemoryClient();

  // Step 1: Capture any new entries from previous turns BEFORE recall
  await captureEntries("recall", client, sessionId, transcriptPath, tags, {
    requireMinEntries: 2,
    requireMinTurns: CONFIG.autoSaveEveryTurns,
  });

  // Step 2: Now search for relevant memories (including what we just captured)
  // Query both containers: user profile from user container, memories from project container.
  // The profile() API only accepts a single containerTag, so we make parallel calls.
  try {
    const [profileResult, projectSearchResult] = await Promise.all([
      client.getProfileWithSearch(tags.user, query),
      client.searchMemories(query, tags.project),
    ]);

    // Get facts already shown in this session to avoid repeating them
    const seen = getSeenFacts(sessionId);
    const { text, newFacts } = formatCombinedContext(
      profileResult,
      CONFIG.maxMemories,
      CONFIG.maxProfileItems,
      projectSearchResult,
      seen,
    );

    log("recall: done", {
      contextLength: text.length,
      newFactCount: newFacts.length,
      seenCount: seen.size,
    });

    if (newFacts.length > 0) {
      addSeenFacts(sessionId, newFacts);
      exitWithContext(`[SUPERMEMORY CONTEXT]\n${text}\n[END SUPERMEMORY CONTEXT]`);
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
