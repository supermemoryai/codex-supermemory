import { createHash } from "node:crypto";
import { mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { homedir } from "node:os";

const TRACKER_DIR = join(homedir(), ".codex-supermemory", "trackers");
const OPENING_PROMPTS_FILE = join(TRACKER_DIR, "opening-prompts.json");
const RECALL_QUERIES_FILE = join(TRACKER_DIR, "recall-queries.json");
export const MAX_OPENING_PROMPTS = 1000;
export const MAX_RECALL_QUERIES = 100;
export const RECALL_QUERY_WINDOW_MS = 10 * 60 * 1000;
export const OPENING_PROMPT_MIN_CHARS = 200;
export const OPENING_PROMPT_WINDOW_MS = 24 * 60 * 60 * 1000;
export const OPENING_PROMPT_MARKER = "[opening prompt identical to an earlier session]";

export interface CachedRecallItem {
  memory: string;
  title?: string;
  filepath?: string;
}

interface Timestamped {
  at: number;
}

type RecallEntry = Timestamped & { results: CachedRecallItem[] };

function hashKey(...parts: string[]): string {
  return createHash("sha256").update(parts.join("\n")).digest("hex").slice(0, 32);
}

export function readJsonIndex<T extends Timestamped>(file: string, maxAgeMs: number, now = Date.now()): Record<string, T> {
  try {
    const parsed = JSON.parse(readFileSync(file, "utf-8")) as unknown;
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return {};
    return Object.fromEntries(
      Object.entries(parsed as Record<string, unknown>).filter((entry): entry is [string, T] => {
        const at = (entry[1] as Partial<Timestamped> | null)?.at;
        return typeof at === "number" && at <= now && now - at < maxAgeMs;
      }),
    );
  } catch {
    return {};
  }
}

export function writeJsonIndex<T extends Timestamped>(file: string, index: Record<string, T>, max: number): void {
  const newest = Object.entries(index).sort((a, b) => a[1].at - b[1].at).slice(-max);
  const tempFile = `${file}.${process.pid}.${Date.now()}.tmp`;
  try {
    mkdirSync(TRACKER_DIR, { recursive: true, mode: 0o700 });
    writeFileSync(tempFile, JSON.stringify(Object.fromEntries(newest)), { mode: 0o600 });
    renameSync(tempFile, file);
  } catch {
    rmSync(tempFile, { force: true });
  }
}

/** Key for an opening prompt worth deduplicating, or undefined when it is too short. */
export function openingPromptKey(containerTag: string, prompt: string): string | undefined {
  const text = prompt.trim();
  return text.length >= OPENING_PROMPT_MIN_CHARS ? hashKey(containerTag, text) : undefined;
}

export function hasCapturedOpeningPrompt(key: string, now = Date.now()): boolean {
  return Object.hasOwn(readJsonIndex(OPENING_PROMPTS_FILE, OPENING_PROMPT_WINDOW_MS, now), key);
}

export function rememberOpeningPrompt(key: string, now = Date.now()): void {
  const index = readJsonIndex<Timestamped>(OPENING_PROMPTS_FILE, OPENING_PROMPT_WINDOW_MS, now);
  index[key] = { at: now };
  writeJsonIndex(OPENING_PROMPTS_FILE, index, MAX_OPENING_PROMPTS);
}

/** Scope is every input that selects the results: backend, credential and read tags. */
function recallKey(scope: string[], query: string): string {
  return hashKey(...scope, query.trim().replace(/\s+/g, " "));
}

export function getCachedRecall(scope: string[], query: string, now = Date.now()): CachedRecallItem[] | undefined {
  const entry = readJsonIndex<RecallEntry>(RECALL_QUERIES_FILE, RECALL_QUERY_WINDOW_MS, now)[recallKey(scope, query)];
  return Array.isArray(entry?.results) ? entry.results : undefined;
}

export function rememberRecall(scope: string[], query: string, results: CachedRecallItem[], now = Date.now()): void {
  const index = readJsonIndex<RecallEntry>(RECALL_QUERIES_FILE, RECALL_QUERY_WINDOW_MS, now);
  index[recallKey(scope, query)] = {
    at: now,
    results: results.map(({ memory, title, filepath }) => ({ memory, title, filepath })),
  };
  writeJsonIndex(RECALL_QUERIES_FILE, index, MAX_RECALL_QUERIES);
}

export function clearRecallCache(): void {
  rmSync(RECALL_QUERIES_FILE, { force: true });
}
