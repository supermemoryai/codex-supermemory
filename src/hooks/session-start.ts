import { readFileSync, existsSync, writeFileSync, unlinkSync, mkdirSync } from "node:fs";
import { join, dirname } from "node:path";
import { homedir } from "node:os";
import { isConfigured, CONFIG, PLUGIN_VERSION, reloadApiKey } from "../config.js";
import { SupermemoryClient } from "../services/client.js";
import { getTags } from "../services/tags.js";
import { formatCombinedContext } from "../services/context.js";
import { log } from "../services/logger.js";
import { startAuthFlow } from "../services/auth.js";
import { getSeenFacts, addSeenFacts } from "../services/factCache.js";
import { checkNpmUpdate, formatUpdateNotice } from "../services/version-check.js";

const AUTH_ATTEMPTED_FILE = join(homedir(), ".codex", "supermemory", ".auth-attempted");
const LOGGED_OUT_FILE = join(homedir(), ".codex", "supermemory", ".logged-out");
const UPDATE_COMMAND = "npx codex-supermemory@latest install";

interface CodexHookPayload {
  session_id?: string;
  cwd?: string;
  [key: string]: unknown;
}

function exitWithContext(additionalContext: string): never {
  if (additionalContext) {
    process.stdout.write(
      JSON.stringify({
        hookSpecificOutput: {
          hookEventName: "SessionStart",
          additionalContext,
        },
      })
    );
  }
  process.exit(0);
}

function combineContextParts(parts: Array<string | null | undefined>): string {
  return parts.map((part) => part?.trim()).filter(Boolean).join("\n\n");
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
      log("session-start: logged out marker present, skipping browser auth");
      exitWithContext("");
    }

    const alreadyAttempted = existsSync(AUTH_ATTEMPTED_FILE);
    if (!alreadyAttempted) {
      try {
        mkdirSync(dirname(AUTH_ATTEMPTED_FILE), { recursive: true });
        writeFileSync(AUTH_ATTEMPTED_FILE, new Date().toISOString());
      } catch {}

      try {
        await startAuthFlow();
        reloadApiKey();
        try { unlinkSync(AUTH_ATTEMPTED_FILE); } catch {}
      } catch {
        exitWithContext(
          "[SUPERMEMORY] Memory is installed but NOT active — missing API key.\n" +
          "Run /supermemory-login to authenticate."
        );
      }
    } else {
      exitWithContext(
        "[SUPERMEMORY] Memory is installed but NOT active — missing API key.\n" +
        "Run /supermemory-login to authenticate."
      );
    }
  }

  let payload: CodexHookPayload = {};
  try {
    payload = JSON.parse(rawInput) as CodexHookPayload;
  } catch {
    exitWithContext("");
  }

  const sessionId = payload.session_id || `codex_${Date.now()}`;
  const cwd = payload.cwd || process.cwd();
  const tags = getTags(cwd);
  const client = new SupermemoryClient();
  const updateCheck = checkNpmUpdate("codex-supermemory", PLUGIN_VERSION, UPDATE_COMMAND)
    .then((info) => (info ? formatUpdateNotice(info) : null));

  log("session-start: begin", { sessionId, tags });

  try {
    const profileResult = await client.getProfileMany(tags.allReads);
    const seen = getSeenFacts(sessionId);
    const { text, newFacts } = formatCombinedContext(
      {
        success: profileResult.success,
        profile: profileResult.profile,
        searchResults: undefined,
      },
      0,
      CONFIG.maxProfileItems,
      seen,
    );

    if (newFacts.length > 0) {
      addSeenFacts(sessionId, newFacts);
      const updateNotice = await updateCheck;
      exitWithContext(combineContextParts([
        `[SUPERMEMORY CONTEXT]\n${text}\n[END SUPERMEMORY CONTEXT]`,
        updateNotice,
      ]));
    }

    exitWithContext(await updateCheck ?? "");
  } catch (error) {
    log("session-start: error", { error: String(error) });
    exitWithContext(await updateCheck ?? "");
  }
}

main().catch(() => {
  exitWithContext("");
});
