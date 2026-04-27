import { readFileSync, existsSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { homedir } from "node:os";
import { isConfigured } from "../config.js";
import { SupermemoryClient } from "../services/client.js";
import { getTags } from "../services/tags.js";
import { stripPrivateContent, cleanContent } from "../services/privacy.js";
import { log } from "../services/logger.js";
import type { ConversationMessage } from "../types/index.js";

const SESSION_TRACKER =
  process.env.SUPERMEMORY_SESSION_TRACKER ?? join(homedir(), ".codex-supermemory-sessions.json");

// Actual fields sent by Codex in the Stop hook payload (StopCommandInput in Codex source).
interface CodexStopPayload {
  session_id?: string;
  turn_id?: string;
  transcript_path?: string | null;
  cwd?: string;
  hook_event_name?: string;
  model?: string;
  permission_mode?: string;
  stop_hook_active?: boolean;
  last_assistant_message?: string | null;
  [key: string]: unknown;
}

// Each line of the JSONL transcript file is one of these entries.
interface TranscriptEntry {
  role?: string;
  type?: string;
  content?: unknown;
  message?: { role?: string; content?: unknown };
}

function simpleHash(s: string): string {
  let h = 0;
  for (let i = 0; i < s.length; i++) {
    h = (Math.imul(31, h) + s.charCodeAt(i)) | 0;
  }
  return h.toString(36);
}

function loadSessionTracker(): Record<string, number | string> {
  try {
    if (existsSync(SESSION_TRACKER)) {
      return JSON.parse(readFileSync(SESSION_TRACKER, "utf-8")) as Record<string, number | string>;
    }
  } catch {}
  return {};
}

function saveSessionTracker(tracker: Record<string, number | string>): void {
  try {
    writeFileSync(SESSION_TRACKER, JSON.stringify(tracker, null, 2));
  } catch {}
}

/**
 * Parse a JSONL transcript file into ConversationMessage[].
 * Returns both the messages and the total line count so we can persist progress.
 * Skips the first `skipLines` lines to support incremental capture.
 */
function parseTranscript(
  transcriptPath: string,
  skipLines: number
): { messages: ConversationMessage[]; totalLines: number } {
  const messages: ConversationMessage[] = [];
  let totalLines = 0;
  try {
    const raw = readFileSync(transcriptPath, "utf-8");
    const lines = raw.split("\n");
    totalLines = lines.filter((l) => l.trim()).length;

    let linesSkipped = 0;
    for (const line of lines) {
      const trimmed = line.trim();
      if (!trimmed) continue;
      if (linesSkipped < skipLines) {
        linesSkipped++;
        continue;
      }
      try {
        const entry = JSON.parse(trimmed) as TranscriptEntry;
        const role = entry.role ?? entry.message?.role;
        const content = entry.content ?? entry.message?.content;
        if (role && content !== undefined) {
          const rawText =
            typeof content === "string" ? content : JSON.stringify(content);
          const text = cleanContent(stripPrivateContent(rawText));
          if (text) {
            messages.push({
              role: role as ConversationMessage["role"],
              content: text,
            });
          }
        }
      } catch {
        // skip malformed lines
      }
    }
  } catch {
    // unreadable transcript — return empty
  }
  return { messages, totalLines };
}

async function main() {
  // Read stdin via fd 0 — works with both shell pipes and spawnSync piped input.
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

  const tracker = loadSessionTracker();
  const lastLineCount = (tracker[sessionId] as number) ?? 0;

  let messages: ConversationMessage[] = [];
  let newTotalLines = lastLineCount;
  let newLamHash: string | undefined;

  if (payload.transcript_path && existsSync(payload.transcript_path)) {
    const result = parseTranscript(payload.transcript_path, lastLineCount);
    messages = result.messages;
    newTotalLines = result.totalLines;
  } else if (payload.last_assistant_message) {
    // Fallback: no transcript file — capture the last assistant turn.
    // Use a content hash to avoid re-ingesting the same message on repeated hook calls.
    const lamKey = `${sessionId}_lam`;
    const lastLamHash = tracker[lamKey] as string | undefined;
    const currentHash = simpleHash(payload.last_assistant_message);
    if (currentHash !== lastLamHash) {
      messages = [
        {
          role: "assistant",
          content: cleanContent(stripPrivateContent(payload.last_assistant_message)),
        },
      ];
      newLamHash = currentHash;
    }
  }

  if (messages.length === 0) {
    log("capture: no new messages to ingest", { sessionId, lastLineCount });
    process.exit(0);
  }

  log("capture: start", { sessionId, newMessages: messages.length, lastLineCount, tags });

  const client = new SupermemoryClient();

  try {
    const result = await client.ingestConversation(
      sessionId,
      messages,
      [tags.project, tags.user]
    );
    log("capture: done", { sessionId, success: result.success });

    // Only advance the tracker on success to allow retry on failure.
    if (result.success) {
      tracker[sessionId] = newTotalLines;
      if (newLamHash !== undefined) {
        tracker[`${sessionId}_lam`] = newLamHash;
      }
      saveSessionTracker(tracker);
    }
  } catch (error) {
    log("capture: error", { error: String(error) });
  }

  process.exit(0);
}

main().catch(() => process.exit(0));
