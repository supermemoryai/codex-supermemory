import { readFileSync, existsSync, writeFileSync, unlinkSync, mkdirSync } from "node:fs";
import { join, dirname } from "node:path";
import { homedir } from "node:os";
import { isConfigured, CONFIG, reloadApiKey } from "../config.js";
import { SupermemoryClient } from "../services/client.js";
import { getTags } from "../services/tags.js";
import { formatContextForPrompt } from "../services/context.js";
import { log } from "../services/logger.js";
import { startAuthFlow, AUTH_BASE_URL } from "../services/auth.js";
import {
  captureConversationDelta,
  shouldCheckpointPrompt,
} from "../services/conversation-capture.js";

const AUTH_ATTEMPTED_FILE = join(homedir(), ".codex", "supermemory", ".auth-attempted");

interface CodexHookPayload {
  session_id?: string;
  turn_id?: string;
  transcript_path?: string | null;
  cwd?: string;
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
  // Read stdin via fd 0 — works with both shell pipes and spawnSync piped input.
  // readFileSync("/dev/stdin") fails when stdin is a pipe (not a tty).
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

  const cwd = process.cwd();
  const tags = getTags(cwd);
  log("recall: start", { query: query.slice(0, 100), tags });

  const client = new SupermemoryClient();

  const checkpointPromise =
    payload.session_id &&
    shouldCheckpointPrompt(payload.session_id, CONFIG.autoSaveEveryTurns)
      ? captureConversationDelta(payload, { source: "user-prompt" }).catch((error) => {
          log("recall: checkpoint error", { error: String(error) });
        })
      : Promise.resolve();

  try {
    const [searchResult, profileResult] = await Promise.all([
      client.searchMemories(query, tags.project),
      CONFIG.injectProfile
        ? client.getProfile(tags.user, query)
        : Promise.resolve({ success: false as const, profile: null }),
      checkpointPromise,
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
