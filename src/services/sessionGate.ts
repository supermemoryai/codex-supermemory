import { closeSync, openSync, readSync } from "node:fs";
import { CONFIG } from "../config.js";

export type SessionSkipReason = "orchestrated" | "subagent" | "helper" | "headless";

export interface CodexSessionPayload {
  agent_id?: unknown;
  agent_type?: unknown;
  transcript_path?: unknown;
}

const ORCHESTRATOR_ENV_VARS = ["CONDUCTOR_WORKSPACE_PATH", "CONDUCTOR_SESSION_ID", "VK_WORKSPACE_ID"];
const META_CHUNK_BYTES = 64 * 1024;
const MAX_META_BYTES = 4 * 1024 * 1024;

/** Conductor and Vibe Kanban export these variables to the agents they launch. */
export function isOrchestratedSession(env: NodeJS.ProcessEnv = process.env): boolean {
  return ORCHESTRATOR_ENV_VARS.some((name) => !!env[name]?.trim());
}

/** Read `source` from the session_meta record Codex writes as the first rollout line. */
export function readCodexSessionSource(transcriptPath: unknown): unknown {
  if (typeof transcriptPath !== "string" || !transcriptPath) return undefined;
  let fd: number | undefined;
  try {
    fd = openSync(transcriptPath, "r");
    const chunks: Buffer[] = [];
    let offset = 0;
    while (offset < MAX_META_BYTES) {
      const chunk = Buffer.alloc(META_CHUNK_BYTES);
      const read = readSync(fd, chunk, 0, chunk.length, offset);
      if (read === 0) break;
      const newline = chunk.subarray(0, read).indexOf(10);
      chunks.push(chunk.subarray(0, newline === -1 ? read : newline));
      offset += read;
      if (newline !== -1) break;
    }
    const first = JSON.parse(Buffer.concat(chunks).toString("utf-8")) as {
      type?: string;
      payload?: { source?: unknown };
    };
    return first.type === "session_meta" ? first.payload?.source : undefined;
  } catch {
    return undefined;
  } finally {
    if (fd !== undefined) closeSync(fd);
  }
}

/** Why a hook must not call Supermemory for this Codex session, or null when it may. */
export function getSessionSkipReason(payload: CodexSessionPayload): SessionSkipReason | null {
  const orchestrated = isOrchestratedSession();
  if (orchestrated && !CONFIG.captureOrchestrated) return "orchestrated";
  if (!CONFIG.captureSubagents && (payload.agent_id || payload.agent_type)) return "subagent";
  if (CONFIG.captureSubagents && (CONFIG.captureHeadless || orchestrated)) return null;

  const source = readCodexSessionSource(payload.transcript_path);
  if (!CONFIG.captureSubagents && source && typeof source === "object") {
    const subagent = (source as Record<string, unknown>).subagent;
    if (subagent && typeof subagent === "object" && "thread_spawn" in subagent) return "subagent";
    if (subagent !== undefined || "internal" in source) return "helper";
  }
  if (source === "exec" && !orchestrated && !CONFIG.captureHeadless) return "headless";
  return null;
}
