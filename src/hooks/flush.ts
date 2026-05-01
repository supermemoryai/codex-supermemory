import { readFileSync, existsSync } from "node:fs";
import { isConfigured } from "../config.js";
import { SupermemoryClient } from "../services/client.js";
import { getTags } from "../services/tags.js";
import { log } from "../services/logger.js";
import {
  parseTranscript,
  getEntriesSince,
  formatTranscript,
  findTranscriptPath,
} from "../services/transcript.js";
import { getLastCapturedIndex, setLastCapturedIndex } from "../services/tracker.js";
import { filterBySignals } from "../services/signals.js";

interface CodexStopPayload {
  session_id?: string;
  transcript_path?: string | null;
  cwd?: string;
  [key: string]: unknown;
}

async function main() {
  let rawInput = "";
  try {
    rawInput = readFileSync(0, "utf-8");
  } catch {
    process.exit(0);
  }

  if (!isConfigured()) {
    process.exit(0);
  }

  let payload: CodexStopPayload = {};
  try {
    payload = JSON.parse(rawInput) as CodexStopPayload;
  } catch {
    process.exit(0);
  }

  const sessionId = payload.session_id || `codex_${Date.now()}`;
  const cwd = payload.cwd || process.cwd();
  const tags = getTags(cwd);

  let transcriptPath = payload.transcript_path || null;
  if (!transcriptPath && sessionId) {
    transcriptPath = findTranscriptPath(sessionId);
  }

  if (!transcriptPath || !existsSync(transcriptPath)) {
    log("flush: no transcript to capture from", { sessionId });
    process.exit(0);
  }

  const entries = parseTranscript(transcriptPath);
  if (entries.length === 0) {
    log("flush: transcript empty", { sessionId });
    process.exit(0);
  }

  const lastIndex = getLastCapturedIndex(sessionId);
  const newEntries = getEntriesSince(entries, lastIndex);

  if (newEntries.length === 0) {
    log("flush: no new entries to capture", { sessionId });
    process.exit(0);
  }

  const signalEntries = filterBySignals(newEntries);

  if (signalEntries.length === 0) {
    log("flush: no signal entries to capture", { sessionId, totalNew: newEntries.length });
    const lastEntry = newEntries[newEntries.length - 1];
    setLastCapturedIndex(sessionId, lastEntry.index);
    process.exit(0);
  }

  log("flush: capturing final entries", {
    sessionId,
    signalCount: signalEntries.length,
    totalNew: newEntries.length,
  });

  const client = new SupermemoryClient();
  const transcript = formatTranscript(signalEntries);
  const content = `[Session ${sessionId}]\n${transcript}`;

  const metadata = {
    type: "conversation" as const,
    sessionId,
    entryCount: newEntries.length,
    timestamp: new Date().toISOString(),
  };

  try {
    await Promise.all([
      client.addMemory(content, tags.project, metadata, { customId: `${sessionId}_project` }),
      client.addMemory(content, tags.user, metadata, { customId: `${sessionId}_user` }),
    ]);

    const lastEntry = newEntries[newEntries.length - 1];
    setLastCapturedIndex(sessionId, lastEntry.index);

    log("flush: captured final entries", {
      sessionId,
      count: newEntries.length,
      lastIndex: lastEntry.index,
    });
  } catch (error) {
    log("flush: error", { error: String(error) });
  }

  process.exit(0);
}

main().catch(() => process.exit(0));
