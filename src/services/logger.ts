import { appendFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { CONFIG } from "../config.js";

const LOG_FILE = join(homedir(), ".codex-supermemory.log");

let sessionStarted = false;

function ensureSessionStarted() {
  if (!sessionStarted) {
    sessionStarted = true;
    try {
      appendFileSync(
        LOG_FILE,
        `\n--- Session started: ${new Date().toISOString()} ---\n`
      );
    } catch {
      // ignore log errors
    }
  }
}

export function log(message: string, data?: unknown) {
  if (!CONFIG.debug && !process.env.SUPERMEMORY_DEBUG) return;
  ensureSessionStarted();
  const timestamp = new Date().toISOString();
  const line = data
    ? `[${timestamp}] ${message}: ${JSON.stringify(data)}\n`
    : `[${timestamp}] ${message}\n`;
  try {
    appendFileSync(LOG_FILE, line);
  } catch {
    // ignore log errors
  }
}
