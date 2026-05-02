/**
 * Signal-based filtering for memory capture.
 * Matches Claude's approach: group into turns, find signals, include N turns before.
 */

import { getSignalConfig } from "../config.js";
import type { TranscriptEntry } from "./transcript.js";

export interface Turn {
  userEntries: TranscriptEntry[];
  assistantEntries: TranscriptEntry[];
  allEntries: TranscriptEntry[];
}

/**
 * Check if text contains any signal keywords.
 */
export function hasSignal(text: string, keywords: string[]): boolean {
  const lower = text.toLowerCase();
  return keywords.some((keyword) => lower.includes(keyword));
}

/**
 * Get text content from an entry.
 */
function getEntryText(entry: TranscriptEntry): string {
  return entry.content || "";
}

/**
 * Group transcript entries into turns.
 * A turn is a user message followed by assistant response(s).
 */
export function groupEntriesIntoTurns(entries: TranscriptEntry[]): Turn[] {
  const turns: Turn[] = [];
  let currentTurn: Turn = { userEntries: [], assistantEntries: [], allEntries: [] };

  for (const entry of entries) {
    if (entry.role === "user") {
      // Start new turn if we already have assistant responses
      if (currentTurn.assistantEntries.length > 0) {
        turns.push(currentTurn);
        currentTurn = { userEntries: [], assistantEntries: [], allEntries: [] };
      }
      currentTurn.userEntries.push(entry);
      currentTurn.allEntries.push(entry);
    } else if (entry.role === "assistant") {
      currentTurn.assistantEntries.push(entry);
      currentTurn.allEntries.push(entry);
    }
  }

  // Push final turn if it has content
  if (currentTurn.allEntries.length > 0) {
    turns.push(currentTurn);
  }

  return turns;
}

/**
 * Get combined text from a turn's user entries.
 */
function getTurnUserText(turn: Turn): string {
  return turn.userEntries
    .map((e) => getEntryText(e))
    .join(" ")
    .toLowerCase();
}

/**
 * Find indices of turns that contain signal keywords.
 */
export function findSignalTurnIndices(turns: Turn[], keywords: string[]): number[] {
  const signalIndices: number[] = [];

  for (let i = 0; i < turns.length; i++) {
    const turn = turns[i];
    const userText = getTurnUserText(turn);

    // Check user text for signals
    if (hasSignal(userText, keywords)) {
      signalIndices.push(i);
      continue;
    }

    // Also check assistant text for signals
    const assistantText = turn.assistantEntries
      .map((e) => getEntryText(e))
      .join(" ")
      .toLowerCase();

    if (hasSignal(assistantText, keywords)) {
      signalIndices.push(i);
    }
  }

  return signalIndices;
}

/**
 * Get turns around signal indices, including N turns before for context.
 */
export function getTurnsAroundSignals(
  turns: Turn[],
  signalIndices: number[],
  turnsBefore: number
): Turn[] {
  if (signalIndices.length === 0) return [];

  const includeSet = new Set<number>();

  for (const signalIdx of signalIndices) {
    // Include turns before the signal for context
    const startIdx = Math.max(0, signalIdx - turnsBefore);
    for (let i = startIdx; i <= signalIdx; i++) {
      includeSet.add(i);
    }
  }

  // Return turns in order
  const sortedIndices = Array.from(includeSet).sort((a, b) => a - b);
  return sortedIndices.map((idx) => turns[idx]);
}

/**
 * Filter entries using signal extraction.
 * Returns entries from turns that contain signals + context turns before.
 */
export function filterBySignals(entries: TranscriptEntry[]): TranscriptEntry[] {
  const config = getSignalConfig();

  // If signal extraction is disabled, return all entries
  if (!config.enabled) {
    return entries;
  }

  // Group into turns
  const turns = groupEntriesIntoTurns(entries);
  if (turns.length === 0) return [];

  // Find turns with signals
  const signalIndices = findSignalTurnIndices(turns, config.keywords);
  if (signalIndices.length === 0) return [];

  // Get turns around signals (including context)
  const turnsToInclude = getTurnsAroundSignals(turns, signalIndices, config.turnsBefore);

  // Flatten back to entries
  const result: TranscriptEntry[] = [];
  for (const turn of turnsToInclude) {
    result.push(...turn.allEntries);
  }

  return result;
}
