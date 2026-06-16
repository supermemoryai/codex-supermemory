import { readFileSync, existsSync, writeFileSync, unlinkSync, mkdirSync } from "node:fs";
import { join, dirname } from "node:path";
import { homedir } from "node:os";
import { isConfigured, CONFIG, reloadApiKey, getContainerCatalog, getRecallConfig } from "../config.js";
import { SupermemoryClient } from "../services/client.js";
import { getTags } from "../services/tags.js";
import { formatCombinedContext } from "../services/context.js";
import { log } from "../services/logger.js";
import { startAuthFlow, AUTH_BASE_URL } from "../services/auth.js";
import { captureEntries, resolveTranscriptPath } from "../services/capture.js";
import { getSeenFacts, addSeenFacts } from "../services/factCache.js";
import { getSessionId } from "../services/session.js";

const AUTH_ATTEMPTED_FILE = join(homedir(), ".codex", "supermemory", ".auth-attempted");
const LOGGED_OUT_FILE = join(homedir(), ".codex", "supermemory", ".logged-out");

const DEFAULT_RECALL_DIRECTIVE = `<supermemory-recall>
Before responding, silently decide whether recalling saved memory (past sessions, decisions, conventions, the user's preferences) would materially improve your answer to THIS message. Reason first — don't search reflexively, and don't narrate the decision.

Recall — via the supermemory-search skill — when the message:
- refers to earlier work or decisions ("the auth flow", "like we did", "continue", "the bug from before")
- touches an area where saved conventions, patterns, or preferences likely exist
- is ambiguous in a way past context would resolve

Skip recall when the message is self-contained, trivial, a greeting/meta, fully answerable from the current conversation, or you already recalled the relevant context this session and the topic hasn't shifted.

Cadence is per-message: it's fine to recall on several turns in a row, and fine to never recall in a session. When you do recall, run it before answering and fold the results into your response.
</supermemory-recall>`;

const RECALL_DEBUG_SUFFIX = `<recall-debug>
DEBUG MODE: Begin your reply with exactly one line, then continue normally:
[recall-decision] yes|no — <short reason>
"yes" means you are recalling saved Supermemory memory (via the supermemory-search skill) for THIS message; "no" means you are skipping it.
</recall-debug>`;

interface CodexHookPayload {
  session_id?: string;
  prompt?: string;
  input?: string;
  transcript_path?: string | null;
  cwd?: string;
  [key: string]: unknown;
}

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

  const cwd = payload.cwd || process.cwd();
  const tags = getTags(cwd);
  const sessionId = getSessionId(payload.session_id, tags.project);

  log("recall: start", {
    query: query.slice(0, 100),
    tags,
    sessionId,
    autoRecallEveryPrompt: CONFIG.autoRecallEveryPrompt,
  });

  const transcriptPath = resolveTranscriptPath(payload.transcript_path, sessionId);
  const client = new SupermemoryClient();

  if (CONFIG.captureEveryNTurns > 0) {
    await captureEntries("recall", client, sessionId, transcriptPath, tags, {
      requireMinEntries: 2,
      requireMinTurns: CONFIG.captureEveryNTurns,
    });
  }

  if (!CONFIG.autoRecallEveryPrompt) {
    const { directive } = getRecallConfig(cwd);
    let additionalContext = directive || DEFAULT_RECALL_DIRECTIVE;
    const debugDecision = !!(CONFIG.debug || process.env.SUPERMEMORY_DEBUG);
    if (debugDecision) {
      additionalContext += `\n\n${RECALL_DEBUG_SUFFIX}`;
    }

    const containerCatalog = getContainerCatalog();
    if (containerCatalog) {
      additionalContext += `\n\n[SUPERMEMORY CONTAINERS]\n${containerCatalog}\n[END SUPERMEMORY CONTAINERS]`;
    }

    log("recall: inject directive", {
      custom: !!directive,
      debugDecision,
      additionalContextLength: additionalContext.length,
    });
    exitWithContext(additionalContext);
  }

  try {
    const [profileResult, projectSearchResult] = await Promise.all([
      client.getProfileWithSearch(tags.user, query),
      client.searchMemories(query, tags.project),
    ]);

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
    exitWithContext("");
  }
}

main().catch(() => {
  exitWithContext("");
});
