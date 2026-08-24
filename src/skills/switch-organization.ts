import { existsSync, unlinkSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { getBrowserCredentialOverrides } from "../config.js";
import {
  CREDENTIALS_FILE,
  requestBrowserCredentials,
  verifyAndSaveCredentials,
  type VerifiedSession,
} from "../services/auth.js";

const SUPERMEMORY_DIR = join(homedir(), ".codex", "supermemory");
const AUTH_ATTEMPTED_FILE = join(SUPERMEMORY_DIR, ".auth-attempted");
const LOGGED_OUT_FILE = join(SUPERMEMORY_DIR, ".logged-out");

function clearMarker(path: string): void {
  try {
    if (existsSync(path)) unlinkSync(path);
  } catch {}
}

function describeOrganization(session: VerifiedSession): string {
  if (session.organizationName && session.organizationId) {
    return `${session.organizationName} (${session.organizationId})`;
  }
  return session.organizationName ?? session.organizationId ?? "unknown";
}

async function main(): Promise<void> {
  const overrides = getBrowserCredentialOverrides();

  console.log("Opening Supermemory to choose an organization...");

  if (overrides.length > 0) {
    console.warn("");
    console.warn("WARNING: Browser credentials are not currently the effective credentials.");
    for (const override of overrides) {
      console.warn(`- ${override.label} takes precedence.`);
    }
    console.warn(
      "Your selection will be verified and saved, but Codex will keep using the overriding key until you remove it and restart Codex.",
    );
  }

  try {
    // Keep the current credential untouched until the candidate key is verified.
    const credentials = await requestBrowserCredentials();
    const session = await verifyAndSaveCredentials(credentials);
    clearMarker(AUTH_ATTEMPTED_FILE);
    clearMarker(LOGGED_OUT_FILE);

    console.log("");
    console.log(`Organization verified: ${describeOrganization(session)}`);
    console.log(`Saved browser credentials to ${CREDENTIALS_FILE}.`);

    if (overrides.length > 0) {
      console.warn(
        "The saved organization is not active yet. Remove every credential override listed above, then restart Codex.",
      );
    } else {
      console.log("Supermemory will now use this organization.");
    }
  } catch (error) {
    const isTimeout = error instanceof Error && error.message === "AUTH_TIMEOUT";
    console.error("");
    console.error(
      isTimeout
        ? "Organization selection timed out or was cancelled."
        : `Organization switch failed: ${error instanceof Error ? error.message : String(error)}`,
    );
    console.error("Your previously saved browser credentials were kept unchanged.");
    process.exit(1);
  }
}

main().catch((error) => {
  console.error(`Fatal: ${error instanceof Error ? error.message : String(error)}`);
  process.exit(1);
});
