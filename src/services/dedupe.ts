import { createHash } from "node:crypto";
import { mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { homedir } from "node:os";

const TRACKER_DIR = join(homedir(), ".codex-supermemory", "trackers");
const OPENING_PROMPTS_FILE = join(TRACKER_DIR, "opening-prompts.json");
const RECALL_QUERIES_FILE = join(TRACKER_DIR, "recall-queries.json");
export const MAX_OPENING_PROMPTS = 1000;
export const MAX_RECALL_QUERIES = 500;
export const RECALL_QUERY_WINDOW_MS = 10 * 60 * 1000;
export const OPENING_PROMPT_MARKER = "[opening prompt identical to an earlier session]";

type HashIndex = Record<string, number>;

function hashKey(containerTag: string, text: string): string {
  return createHash("sha256").update(`${containerTag}\n${text}`).digest("hex").slice(0, 32);
}

function readIndex(file: string): HashIndex {
  try {
    const parsed = JSON.parse(readFileSync(file, "utf-8")) as unknown;
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return {};
    return Object.fromEntries(
      Object.entries(parsed).filter((entry): entry is [string, number] => typeof entry[1] === "number"),
    );
  } catch {
    return {};
  }
}

function writeIndex(file: string, index: HashIndex, max: number): void {
  const newest = Object.entries(index).sort((a, b) => a[1] - b[1]).slice(-max);
  try {
    mkdirSync(TRACKER_DIR, { recursive: true });
    const tempFile = `${file}.${process.pid}.${Date.now()}.tmp`;
    writeFileSync(tempFile, JSON.stringify(Object.fromEntries(newest)));
    renameSync(tempFile, file);
  } catch {}
}

export function openingPromptKey(containerTag: string, prompt: string): string {
  return hashKey(containerTag, prompt.trim());
}

export function hasCapturedOpeningPrompt(key: string): boolean {
  return Object.hasOwn(readIndex(OPENING_PROMPTS_FILE), key);
}

export function rememberOpeningPrompt(key: string): void {
  const index = readIndex(OPENING_PROMPTS_FILE);
  index[key] = Date.now();
  writeIndex(OPENING_PROMPTS_FILE, index, MAX_OPENING_PROMPTS);
}

/** True when this exact query already ran recall for the tag within the window; otherwise records it. */
export function isRepeatedRecallQuery(containerTag: string, query: string, now = Date.now()): boolean {
  const key = hashKey(containerTag, query.trim().replace(/\s+/g, " "));
  const index = readIndex(RECALL_QUERIES_FILE);
  for (const [entry, usedAt] of Object.entries(index)) {
    if (now - usedAt >= RECALL_QUERY_WINDOW_MS || usedAt > now) delete index[entry];
  }
  if (Object.hasOwn(index, key)) return true;
  index[key] = now;
  writeIndex(RECALL_QUERIES_FILE, index, MAX_RECALL_QUERIES);
  return false;
}
