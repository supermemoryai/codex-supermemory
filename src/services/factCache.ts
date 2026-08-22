import { existsSync, readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { homedir } from "node:os";
import { createHash } from "node:crypto";

const CACHE_DIR = join(homedir(), ".codex-supermemory", "trackers");
export const MAX_SEEN_FACTS = 500;
const HASH_PREFIX = "sha256:";

function ensureDir(): void {
  if (!existsSync(CACHE_DIR)) mkdirSync(CACHE_DIR, { recursive: true });
}

function cacheFile(sessionId: string): string {
  return join(CACHE_DIR, `${sessionId}.facts.json`);
}

export function normalizeFact(s: string): string {
  return s.toLowerCase().replace(/\s+/g, " ").trim();
}

export function factKey(s: string): string {
  return `${HASH_PREFIX}${createHash("sha256").update(normalizeFact(s)).digest("hex")}`;
}

export function getSeenFacts(sessionId: string): Set<string> {
  const file = cacheFile(sessionId);
  if (!existsSync(file)) return new Set();
  try {
    const parsed = JSON.parse(readFileSync(file, "utf-8")) as { facts?: string[] };
    const facts = (parsed.facts ?? [])
      .filter((fact): fact is string => typeof fact === "string" && fact.length > 0)
      .map((fact) => fact.startsWith(HASH_PREFIX) ? fact : factKey(fact));
    return new Set(facts.slice(-MAX_SEEN_FACTS));
  } catch {
    return new Set();
  }
}

export function addSeenFacts(sessionId: string, facts: string[]): void {
  if (facts.length === 0) return;
  ensureDir();
  const seen = getSeenFacts(sessionId);
  for (const f of facts) seen.add(factKey(f));
  const bounded = [...seen].slice(-MAX_SEEN_FACTS);
  writeFileSync(cacheFile(sessionId), JSON.stringify({ facts: bounded }));
}
