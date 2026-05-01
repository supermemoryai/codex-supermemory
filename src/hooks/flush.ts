import { readFileSync } from "node:fs";
import { isConfigured } from "../config.js";
import { SupermemoryClient } from "../services/client.js";
import { getTags } from "../services/tags.js";
import { log } from "../services/logger.js";
import { captureEntries, resolveTranscriptPath } from "../services/capture.js";

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
    return;
  }

  if (!isConfigured()) {
    return;
  }

  let payload: CodexStopPayload = {};
  try {
    payload = JSON.parse(rawInput) as CodexStopPayload;
  } catch {
    return;
  }

  const sessionId = payload.session_id || `codex_${Date.now()}`;
  const cwd = payload.cwd || process.cwd();
  const tags = getTags(cwd);

  const transcriptPath = resolveTranscriptPath(payload.transcript_path, sessionId);

  log("flush: start", { sessionId, transcriptPath });

  const client = new SupermemoryClient();

  // Flush captures all remaining entries with no gating thresholds
  await captureEntries("flush", client, sessionId, transcriptPath, tags);
}

main()
  .catch(() => {})
  .finally(() => process.exit(0));
