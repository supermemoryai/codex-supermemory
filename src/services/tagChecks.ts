import { createHash } from "node:crypto";
import { mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import type { ResolvedTags } from "./tags.js";

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

export function recordTagChecks(canonicalTag: string, hasDocuments: Record<string, boolean>): void {
  if (Object.keys(hasDocuments).length === 0) return;
  try {
    mkdirSync(CACHE_DIR, { recursive: true });
    const file = cacheFile(canonicalTag);
    const tempFile = `${file}.${process.pid}.tmp`;
    writeFileSync(tempFile, JSON.stringify({ ...loadTagChecks(canonicalTag), ...hasDocuments }));
    renameSync(tempFile, file);
  } catch {}
}

export function getSkippableTags(tags: Pick<ResolvedTags, "allReads" | "configuredReads">): string[] {
  return [...new Set(tags.allReads)].filter((tag) => !tags.configuredReads.includes(tag));
}

export function getRecallTags(tags: Pick<ResolvedTags, "canonical" | "allReads" | "configuredReads">): string[] {
  const checks = loadTagChecks(tags.canonical);
  const skippable = new Set(getSkippableTags(tags));
  return tags.allReads.filter((tag) => !skippable.has(tag) || checks[tag] !== false);
}
