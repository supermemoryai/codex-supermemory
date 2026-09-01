import {
  closeSync,
  existsSync,
  mkdirSync,
  openSync,
  readFileSync,
  renameSync,
  statSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { join } from "node:path";
import { homedir } from "node:os";

const TRACKER_DIR = join(homedir(), ".codex-supermemory", "trackers");
const LOCK_RETRY_MS = 5;
const LOCK_ATTEMPTS = 100;
const STALE_LOCK_MS = 60_000;
const WAIT_ARRAY = new Int32Array(new SharedArrayBuffer(4));
const CAPTURE_LOCK_RETRY_MS = 20;
const CAPTURE_LOCK_WAIT_MS = 25_000;
// Background capture hooks are capped at 30s by Codex. Keep the absolute stale
// age beyond that lifetime so a healthy hook cannot have its lock stolen.
const CAPTURE_LOCK_STALE_MS = 35_000;

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
  const lockFile = `${trackerFile}.lock`;

  for (let attempt = 0; attempt < LOCK_ATTEMPTS; attempt++) {
    let lockFd: number | null = null;
    try {
      lockFd = openSync(lockFile, "wx");
      const current = getLastCapturedIndex(sessionId);
      if (current !== null && current >= index) return;

      const tempFile = `${trackerFile}.${process.pid}.${Date.now()}.tmp`;
      writeFileSync(tempFile, String(index));
      renameSync(tempFile, trackerFile);
      return;
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code;
      if (code !== "EEXIST") throw error;

      // A crashed background hook must not leave the tracker locked forever.
      try {
        if (Date.now() - statSync(lockFile).mtimeMs > STALE_LOCK_MS) {
          unlinkSync(lockFile);
          continue;
        }
      } catch {}

      Atomics.wait(WAIT_ARRAY, 0, 0, LOCK_RETRY_MS);
    } finally {
      if (lockFd !== null) {
        closeSync(lockFd);
        try { unlinkSync(lockFile); } catch {}
      }
    }
  }
  // Another process still owns the lock. Leaving the existing cursor intact is
  // safer than risking a backwards write; a later capture will advance it.
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function getCaptureLockOwnerState(lockFile: string): "alive" | "dead" | "unknown" {
  try {
    const [pidText] = readFileSync(lockFile, "utf-8").split(":", 1);
    const pid = Number(pidText);
    if (!Number.isSafeInteger(pid) || pid <= 0) return "unknown";

    try {
      process.kill(pid, 0);
      return "alive";
    } catch (error) {
      return (error as NodeJS.ErrnoException).code === "ESRCH" ? "dead" : "alive";
    }
  } catch {
    return "unknown";
  }
}

/**
 * Serialize the complete read/upload/commit capture transaction for a session.
 * Background prompt and Stop hooks can overlap, so the later hook waits, then
 * re-reads the cursor after the earlier upload has committed.
 */
export async function withSessionCaptureLock(
  sessionId: string,
  action: () => Promise<void>,
  waitMs = CAPTURE_LOCK_WAIT_MS,
): Promise<boolean> {
  ensureTrackerDir();
  const lockFile = join(TRACKER_DIR, `${sessionId}.capture.lock`);
  const deadline = Date.now() + waitMs;

  while (Date.now() <= deadline) {
    let lockFd: number | null = null;
    const owner = `${process.pid}:${Date.now()}:${Math.random()}`;
    try {
      lockFd = openSync(lockFile, "wx");
      writeFileSync(lockFd, owner);
      await action();
      return true;
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code;
      if (lockFd !== null || code !== "EEXIST") throw error;

      try {
        const ownerState = getCaptureLockOwnerState(lockFile);
        const lockAge = Date.now() - statSync(lockFile).mtimeMs;
        // PID reuse must not make a lock immortal. The age ceiling remains
        // beyond the owning hook's full lifetime so healthy locks are retained.
        if (ownerState === "dead" || lockAge > CAPTURE_LOCK_STALE_MS) {
          unlinkSync(lockFile);
          continue;
        }
      } catch {}

      await delay(CAPTURE_LOCK_RETRY_MS);
    } finally {
      if (lockFd !== null) {
        closeSync(lockFd);
        try {
          if (readFileSync(lockFile, "utf-8") === owner) unlinkSync(lockFile);
        } catch {}
      }
    }
  }

  return false;
}
