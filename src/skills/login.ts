import { unlinkSync, existsSync } from "node:fs";
import { join } from "node:path";
import { homedir } from "node:os";
import { isConfigured } from "../config.js";
import { startAuthFlow, AUTH_BASE_URL, CREDENTIALS_FILE } from "../services/auth.js";

const AUTH_ATTEMPTED_FILE = join(homedir(), ".codex", "supermemory", ".auth-attempted");

async function main(): Promise<void> {
  // Clear the auth-attempted marker so the recall hook will try browser auth again
  try {
    if (existsSync(AUTH_ATTEMPTED_FILE)) unlinkSync(AUTH_ATTEMPTED_FILE);
  } catch {}

  if (isConfigured()) {
    console.log("Already authenticated with Supermemory. Memory is active.");
    console.log(`To re-authenticate, remove ${CREDENTIALS_FILE} and run this again.`);
    return;
  }

  console.log("Opening browser to authenticate with Supermemory...");
  console.log(`If the browser does not open, visit: ${AUTH_BASE_URL}`);

  try {
    await startAuthFlow();
    try {
      if (existsSync(AUTH_ATTEMPTED_FILE)) unlinkSync(AUTH_ATTEMPTED_FILE);
    } catch {}
    console.log("\nAuthenticated successfully! Supermemory is now active.");
  } catch (err) {
    const isTimeout = err instanceof Error && err.message === "AUTH_TIMEOUT";
    if (isTimeout) {
      console.error("\nAuthentication timed out. Please try again.");
    } else {
      console.error("\nAuthentication failed:", err instanceof Error ? err.message : err);
    }
    console.error(`\nAlternatively, set the API key manually:`);
    console.error(`  export SUPERMEMORY_CODEX_API_KEY="sm_..."`);
    console.error(`  Get your key at: https://console.supermemory.ai/keys`);
    process.exit(1);
  }
}

main().catch((err) => {
  console.error("Fatal:", err instanceof Error ? err.message : err);
  process.exit(1);
});
