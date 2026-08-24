import { unlinkSync, existsSync } from "node:fs";
import { join } from "node:path";
import { homedir } from "node:os";
import { isConfigured } from "../config.js";
import { startAuthFlow, CREDENTIALS_FILE } from "../services/auth.js";

const AUTH_ATTEMPTED_FILE = join(homedir(), ".codex", "supermemory", ".auth-attempted");
const LOGGED_OUT_FILE = join(homedir(), ".codex", "supermemory", ".logged-out");

async function main(): Promise<void> {
  try {
    if (existsSync(LOGGED_OUT_FILE)) unlinkSync(LOGGED_OUT_FILE);
  } catch {}

  if (isConfigured()) {
    console.log("Already authenticated with Supermemory. Memory is active.");
    console.log(`To re-authenticate, remove ${CREDENTIALS_FILE} and run this again.`);
    process.exit(0);
  }

  // Clear the auth-attempted marker so the recall hook will try browser auth again.
  try {
    if (existsSync(AUTH_ATTEMPTED_FILE)) unlinkSync(AUTH_ATTEMPTED_FILE);
  } catch {}

  console.log("Opening browser to authenticate with Supermemory...");

  try {
    await startAuthFlow();
    try {
      if (existsSync(AUTH_ATTEMPTED_FILE)) unlinkSync(AUTH_ATTEMPTED_FILE);
    } catch {}
    console.log("\nAuthenticated successfully! Supermemory is now active.");
    process.exit(0);
  } catch (err) {
    const isTimeout = err instanceof Error && err.message === "AUTH_TIMEOUT";
    if (isTimeout) {
      console.error("\nAuthentication timed out. Please try again.");
    } else {
      console.error("\nAuthentication failed:", err instanceof Error ? err.message : err);
    }
    console.error(`\nAlternatively, set the API key manually:`);
    console.error(`  export SUPERMEMORY_CODEX_API_KEY="sm_..."`);
    console.error(`  Get your key at: https://app.supermemory.ai/?view=integrations`);
    process.exit(1);
  }
}

main().catch((err) => {
  console.error("Fatal:", err instanceof Error ? err.message : err);
  process.exit(1);
});
