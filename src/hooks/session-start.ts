import { readFileSync, existsSync, writeFileSync, unlinkSync, mkdirSync } from "node:fs";
import { join, dirname } from "node:path";
import { homedir } from "node:os";
import { isConfigured, CONFIG, PLUGIN_VERSION, reloadApiKey } from "../config.js";
import { HOOK_API_TIMEOUT_MS, SupermemoryClient } from "../services/client.js";
import { getTags } from "../services/tags.js";
import { formatCombinedContext } from "../services/context.js";
import { log } from "../services/logger.js";
import { startAuthFlow, AUTH_BASE_URL } from "../services/auth.js";
import { getSeenFacts, addSeenFacts } from "../services/factCache.js";
import { checkNpmUpdate, formatUpdateNotice } from "../services/version-check.js";

const AUTH_ATTEMPTED_FILE = join(homedir(), ".codex", "supermemory", ".auth-attempted");
const LOGGED_OUT_FILE = join(homedir(), ".codex", "supermemory", ".logged-out");
const UPDATE_COMMAND = "npx codex-supermemory@latest install";
const SESSION_START_HOOK_TIMEOUT_MS = 30_000;
const SESSION_START_AUTH_TIMEOUT_MS = 25_000;

function getSessionStartAuthTimeoutMs(): number {
  const configured = Number(process.env.SUPERMEMORY_AUTH_TIMEOUT);
  const requested = Number.isFinite(configured) && configured > 0
    ? configured
    : SESSION_START_AUTH_TIMEOUT_MS;
  // Leave room for the hard-capped profile/update requests and hook teardown.
  return Math.min(requested, SESSION_START_HOOK_TIMEOUT_MS - HOOK_API_TIMEOUT_MS - 2_000);
}

interface CodexHookPayload {
  session_id?: string;
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
                hookEventName: "SessionStart",
                additionalContext,
              },
            }
          : {}),
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
        await startAuthFlow(getSessionStartAuthTimeoutMs());
        reloadApiKey();
        try { unlinkSync(AUTH_ATTEMPTED_FILE); } catch {}
      } catch {
        exitWithContext(
          "[SUPERMEMORY] Memory is installed but NOT active — missing API key.\n" +
          `Visit: ${AUTH_BASE_URL}\n` +
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
    const profileResult = await client.getProfileMany(
      tags.allReads,
      undefined,
      { timeoutMs: HOOK_API_TIMEOUT_MS },
    );
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

    if (!profileResult.success) {
      exitWithContext(
        await updateCheck ?? "",
        "◪ supermemory · profile unavailable; continuing without recalled context",
      );
    }

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
    exitWithContext(
      await updateCheck ?? "",
      "◪ supermemory · profile unavailable; continuing without recalled context",
    );
  }
}

main().catch(() => {
  exitWithContext(
    "",
    "◪ supermemory · profile unavailable; continuing without recalled context",
  );
});
