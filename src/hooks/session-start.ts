import { readFileSync, existsSync, writeFileSync, mkdirSync, statSync } from "node:fs";
import { join, dirname } from "node:path";
import { homedir } from "node:os";
import { spawn } from "node:child_process";
import { isConfigured, CONFIG, PLUGIN_VERSION } from "../config.js";
import { SupermemoryClient } from "../services/client.js";
import { getTags } from "../services/tags.js";
import { formatCombinedContext } from "../services/context.js";
import { log } from "../services/logger.js";
import { getSeenFacts, addSeenFacts } from "../services/factCache.js";
import { checkNpmUpdate, formatUpdateNotice } from "../services/version-check.js";

const AUTH_ATTEMPTED_FILE = join(homedir(), ".codex", "supermemory", ".auth-attempted");
const AUTH_RETRY_MS = 10 * 60_000;
const UPDATE_COMMAND = "npx codex-supermemory@latest install";

function hasRecentAuthAttempt(): boolean {
  try {
    return Date.now() - statSync(AUTH_ATTEMPTED_FILE).mtimeMs < AUTH_RETRY_MS;
  } catch {
    return false;
  }
}

function startAuthBackground(): void {
  const hookDir = dirname(process.argv[1] || "");
  const script = join(hookDir, "auth-background.js");
  const child = spawn(process.execPath, [script], {
    detached: true,
    stdio: "ignore",
    windowsHide: true,
  });
  child.unref();
}

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
    if (!hasRecentAuthAttempt()) {
      try {
        mkdirSync(dirname(AUTH_ATTEMPTED_FILE), { recursive: true });
        writeFileSync(AUTH_ATTEMPTED_FILE, new Date().toISOString());
      } catch {}
      startAuthBackground();
      exitWithContext(
        "[SUPERMEMORY] Memory is installed but not connected. I opened the login page in your browser. " +
        "Complete login there, then continue in Codex. You can also run /supermemory-login manually."
      );
    }

    exitWithContext(
      "[SUPERMEMORY] Memory is installed but not connected. A login page was opened recently. " +
      "Complete login there, or run /supermemory-login to authenticate."
    );
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
    const profileResult = await client.getProfile(tags.user);
    const seen = getSeenFacts(sessionId);
    const { text, newFacts } = formatCombinedContext(
      {
        success: profileResult.success,
        profile: profileResult.profile,
        searchResults: undefined,
      },
      0,
      CONFIG.maxProfileItems,
      undefined,
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
