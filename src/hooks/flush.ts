import { settleAuth } from "../services/auth.js";
import { readFileSync } from "node:fs";
import { getApiBaseUrl, getApiVersion, isConfigured } from "../config.js";
import { SupermemoryClient, USER_ENTITY_CONTEXT } from "../services/client.js";
import { getTags } from "../services/tags.js";
import { log } from "../services/logger.js";
import { captureEntries, resolveTranscriptPath } from "../services/capture.js";
import { readRawChunks } from "../services/session-capture.js";
import { getSessionId } from "../services/session.js";
import { withSessionCaptureLock } from "../services/tracker.js";

// Stop hooks are capped at 30s by Codex; the raw-delta upload outlives the
// short recall budget without blocking the next session.
const SESSION_TIMEOUT_MS = 25000;
const MIN_REQUEST_MS = 1000;
const REJECTED_STATUSES = new Set([400, 413, 415, 422]);

function formatBytes(bytes: number): string {
  return bytes >= 1024 * 1024 ? `${(bytes / 1024 / 1024).toFixed(1)} MB` : `${Math.max(1, Math.round(bytes / 1024))} KB`;
}

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

  const client = new SupermemoryClient();

  // Legacy servers, including self-hosted ones, have no session endpoint, so they keep the client-formatted capture.
  if (getApiVersion() === "legacy") {
    const legacy = await captureEntries("flush", client, sessionId, transcriptPath, tags);
    if (legacy.status === "captured") {
      process.stdout.write(JSON.stringify({
        systemMessage: "◪ supermemory · saved this turn",
      }));
    }
    return;
  }

  if (!transcriptPath) {
    return;
  }

  // Overlapping async Stop hooks must not read the same cursor, or a slower upload rewinds it after a later one.
  const acquired = await withSessionCaptureLock(sessionId, async () => {
    // Always send the raw rollout delta; the server adapter turns it into clean
    // conversation text. No gating, signal filtering, or memory shaping here.
    const chunks = readRawChunks(
      transcriptPath,
      sessionId,
      `${getApiBaseUrl()}\n${tags.canonical}`,
    );
    const deadline = Date.now() + SESSION_TIMEOUT_MS;
    let sent = 0;
    let skippedBytes = 0;
    let truncatedBytes = 0;
    const skipReasons = new Set<string>();
    for (const chunk of chunks) {
      if (chunk.oversizedBytes > 0) {
        const reason = `one rollout line of ${formatBytes(chunk.oversizedBytes)} is too large to send`;
        chunk.commit(reason);
        skippedBytes += chunk.oversizedBytes;
        skipReasons.add("line too large");
        log("flush: oversized rollout line skipped", { sessionId, offset: chunk.offset, end: chunk.end });
        continue;
      }
      if (!chunk.raw) {
        chunk.commit();
        continue;
      }
      const remaining = deadline - Date.now();
      if (remaining < MIN_REQUEST_MS) break;
      const result = await client.addSession(tags.canonical, chunk.raw, {
        sessionId,
        generation: chunk.generation,
        offset: chunk.offset,
        metadata: {
          type: "conversation",
          project: tags.projectName,
          sm_project_id: tags.projectId,
          sm_scope: "personal",
          sm_capture_mode: "session_end",
          timestamp: new Date().toISOString(),
        },
        supportingContext: USER_ENTITY_CONTEXT,
        timeoutMs: remaining,
      });
      if (result.success) {
        chunk.commit();
        sent++;
        truncatedBytes += chunk.truncatedBytes;
        continue;
      }
      if (result.status !== undefined && REJECTED_STATUSES.has(result.status)) {
        const bytes = Buffer.byteLength(chunk.raw);
        chunk.commit(`server rejected ${formatBytes(bytes)} with HTTP ${result.status}`);
        skippedBytes += bytes;
        skipReasons.add(`HTTP ${result.status}`);
        log("flush: chunk rejected and skipped", { sessionId, offset: chunk.offset, end: chunk.end, status: result.status });
        continue;
      }
      log("flush: session send failed, cursor left at this chunk", {
        sessionId,
        offset: chunk.offset,
        error: result.error,
      });
      break;
    }

    if (sent > 0 || skippedBytes > 0) {
      log("flush: session sent", { sessionId, chunks: chunks.length, sent, skippedBytes, truncatedBytes });
      const parts = [
        sent > 0 ? "saved this turn" : null,
        truncatedBytes > 0 ? `trimmed ${formatBytes(truncatedBytes)} of oversized tool output` : null,
        skippedBytes > 0 ? `skipped ${formatBytes(skippedBytes)} of this session (${[...skipReasons].join(", ")}); ranges listed in ~/.codex-supermemory/session` : null,
      ];
      process.stdout.write(
        JSON.stringify({
          systemMessage: `◪ supermemory · ${parts.filter(Boolean).join(" · ")}`,
        }),
      );
    }
  });
  if (!acquired) {
    log("flush: capture lock busy, delta left for the next Stop", { sessionId });
  }
}

// Let a refresh that is still rotating tokens save them before exiting.
main()
  .catch(() => {})
  .finally(() => settleAuth().finally(() => process.exit(0)));
