import { readFileSync, existsSync } from "node:fs";
import { isConfigured } from "../config.js";
import { SupermemoryClient } from "../services/client.js";
import { getTags } from "../services/tags.js";
import { stripPrivateContent } from "../services/privacy.js";
import { log } from "../services/logger.js";
import type { ConversationMessage } from "../types/index.js";

// Actual fields sent by Codex in the Stop hook payload (StopCommandInput in Codex source).
// There is no `messages` field — conversation is available via transcript_path.
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

/**
 * Parse a JSONL transcript file into ConversationMessage[].
 * Codex writes one JSON object per line; each has a `role` and `content`.
 */
function parseTranscript(transcriptPath: string): ConversationMessage[] {
  const messages: ConversationMessage[] = [];
  try {
    const raw = readFileSync(transcriptPath, "utf-8");
    for (const line of raw.split("\n")) {
      const trimmed = line.trim();
      if (!trimmed) continue;
      try {
        const entry = JSON.parse(trimmed) as TranscriptEntry;
        // Support both flat {role, content} and nested {message: {role, content}} shapes.
        const role = entry.role ?? entry.message?.role;
        const content = entry.content ?? entry.message?.content;
        if (role && content !== undefined) {
          const text =
            typeof content === "string"
              ? content
              : JSON.stringify(content);
          messages.push({
            role: role as ConversationMessage["role"],
            content: stripPrivateContent(text),
          });
        }
      } catch {
        // skip malformed lines
      }
    }
  } catch {
    // unreadable transcript — return empty
  }
  return messages;
}

async function main() {
  // Read stdin via fd 0 — works with both shell pipes and spawnSync piped input.
  // readFileSync("/dev/stdin") fails when stdin is a pipe (not a tty).
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

  let messages: ConversationMessage[] = [];

  // Prefer the full transcript file when available.
  if (payload.transcript_path && existsSync(payload.transcript_path)) {
    messages = parseTranscript(payload.transcript_path);
  } else if (payload.last_assistant_message) {
    // Fallback: capture just the last assistant turn.
    messages = [
      {
        role: "assistant",
        content: stripPrivateContent(payload.last_assistant_message),
      },
    ];
  }

  if (messages.length === 0) {
    log("capture: no messages to ingest", { sessionId });
    process.exit(0);
  }

  log("capture: start", { sessionId, messageCount: messages.length, tags });

  const client = new SupermemoryClient();

  try {
    const result = await client.ingestConversation(
      sessionId,
      messages,
      [tags.project, tags.user]
    );
    log("capture: done", { sessionId, success: result.success });
  } catch (error) {
    log("capture: error", { error: String(error) });
  }

  process.exit(0);
}

main().catch(() => process.exit(0));
