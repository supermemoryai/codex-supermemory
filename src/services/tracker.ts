import { existsSync, readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { homedir } from "node:os";

const TRACKER_DIR = join(homedir(), ".codex-supermemory", "trackers");

function ensureTrackerDir(): void {
  if (!existsSync(TRACKER_DIR)) {
    mkdirSync(TRACKER_DIR, { recursive: true });
  }
}

export function getLastCapturedIndex(sessionId: string): number | null {
  ensureTrackerDir();
  const trackerFile = join(TRACKER_DIR, `${sessionId}.txt`);
  if (existsSync(trackerFile)) {
    const content = readFileSync(trackerFile, "utf-8").trim();
    const num = parseInt(content, 10);
    return isNaN(num) ? null : num;
  }
  return null;
}

export function setLastCapturedIndex(sessionId: string, index: number): void {
  ensureTrackerDir();
  const trackerFile = join(TRACKER_DIR, `${sessionId}.txt`);
  writeFileSync(trackerFile, String(index));
}
