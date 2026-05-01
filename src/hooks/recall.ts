import { readFileSync, existsSync, writeFileSync, unlinkSync, mkdirSync } from "node:fs";
import { join, dirname } from "node:path";
import { homedir } from "node:os";
import { isConfigured, CONFIG, reloadApiKey } from "../config.js";
import { SupermemoryClient } from "../services/client.js";
import { getTags } from "../services/tags.js";
import { formatCombinedContext } from "../services/context.js";
import { log } from "../services/logger.js";
import { startAuthFlow, AUTH_BASE_URL } from "../services/auth.js";
import {
  parseTranscript,
  getEntriesSince,
  formatTranscript,
  findTranscriptPath,
} from "../services/transcript.js";
import { getLastCapturedIndex, setLastCapturedIndex } from "../services/tracker.js";
import { filterBySignals, groupEntriesIntoTurns } from "../services/signals.js";

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

/**
 * Capture any new entries from the transcript since last capture.
 * This runs BEFORE recall so same-session memories work.
 */
async function captureNewEntries(
  client: SupermemoryClient,
  sessionId: string,
  transcriptPath: string | null,
  tags: { project: string; user: string }
): Promise<void> {
  if (!transcriptPath || !existsSync(transcriptPath)) {
    log("recall: no transcript to capture from", { sessionId, transcriptPath });
    return;
  }

  const entries = parseTranscript(transcriptPath);
  if (entries.length === 0) {
    log("recall: transcript empty", { sessionId });
    return;
  }

  const lastIndex = getLastCapturedIndex(sessionId);
  const newEntries = getEntriesSince(entries, lastIndex);

  // Need at least one complete exchange to capture (user + assistant)
  if (newEntries.length < 2) {
    log("recall: not enough new entries to capture", {
      sessionId,
      newCount: newEntries.length,
      lastIndex,
    });
    return;
  }

  // Only capture every N turns to reduce API calls (configurable)
  // Count complete turns + 1 for the current prompt (which hasn't been responded to yet)
  const turns = groupEntriesIntoTurns(newEntries);
  const effectiveTurnCount = turns.length + 1; // +1 for current user prompt
  if (effectiveTurnCount < CONFIG.autoSaveEveryTurns) {
    log("recall: waiting for more turns before capture", {
      sessionId,
      turnCount: effectiveTurnCount,
      requiredTurns: CONFIG.autoSaveEveryTurns,
      lastIndex,
    });
    return;
  }

  // Filter to only entries with meaningful signals (preferences, decisions, etc.)
  const signalEntries = filterBySignals(newEntries);

  if (signalEntries.length === 0) {
    log("recall: no signal entries to capture", {
      sessionId,
      totalNew: newEntries.length,
      lastIndex,
    });
    // Still update tracker so we don't re-check these entries
    const lastEntry = newEntries[newEntries.length - 1];
    setLastCapturedIndex(sessionId, lastEntry.index);
    return;
  }

  log("recall: capturing signal entries", {
    sessionId,
    signalCount: signalEntries.length,
    totalNew: newEntries.length,
    lastIndex,
  });

  const transcript = formatTranscript(signalEntries);
  const content = `[Session ${sessionId}]\n${transcript}`;

  const metadata = {
    type: "conversation" as const,
    sessionId,
    entryCount: newEntries.length,
    timestamp: new Date().toISOString(),
  };

  // Save to both project and user containers
  // Use customId so all session turns go into the same document
  try {
    await Promise.all([
      client.addMemory(content, tags.project, metadata, { customId: `${sessionId}_project` }),
      client.addMemory(content, tags.user, metadata, { customId: `${sessionId}_user` }),
    ]);

    // Update tracker with the last entry's index
    const lastEntry = newEntries[newEntries.length - 1];
    setLastCapturedIndex(sessionId, lastEntry.index);

    log("recall: captured entries", {
      sessionId,
      count: newEntries.length,
      lastIndex: lastEntry.index,
    });
  } catch (error) {
    log("recall: capture error", { error: String(error) });
    // Don't fail the hook, just continue to recall
  }
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
  let transcriptPath = payload.transcript_path || null;
  if (!transcriptPath && sessionId) {
    transcriptPath = findTranscriptPath(sessionId);
    log("recall: found transcript", { sessionId, transcriptPath });
  }

  const client = new SupermemoryClient();

  // Step 1: Capture any new entries from previous turns BEFORE recall
  await captureNewEntries(client, sessionId, transcriptPath, tags);

  // Step 2: Now search for relevant memories (including what we just captured)
  // Query both containers: user profile from user container, memories from project container.
  // The profile() API only accepts a single containerTag, so we make parallel calls.
  try {
    const [profileResult, projectSearchResult] = await Promise.all([
      client.getProfileWithSearch(tags.user, query),
      client.searchMemories(query, tags.project),
    ]);

    const context = formatCombinedContext(
      profileResult,
      CONFIG.maxMemories,
      CONFIG.maxProfileItems,
      projectSearchResult,
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
