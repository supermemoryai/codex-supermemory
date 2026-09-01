import { readFileSync } from "node:fs";
import { CONFIG, isConfigured } from "../config.js";
import { SupermemoryClient } from "../services/client.js";
import { captureEntries, resolveTranscriptPath } from "../services/capture.js";
import { getSessionId } from "../services/session.js";
import { getTags } from "../services/tags.js";
import { log } from "../services/logger.js";

interface CodexPromptPayload {
  session_id?: string;
  transcript_path?: string | null;
  cwd?: string;
  [key: string]: unknown;
}

async function main(): Promise<void> {
  if (!isConfigured() || CONFIG.captureEveryNTurns <= 0) return;

  let payload: CodexPromptPayload;
  try {
    payload = JSON.parse(readFileSync(0, "utf-8")) as CodexPromptPayload;
  } catch {
    return;
  }

  const cwd = payload.cwd || process.cwd();
  const tags = getTags(cwd);
  const sessionId = getSessionId(payload.session_id, tags.project);
  const transcriptPath = resolveTranscriptPath(payload.transcript_path, sessionId);

  log("capture-turn: start", { sessionId, transcriptPath });
  await captureEntries(
    "recall",
    new SupermemoryClient(),
    sessionId,
    transcriptPath,
    tags,
    {
      requireMinEntries: 2,
      requireMinTurns: CONFIG.captureEveryNTurns,
    },
  );
}

main()
  .catch(() => {})
  .finally(() => process.exit(0));
