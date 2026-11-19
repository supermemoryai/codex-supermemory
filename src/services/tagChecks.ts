import { createHash } from "node:crypto";
import { mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

const CACHE_DIR = join(homedir(), ".codex-supermemory", "tag-checks");

function cacheFile(canonicalTag: string): string {
  return join(CACHE_DIR, `${createHash("sha256").update(canonicalTag).digest("hex").slice(0, 32)}.json`);
}

function loadTagChecks(canonicalTag: string): Record<string, unknown> {
  try {
    const parsed = JSON.parse(readFileSync(cacheFile(canonicalTag), "utf-8"));
    return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? parsed : {};
  } catch {
    return {};
  }
}

export function recordTagChecks(canonicalTag: string, hasMemories: Record<string, boolean>): void {
  if (Object.keys(hasMemories).length === 0) return;
  try {
    mkdirSync(CACHE_DIR, { recursive: true });
    const file = cacheFile(canonicalTag);
    const tempFile = `${file}.${process.pid}.tmp`;
    writeFileSync(tempFile, JSON.stringify({ ...loadTagChecks(canonicalTag), ...hasMemories }));
    renameSync(tempFile, file);
  } catch {}
}

export function getRecallTags(canonicalTag: string, readTags: string[]): string[] {
  const checks = loadTagChecks(canonicalTag);
  return readTags.filter((tag) => tag === canonicalTag || checks[tag] !== false);
}
