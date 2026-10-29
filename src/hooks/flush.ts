import { settleAuth } from "../services/auth.js";
import { readFileSync } from "node:fs";
import { isConfigured } from "../config.js";
import { SupermemoryClient, USER_ENTITY_CONTEXT } from "../services/client.js";
import { getTags } from "../services/tags.js";
import { log } from "../services/logger.js";
import { resolveTranscriptPath } from "../services/capture.js";
import { readRawDelta } from "../services/session-capture.js";
import { getSessionId } from "../services/session.js";

// Stop hooks are capped at 30s by Codex; the raw-delta upload outlives the
// short recall budget without blocking the next session.
const SESSION_TIMEOUT_MS = 25000;

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

  const cwd = payload.cwd || process.cwd();
  const tags = getTags(cwd);
  const sessionId = getSessionId(payload.session_id, tags.project);

  const transcriptPath = resolveTranscriptPath(payload.transcript_path, sessionId);

  log("flush: start", { sessionId, transcriptPath });

  if (!transcriptPath) {
    return;
  }

  // Always send the raw rollout delta; the server adapter turns it into clean
  // conversation text. No gating, signal filtering, or memory shaping here.
  const session = readRawDelta(transcriptPath, sessionId);
  if (!session) {
    return;
  }

  const client = new SupermemoryClient();
  const result = await client.addSession(tags.canonical, session.raw, {
    sessionId,
    generation: session.generation,
    offset: session.offset,
    metadata: {
      type: "conversation",
      project: tags.projectName,
      sm_project_id: tags.projectId,
      sm_scope: "personal",
      sm_capture_mode: "session_end",
      timestamp: new Date().toISOString(),
    },
    supportingContext: USER_ENTITY_CONTEXT,
    timeoutMs: SESSION_TIMEOUT_MS,
  });

  // Advance the cursor only after the bytes are accepted (2xx); a failed send
  // leaves the cursor so the next Stop re-sends the same delta.
  if (result.success) {
    session.commit();
    log("flush: session sent", {
      sessionId,
      bytes: session.raw.length,
      generation: session.generation,
    });
    process.stdout.write(
      JSON.stringify({
        systemMessage: "◪ supermemory · saved this turn",
      }),
    );
  } else {
    log("flush: session send failed, cursor not advanced", {
      sessionId,
      error: result.error,
    });
  }
}

// Let a refresh that is still rotating tokens save them before exiting.
main()
  .catch(() => {})
  .finally(() => settleAuth().finally(() => process.exit(0)));
