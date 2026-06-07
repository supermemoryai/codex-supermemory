import { existsSync, mkdirSync, readFileSync, unlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { homedir } from "node:os";
import { CREDENTIALS_FILE } from "../services/auth.js";

const SUPERMEMORY_DIR = join(homedir(), ".codex", "supermemory");
const AUTH_ATTEMPTED_FILE = join(SUPERMEMORY_DIR, ".auth-attempted");
const LOGGED_OUT_FILE = join(SUPERMEMORY_DIR, ".logged-out");
const CONFIG_FILE = join(homedir(), ".codex", "supermemory.json");

function removeFile(path: string): boolean {
  try {
    if (!existsSync(path)) return false;
    unlinkSync(path);
    return true;
  } catch (error) {
    console.error(`Failed to remove ${path}: ${error instanceof Error ? error.message : String(error)}`);
    process.exit(1);
  }
}

function removeConfigApiKey(): boolean {
  try {
    if (!existsSync(CONFIG_FILE)) return false;
    const parsed = JSON.parse(readFileSync(CONFIG_FILE, "utf-8")) as Record<string, unknown>;
    if (!Object.prototype.hasOwnProperty.call(parsed, "apiKey")) return false;
    delete parsed.apiKey;
    writeFileSync(CONFIG_FILE, `${JSON.stringify(parsed, null, 2)}\n`);
    return true;
  } catch (error) {
    console.error(`Failed to update ${CONFIG_FILE}: ${error instanceof Error ? error.message : String(error)}`);
    process.exit(1);
  }
}

function main(): void {
  const removedCredentials = removeFile(CREDENTIALS_FILE);
  const removedAuthMarker = removeFile(AUTH_ATTEMPTED_FILE);
  const removedConfigApiKey = removeConfigApiKey();
  const envApiKeySet = !!process.env.SUPERMEMORY_CODEX_API_KEY;
  mkdirSync(SUPERMEMORY_DIR, { recursive: true });
  writeFileSync(LOGGED_OUT_FILE, new Date().toISOString());

  if (removedCredentials || removedConfigApiKey || removedAuthMarker) {
    console.log("Logged out of Supermemory for Codex.");
  } else {
    console.log("No saved Supermemory login was found.");
  }

  if (removedCredentials) {
    console.log(`Removed credentials file: ${CREDENTIALS_FILE}`);
  }
  if (removedConfigApiKey) {
    console.log(`Removed apiKey from ${CONFIG_FILE}`);
  }

  if (envApiKeySet) {
    console.log("");
    console.log("SUPERMEMORY_CODEX_API_KEY is still set in this shell, so memory may remain active until you unset it or restart Codex.");
  } else {
    console.log("Supermemory memory is inactive until you run /supermemory-login again.");
    console.log("This only logs out this local Codex install. To revoke the account-level Codex integration key, disconnect it from the Supermemory integrations page.");
  }
}

main();
