import { readFileSync, existsSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { homedir } from "node:os";
import { stripPrivateContent, cleanContent } from "./privacy.js";

const SESSIONS_DIR = join(homedir(), ".codex", "sessions");

export interface TranscriptEntry {
  index: number;
  role: string;
  content: string;
}

/**
 * Find the transcript file for a given session ID.
 * Codex stores transcripts at ~/.codex/sessions/YYYY/MM/DD/rollout-{timestamp}-{session_id}.jsonl
 */
export function findTranscriptPath(sessionId: string): string | null {
  if (!existsSync(SESSIONS_DIR)) {
    return null;
  }

  // Get today's date parts for the most likely location
  const now = new Date();
  const year = now.getFullYear().toString();
  const month = (now.getMonth() + 1).toString().padStart(2, "0");
  const day = now.getDate().toString().padStart(2, "0");

  // Check today's directory first
  const todayDir = join(SESSIONS_DIR, year, month, day);
  const found = searchDirForSession(todayDir, sessionId);
  if (found) return found;

  // If not found, search recent directories (last 3 days)
  for (let i = 1; i <= 3; i++) {
    const pastDate = new Date(now);
    pastDate.setDate(pastDate.getDate() - i);
    const y = pastDate.getFullYear().toString();
    const m = (pastDate.getMonth() + 1).toString().padStart(2, "0");
    const d = pastDate.getDate().toString().padStart(2, "0");
    const pastDir = join(SESSIONS_DIR, y, m, d);
    const found = searchDirForSession(pastDir, sessionId);
    if (found) return found;
  }

  return null;
}

function searchDirForSession(dir: string, sessionId: string): string | null {
  if (!existsSync(dir)) {
    return null;
  }

  try {
    const files = readdirSync(dir);
    for (const file of files) {
      if (file.endsWith(".jsonl") && file.includes(sessionId)) {
        return join(dir, file);
      }
    }
  } catch {
    // Ignore errors
  }

  return null;
}

/** Tool call/result text is bounded before it's stored — raw tool output can be
 * arbitrarily large and is not worth capturing in full. */
const MAX_TOOL_TEXT_LENGTH = 500;

const DUPLICATE_LINE_WINDOW = 5;

interface ContentBlock {
  type?: string;
  text?: string;
}

function extractTextBlocks(
  content: unknown,
  blockTypes: string[],
  separator = "\n",
): string {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  return (content as ContentBlock[])
    .filter(
      (block): block is ContentBlock & { text: string } =>
        !!block &&
        blockTypes.includes(block.type ?? "") &&
        typeof block.text === "string",
    )
    .map((block) => block.text)
    .join(separator);
}

function truncateForCapture(text: string, maxLength = MAX_TOOL_TEXT_LENGTH): string {
  if (text.length <= maxLength) return text;
  return `${text.slice(0, maxLength)}… [truncated, ${text.length - maxLength} more chars]`;
}

/**
 * Parse a Codex JSONL transcript file into TranscriptEntry[].
 *
 * Codex transcript format:
 * - Legacy user messages: { type: "event_msg", payload: { type: "user_message", message: "..." } }
 * - Legacy assistant text: { type: "event_msg", payload: { type: "assistant_output_text", text: "..." } }
 * - Current messages: { type: "response_item", payload: { type: "message", role: "user" | "assistant", content: [...] } }
 *   - user content blocks use `input_text`
 *   - assistant content blocks use `output_text` or `text`
 * - Current tool calls: { type: "response_item", payload: { type: "function_call", name, arguments, call_id } }
 * - Current tool results: { type: "response_item", payload: { type: "function_call_output", call_id, output } }
 *
 * Some rollouts contain both formats for the same turn. Identical nearby
 * entries are deduplicated so the stored conversation contains one copy.
 */
export function parseTranscript(transcriptPath: string): TranscriptEntry[] {
  const entries: TranscriptEntry[] = [];

  if (!existsSync(transcriptPath)) {
    return entries;
  }

  function pushEntry(index: number, role: string, rawContent: string): void {
    const cleaned = cleanContent(stripPrivateContent(rawContent));
    if (!cleaned) return;

    for (let i = entries.length - 1; i >= 0; i--) {
      if (index - entries[i].index > DUPLICATE_LINE_WINDOW) break;
      if (entries[i].role === role && entries[i].content === cleaned) return;
    }

    entries.push({ index, role, content: cleaned });
  }

  try {
    const raw = readFileSync(transcriptPath, "utf-8");
    const lines = raw.split("\n");

    for (let i = 0; i < lines.length; i++) {
      const line = lines[i].trim();
      if (!line) continue;

      try {
        const parsed = JSON.parse(line) as {
          type?: string;
          payload?: {
            type?: string;
            message?: string;
            text?: string;
            role?: string;
            content?: unknown;
            name?: string;
            arguments?: string;
            call_id?: string;
            output?: unknown;
          };
        };

        // Handle event_msg entries
        if (parsed.type === "event_msg" && parsed.payload) {
          const payload = parsed.payload;

          // User message
          if (payload.type === "user_message" && payload.message) {
            pushEntry(i, "user", payload.message);
          }

          // Assistant output text
          if (payload.type === "assistant_output_text" && payload.text) {
            pushEntry(i, "assistant", payload.text);
          }
        }

        // Handle current response_item entries.
        if (parsed.type === "response_item" && parsed.payload) {
          const payload = parsed.payload;
          if (payload.role === "user" && payload.content) {
            // Codex builds event_msg.user_message by concatenating input_text
            // blocks without separators, so mirror that shape for deduplication.
            pushEntry(
              i,
              "user",
              extractTextBlocks(payload.content, ["input_text"], ""),
            );
          } else if (payload.role === "assistant" && payload.content) {
            pushEntry(
              i,
              "assistant",
              extractTextBlocks(payload.content, ["output_text", "text"]),
            );
          } else if (payload.type === "function_call") {
            const name = payload.name || "unknown_tool";
            const args = truncateForCapture(payload.arguments ?? "");
            pushEntry(i, "tool", `[tool_call] ${name}(${args})`);
          } else if (payload.type === "function_call_output") {
            const output =
              typeof payload.output === "string"
                ? payload.output
                : JSON.stringify(payload.output ?? "");
            pushEntry(i, "tool", `[tool_result] ${truncateForCapture(output)}`);
          }
        }
      } catch {
        // Skip malformed lines
      }
    }
  } catch {
    // Unreadable transcript
  }

  return entries;
}

/**
 * Get entries after a given index (for incremental capture).
 */
export function getEntriesSince(
  entries: TranscriptEntry[],
  lastIndex: number | null
): TranscriptEntry[] {
  if (lastIndex === null) {
    return entries;
  }
  return entries.filter((e) => e.index > lastIndex);
}

/**
 * Format entries as a transcript string for storage.
 */
export function formatTranscript(entries: TranscriptEntry[]): string {
  return entries
    .map((e, idx) => `${idx + 1}. [${e.role}] ${e.content}`)
    .join("\n");
}
