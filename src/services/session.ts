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
