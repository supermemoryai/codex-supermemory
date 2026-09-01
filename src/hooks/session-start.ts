import { readFileSync, existsSync, writeFileSync, mkdirSync } from "node:fs";
import { join, dirname } from "node:path";
import { homedir } from "node:os";
import { isConfigured, CONFIG, PLUGIN_VERSION, reloadApiKey } from "../config.js";
import { HOOK_API_TIMEOUT_MS, SupermemoryClient } from "../services/client.js";
import { getTags } from "../services/tags.js";
import { formatSessionContext } from "../services/context.js";
import { log } from "../services/logger.js";
import { startAuthFlow, AUTH_BASE_URL } from "../services/auth.js";
import { getSeenFacts, addSeenFacts } from "../services/factCache.js";
import { checkNpmUpdate, formatUpdateNotice } from "../services/version-check.js";

const MARK_TIP_FILE = join(homedir(), ".codex", "supermemory", ".mark-tip-shown");
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

function markTip(): string | null {
  try {
    if (existsSync(MARK_TIP_FILE)) return null;
    mkdirSync(dirname(MARK_TIP_FILE), { recursive: true });
    writeFileSync(MARK_TIP_FILE, new Date().toISOString());
    return "◪ is the supermemory mark — whenever you see it (notices or Codex's answers), that information came from supermemory.";
  } catch {
    return null;
  }
}

async function main() {
  let rawInput = "";
  try {
    rawInput = readFileSync(0, "utf-8");
  } catch {
    process.exit(0);
  }

  if (!isConfigured()) {
    try {
      await startAuthFlow(getSessionStartAuthTimeoutMs());
      reloadApiKey();
    } catch {
      exitWithContext(
        "[SUPERMEMORY] Memory is installed but NOT active — missing API key.\n" +
        `Visit: ${AUTH_BASE_URL}\n` +
        "A new Codex task will try browser authentication again, or set SUPERMEMORY_CODEX_API_KEY."
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
    const { text, newFacts } = formatSessionContext(
      {
        success: profileResult.success,
        profile: profileResult.profile,
        searchResults: undefined,
      },
      {
        maxProfileItems: CONFIG.maxProfileItems,
        maxTokens: CONFIG.maxRecallTokens,
        seenFacts: seen,
        projectName: tags.projectName,
        containerTag: tags.canonical,
      },
    );

    if (!profileResult.success) {
      exitWithContext(
        "",
        combineContextParts([
          await updateCheck,
          "◪ supermemory · profile unavailable; continuing without recalled context",
          markTip(),
        ]),
      );
    }

    if (newFacts.length > 0) {
      addSeenFacts(sessionId, newFacts);
      const updateNotice = await updateCheck;
      exitWithContext(text, combineContextParts([
        updateNotice,
        `◪ supermemory · active · ${newFacts.length} ${newFacts.length === 1 ? "memory" : "memories"} loaded for ${tags.projectName}`,
        markTip(),
      ]));
    }

    const storedProfileCount = (profileResult.profile?.static.length ?? 0) +
      (profileResult.profile?.dynamic.length ?? 0);
    const activeMessage = storedProfileCount > 0
      ? `◪ supermemory · active · memory context current for ${tags.projectName}`
      : `◪ supermemory · active · no memories saved for ${tags.projectName} yet`;
    exitWithContext("", combineContextParts([
      await updateCheck,
      activeMessage,
      markTip(),
    ]));
  } catch (error) {
    log("session-start: error", { error: String(error) });
    const message = error instanceof RangeError
      ? `◪ supermemory · invalid recall configuration: ${error.message}`
      : "◪ supermemory · profile unavailable; continuing without recalled context";
    exitWithContext(
      "",
      combineContextParts([
        await updateCheck,
        message,
      ]),
    );
  }
}

main().catch(() => {
  exitWithContext(
    "",
    "◪ supermemory · profile unavailable; continuing without recalled context",
  );
});
