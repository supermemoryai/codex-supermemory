import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { homedir } from "node:os";

const TRACKER_DIR = join(homedir(), ".codex-supermemory", "trackers");
const BILLING_URL = "https://console.supermemory.ai/billing";

// The API answers 402 to profile and search at $0 credits; each client path keeps only the status in its error text.
export function isOutOfCredits(error: string | undefined): boolean {
  return /\(402\)|HTTP 402|^402 /.test(error ?? "");
}

// Recall runs on every prompt, so a per-session marker keeps the refusal to one line instead of a notice per prompt.
export function takeOutOfCreditsNotice(sessionId: string): string | undefined {
  const marker = join(TRACKER_DIR, `${sessionId}.out-of-credits`);
  if (existsSync(marker)) return undefined;
  try {
    mkdirSync(TRACKER_DIR, { recursive: true });
    writeFileSync(marker, new Date().toISOString());
  } catch {}
  return `◪ supermemory · recall paused · You've run out of credits. Top up to continue. ${BILLING_URL}`;
}
