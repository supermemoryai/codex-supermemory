import { readFileSync } from "node:fs";
import { isConfigured } from "../config.js";
import { SupermemoryClient } from "../services/client.js";
import { getTags } from "../services/tags.js";
import { stripPrivateContent } from "../services/privacy.js";
import { formatMessagesForCapture } from "../services/context.js";
import { log } from "../services/logger.js";
import type { ConversationMessage } from "../types/index.js";

interface CodexStopPayload {
  session_id?: string;
  messages?: Array<{ role: string; content: unknown }>;
  [key: string]: unknown;
}

async function main() {
  let rawInput = "";
  try {
    rawInput = readFileSync("/dev/stdin", "utf-8");
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

  const messages = payload.messages;
  if (!messages || messages.length === 0) {
    process.exit(0);
  }

  const sessionId = payload.session_id || `codex_${Date.now()}`;
  const cwd = process.cwd();
  const tags = getTags(cwd);

  log("capture: start", { sessionId, messageCount: messages.length, tags });

  // Format and strip private content
  const formatted: ConversationMessage[] = formatMessagesForCapture(messages).map((m) => ({
    ...m,
    content:
      typeof m.content === "string"
        ? stripPrivateContent(m.content)
        : m.content,
  }));

  if (formatted.length === 0) {
    process.exit(0);
  }

  const client = new SupermemoryClient();

  try {
    const result = await client.ingestConversation(
      sessionId,
      formatted,
      [tags.project, tags.user]
    );
    log("capture: done", { sessionId, success: result.success });
  } catch (error) {
    log("capture: error", { error: String(error) });
  }

  process.exit(0);
}

main().catch(() => process.exit(0));
