import { closeSync, openSync, readSync } from "node:fs";
import { createHash } from "node:crypto";
import { join } from "node:path";
import { homedir } from "node:os";
import { CONFIG } from "../config.js";
import { readJsonIndex, writeJsonIndex } from "./dedupe.js";

export type SessionSkipReason = "orchestrated" | "subagent" | "helper" | "headless";

export interface CodexSessionPayload {
  session_id?: unknown;
  agent_id?: unknown;
  agent_type?: unknown;
  transcript_path?: unknown;
  hook_event_name?: unknown;
  source?: unknown;
}

interface SessionState {
  at: number;
  source: unknown;
  resumed?: boolean;
}

const ORCHESTRATOR_ENV_VARS = ["CONDUCTOR_WORKSPACE_PATH", "CONDUCTOR_SESSION_ID", "VK_WORKSPACE_ID"];
const META_CHUNK_BYTES = 64 * 1024;
const MAX_META_BYTES = 4 * 1024 * 1024;
const SESSION_STATE_FILE = join(homedir(), ".codex-supermemory", "trackers", "session-sources.json");
const SESSION_STATE_TTL_MS = 30 * 24 * 60 * 60 * 1000;
const MAX_SESSION_STATES = 500;

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

/** Rollout source cached per session; any SessionStart resume marks it interactive because TUI and `codex exec resume` send the same payload. */
function getSessionState(payload: CodexSessionPayload): Omit<SessionState, "at"> {
  const transcriptPath = payload.transcript_path;
  if (typeof transcriptPath !== "string" || !transcriptPath) return { source: undefined };
  const key = createHash("sha256")
    .update(`${String(payload.session_id ?? "")}\n${transcriptPath}`)
    .digest("hex")
    .slice(0, 32);
  const index = readJsonIndex<SessionState>(SESSION_STATE_FILE, SESSION_STATE_TTL_MS);
  const cached = index[key];
  const resumed = payload.hook_event_name === "SessionStart" && payload.source === "resume";
  if (cached && (cached.resumed || !resumed)) return cached;

  const source = cached ? cached.source : readCodexSessionSource(transcriptPath);
  if (source === undefined) return { source };
  index[key] = { at: Date.now(), source, ...(resumed ? { resumed } : {}) };
  writeJsonIndex(SESSION_STATE_FILE, index, MAX_SESSION_STATES);
  return index[key];
}

/** Why a hook must not call Supermemory for this Codex session, or null when it may. */
export function getSessionSkipReason(payload: CodexSessionPayload): SessionSkipReason | null {
  if (!CONFIG.captureSubagents && (payload.agent_id || payload.agent_type)) return "subagent";

  const { source, resumed } = getSessionState(payload);
  if (!CONFIG.captureSubagents && source && typeof source === "object") {
    const subagent = (source as Record<string, unknown>).subagent;
    if (subagent && typeof subagent === "object" && "thread_spawn" in subagent) return "subagent";
    if (subagent !== undefined || "internal" in source) return "helper";
  }
  if (source !== "exec" || resumed) return null;
  if (isOrchestratedSession()) return CONFIG.captureOrchestrated ? null : "orchestrated";
  return CONFIG.captureHeadless ? null : "headless";
}
