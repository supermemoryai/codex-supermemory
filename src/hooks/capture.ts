import { readFileSync } from "node:fs";
import { isConfigured } from "../config.js";
import { captureConversationDelta } from "../services/conversation-capture.js";

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
    process.stderr.write(
      "[supermemory] Session NOT saved — API key missing. " +
      "Run: export SUPERMEMORY_CODEX_API_KEY=\"sm_...\"\n"
    );
    process.exit(0);
  }

  let payload: CodexStopPayload = {};
  try {
    payload = JSON.parse(rawInput) as CodexStopPayload;
  } catch {
    process.exit(0);
  }

  try {
    await captureConversationDelta(payload, { force: true, source: "stop" });
  } catch (error) {
    // Stop hooks should never break Codex shutdown.
  }

  process.exit(0);
}

main().catch(() => process.exit(0));
