import { existsSync, unlinkSync } from "node:fs";
import { join } from "node:path";
import { homedir } from "node:os";
import { createAuthSession } from "./services/auth.js";
import { openUrl } from "./services/openUrl.js";
import { log } from "./services/logger.js";

const AUTH_ATTEMPTED_FILE = join(homedir(), ".codex", "supermemory", ".auth-attempted");

async function main(): Promise<void> {
  try {
    const session = await createAuthSession();
    await openUrl(session.authUrl);
    await session.callback();
    try {
      if (existsSync(AUTH_ATTEMPTED_FILE)) unlinkSync(AUTH_ATTEMPTED_FILE);
    } catch {}
    log("auth-background: completed");
  } catch (error) {
    log("auth-background: failed", { error: String(error) });
  }
}

main().catch(() => {});