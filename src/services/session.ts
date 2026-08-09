import { createHash } from "node:crypto";

const FOUR_HOURS_MS = 4 * 60 * 60 * 1000;

function sha256(input: string): string {
  return createHash("sha256").update(input).digest("hex").slice(0, 16);
}

export function getFourHourBucket(date = new Date()): number {
  return Math.floor(date.getTime() / FOUR_HOURS_MS);
}

export function getSessionId(
  providedSessionId: string | null | undefined,
  scope: string,
  date = new Date(),
): string {
  if (providedSessionId?.trim()) return providedSessionId;
  return `codex_${sha256(`${scope}:${getFourHourBucket(date)}`)}`;
}

const SAFE_SESSION_ID = /^[A-Za-z0-9_-]+$/;

/**
 * A session id becomes part of a filename wherever it's used to key on-disk
 * trackers/caches (see tracker.ts, factCache.ts). Session ids normally come
 * from Codex itself, but some hook payloads pass them through unvalidated,
 * so anything containing path separators or traversal sequences (e.g.
 * "../../etc/passwd") must never reach `join()` unchanged. Hash any id that
 * isn't a plain alphanumeric/underscore/hyphen token instead of stripping
 * it, so the mapping stays deterministic and collision-resistant.
 */
export function sanitizeSessionId(sessionId: string): string {
  if (SAFE_SESSION_ID.test(sessionId)) return sessionId;
  return `unsafe_${sha256(sessionId)}`;
}
