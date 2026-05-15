/**
 * Shared capture logic used by both recall and flush hooks.
 * Reads transcript entries since last capture, filters by signals,
 * and saves to both project and user containers.
 */
import { existsSync } from "node:fs";
import { SupermemoryClient } from "./client.js";
import { log } from "./logger.js";
import {
  parseTranscript,
  getEntriesSince,
  formatTranscript,
  findTranscriptPath,
} from "./transcript.js";
import { getLastCapturedIndex, setLastCapturedIndex } from "./tracker.js";
import { filterBySignals, groupEntriesIntoTurns } from "./signals.js";

export interface CaptureOptions {
  /** Minimum number of new entries required before capturing. Default: 0 */
  requireMinEntries?: number;
  /** Minimum number of turns (including current) before capturing. Default: 0 */
  requireMinTurns?: number;
}

/**
 * Resolve a transcript path — either from the provided value or by
 * searching for a file matching the session ID.
 */
export function resolveTranscriptPath(
  transcriptPath: string | null | undefined,
  sessionId: string,
): string | null {
  if (transcriptPath) return transcriptPath;
  return findTranscriptPath(sessionId);
}

/**
 * Capture new transcript entries since last capture, filter by signals,
 * and save to both project and user containers.
 *
 * @param caller   Label for log messages (e.g. "recall" or "flush")
 * @param client   Supermemory API client
 * @param sessionId  Session identifier
 * @param transcriptPath  Path to the transcript JSONL file (or null)
 * @param tags  Container tags for project and user
 * @param options  Optional gating thresholds
 */
export async function captureEntries(
  caller: string,
  client: SupermemoryClient,
  sessionId: string,
  transcriptPath: string | null,
  tags: { project: string; user: string },
  options: CaptureOptions = {},
): Promise<void> {
  const { requireMinEntries = 0, requireMinTurns = 0 } = options;

  if (!transcriptPath || !existsSync(transcriptPath)) {
    log(`${caller}: no transcript to capture from`, { sessionId, transcriptPath });
    return;
  }

  const entries = parseTranscript(transcriptPath);
  if (entries.length === 0) {
    log(`${caller}: transcript empty`, { sessionId });
    return;
  }

  const lastIndex = getLastCapturedIndex(sessionId);
  const newEntries = getEntriesSince(entries, lastIndex);

  if (requireMinEntries > 0 && newEntries.length < requireMinEntries) {
    log(`${caller}: not enough new entries to capture`, {
      sessionId,
      newCount: newEntries.length,
      required: requireMinEntries,
      lastIndex,
    });
    return;
  }

  if (newEntries.length === 0) {
    log(`${caller}: no new entries to capture`, { sessionId });
    return;
  }

  // Turn-based gating (used by recall to batch captures)
  if (requireMinTurns > 0) {
    const turns = groupEntriesIntoTurns(newEntries);
    const effectiveTurnCount = turns.length + 1; // +1 for current user prompt
    if (effectiveTurnCount < requireMinTurns) {
      log(`${caller}: waiting for more turns before capture`, {
        sessionId,
        turnCount: effectiveTurnCount,
        requiredTurns: requireMinTurns,
        lastIndex,
      });
      return;
    }
  }

  // Filter to only entries with meaningful signals (preferences, decisions, etc.)
  const signalEntries = filterBySignals(newEntries);

  if (signalEntries.length === 0) {
    log(`${caller}: no signal entries to capture`, {
      sessionId,
      totalNew: newEntries.length,
      lastIndex,
    });
    // Still update tracker so we don't re-check these entries
    const lastEntry = newEntries[newEntries.length - 1];
    setLastCapturedIndex(sessionId, lastEntry.index);
    return;
  }

  log(`${caller}: capturing signal entries`, {
    sessionId,
    signalCount: signalEntries.length,
    totalNew: newEntries.length,
    lastIndex,
  });

  const transcript = formatTranscript(signalEntries);
  const rawContent = `[Session ${sessionId}]\n${transcript}`;

  const content = rawContent
    .replace(/\[SUPERMEMORY CONTAINERS\][\s\S]*?\[END SUPERMEMORY CONTAINERS\]\s*/g, "")
    .replace(/<supermemory-containers>[\s\S]*?<\/supermemory-containers>\s*/g, "")
    .trim();

  const metadata = {
    type: "conversation" as const,
    sessionId,
    entryCount: newEntries.length,
    timestamp: new Date().toISOString(),
  };

  // Save to both project and user containers.
  // Use customId so all session turns go into the same document.
  try {
    await Promise.all([
      client.addMemory(content, tags.project, metadata, { customId: `${sessionId}_project` }),
      client.addMemory(content, tags.user, metadata, { customId: `${sessionId}_user` }),
    ]);

    const lastEntry = newEntries[newEntries.length - 1];
    setLastCapturedIndex(sessionId, lastEntry.index);

    log(`${caller}: captured entries`, {
      sessionId,
      count: newEntries.length,
      lastIndex: lastEntry.index,
    });
  } catch (error) {
    log(`${caller}: capture error`, { error: String(error) });
    // Don't rethrow — let the caller decide how to handle
  }
}
