import { readFileSync } from "node:fs";
import { isConfigured, CONFIG } from "../config.js";
import { getTags } from "../services/tags.js";
import { log } from "../services/logger.js";
import { getSeenFacts, addSeenFacts, factKey } from "../services/factCache.js";
import { getSessionId } from "../services/session.js";
import { getHookProfileWithSearchMany } from "../services/hookRecallClient.js";
import { prepareRecallQuery, shouldRecallPrompt } from "../services/recallPolicy.js";

const MAX_RESULT_CHARS = 300;

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

interface RecallItem {
  memory: string;
  title?: string;
  filepath?: string;
}

function formatRecall(items: RecallItem[], containerTag: string): string {
  const lines = items.map((item) => {
    const text = item.memory.replace(/\s+/g, " ").slice(0, MAX_RESULT_CHARS);
    const title = item.title?.trim();
    const prefix = title && !text.startsWith(title) ? `${title} — ` : "";
    const filepath = item.filepath ? ` (${item.filepath})` : "";
    return `- ◪ ${prefix}${text}${filepath}`;
  });

  return `<supermemory-recall>
◪ Recalled from supermemory for this prompt (relevance-ranked):
${lines.join("\n")}

When one of these shapes your answer, credit it naturally with the ◪ prefix (e.g. "◪ earlier you decided X"); if you name the source, say "from supermemory" — never "from memory". For deeper history, call the supermemory search_memory tool (containerTag: "${containerTag}").
</supermemory-recall>`;
}

async function main() {
  let rawInput = "";
  try {
    rawInput = readFileSync(0, "utf-8");
  } catch {
    process.exit(0);
  }

  if (!isConfigured()) {
    // UserPromptSubmit has a 5s backstop and must never launch browser auth.
    // SessionStart owns authentication.
    exitWithContext(
      "[SUPERMEMORY] Memory is installed but NOT active — missing API key.\n" +
      "Start a new Codex task to authenticate, or set SUPERMEMORY_CODEX_API_KEY in your shell profile."
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
    const matches = profileResult.searchResults?.results ?? [];
    const fresh = matches
      .filter((item) => !seen.has(factKey(item.memory)))
      .slice(0, Math.min(CONFIG.maxMemories, 5));
    const repeats = matches.length - fresh.length;

    log("recall: done", {
      matchCount: matches.length,
      freshCount: fresh.length,
      seenCount: seen.size,
    });

    if (fresh.length > 0) {
      addSeenFacts(sessionId, fresh.map((item) => item.memory));
      const additionalContext = formatRecall(fresh, tags.canonical);
      const tokens = Math.round(additionalContext.length / 4);
      const label = repeats > 0
        ? `recalled ${fresh.length} new (${tokens} tok) · ${repeats} already in context`
        : `recalled ${fresh.length} ${fresh.length === 1 ? "memory" : "memories"} (${tokens} tok)`;
      log("recall: emit context", {
        additionalContextLength: additionalContext.length,
      });
      exitWithContext(additionalContext, `◪ supermemory · ${label}`);
    }

    exitWithContext("");
  } catch (error) {
    log("recall: error", { error: String(error) });
    exitWithContext("", "◪ supermemory · recall unavailable; continuing without recalled context");
  }
}

main().catch(() => {
  exitWithContext("");
});
