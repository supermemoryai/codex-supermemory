import { existsSync, readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { homedir } from "node:os";

const CACHE_DIR = join(homedir(), ".codex-supermemory", "trackers");

function ensureDir(): void {
  if (!existsSync(CACHE_DIR)) mkdirSync(CACHE_DIR, { recursive: true });
}

function cacheFile(sessionId: string): string {
  return join(CACHE_DIR, `${sessionId}.facts.json`);
}

export function normalizeFact(s: string): string {
  return s.toLowerCase().replace(/\s+/g, " ").trim();
}

export function getSeenFacts(sessionId: string): Set<string> {
  const file = cacheFile(sessionId);
  if (!existsSync(file)) return new Set();
  try {
    const parsed = JSON.parse(readFileSync(file, "utf-8")) as { facts?: string[] };
    return new Set(parsed.facts ?? []);
  } catch {
    return new Set();
  }
}

export function addSeenFacts(sessionId: string, facts: string[]): void {
  if (facts.length === 0) return;
  ensureDir();
  const seen = getSeenFacts(sessionId);
  for (const f of facts) seen.add(normalizeFact(f));
  writeFileSync(cacheFile(sessionId), JSON.stringify({ facts: [...seen] }));
}
