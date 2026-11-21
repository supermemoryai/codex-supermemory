import {
  closeSync,
  existsSync,
  fstatSync,
  mkdirSync,
  openSync,
  readFileSync,
  readSync,
  renameSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { join } from "node:path";
import { homedir } from "node:os";
import { createHash, randomUUID } from "node:crypto";
import { stripPrivateContent } from "./privacy.js";
import { getLastCapturedIndex } from "./tracker.js";

const SESSION_DIR = join(homedir(), ".codex-supermemory", "session");
const HEAD_BYTES = 4096;

export interface RawDelta {
  raw: string;
  generation: number;
  offset: number;
  commit: () => void;
}

interface SessionCursor {
  offset: number;
  generation: number;
  headHash: string;
  hidden?: boolean;
}

interface RolloutRecord {
  type?: string;
  payload?: {
    type?: string;
    message?: unknown;
    role?: string;
    content?: unknown;
  };
}

function ensureDir(): void {
  if (!existsSync(SESSION_DIR)) mkdirSync(SESSION_DIR, { recursive: true });
}

// Keyed by destination too, so a send accepted by one backend or namespace never hides history from another.
function cursorPath(sessionId: string, destination: string): string {
  const key = createHash("sha256").update(destination).digest("hex").slice(0, 16);
  return join(SESSION_DIR, `${sessionId}.${key}.json`);
}

function atomicWriteJson(path: string, value: SessionCursor): void {
  const tempFile = `${path}.${process.pid}.${randomUUID()}.tmp`;
  try {
    writeFileSync(tempFile, JSON.stringify(value), {
      encoding: "utf-8",
      mode: 0o600,
    });
    renameSync(tempFile, path);
  } catch {
    try {
      unlinkSync(tempFile);
    } catch {}
  }
}

function parseRecord(line: string): RolloutRecord | null {
  try {
    return JSON.parse(line) as RolloutRecord;
  } catch {
    return null;
  }
}

// Without a cursor, start after the line the legacy tracker last captured so migrated sessions are not resent.
function bootstrapOffset(fd: number, size: number, sessionId: string): number {
  const lastIndex = getLastCapturedIndex(sessionId);
  if (lastIndex === null || size === 0) return 0;
  const buf = Buffer.alloc(size);
  readSync(fd, buf, 0, size, 0);
  let start = 0;
  for (let line = 0; start < size; line++) {
    const newline = buf.indexOf(0x0a, start);
    if (newline === -1) break;
    start = newline + 1;
    if (line === lastIndex) return start;
  }
  return 0;
}

function promptText(record: RolloutRecord | null): string | null {
  const payload = record?.payload;
  if (record?.type === "event_msg" && payload?.type === "user_message") {
    return typeof payload.message === "string" ? payload.message : "";
  }
  if (record?.type === "response_item" && payload?.role === "user") {
    if (!Array.isArray(payload.content)) return "";
    return payload.content
      .filter(
        (block): block is { type: string; text: string } =>
          block?.type === "input_text" && typeof block.text === "string",
      )
      .map((block) => block.text)
      .join("");
  }
  return null;
}

function isFullyPrivate(text: string): boolean {
  return text.trim().length > 0 && text.replace(/<private>[\s\S]*?<\/private>/gi, "").trim() === "";
}

function redactPrivate(_key: string, value: unknown): unknown {
  return typeof value === "string" ? stripPrivateContent(value) : value;
}

// Strips <private> blocks and drops every record of a fully private prompt's turn before the bytes leave the machine.
function filterRecords(lines: string[], hidden: boolean): { kept: string[]; hidden: boolean } {
  const kept: string[] = [];
  for (const line of lines) {
    const record = parseRecord(line);
    const prompt = promptText(record);
    if (prompt !== null) hidden = isFullyPrivate(prompt);
    if (hidden) continue;
    kept.push(record ? JSON.stringify(record, redactPrivate) : stripPrivateContent(line));
  }
  return { kept, hidden };
}

function readCursor(
  fd: number,
  size: number,
  sessionId: string,
  destination: string,
): SessionCursor {
  try {
    const cursor = JSON.parse(readFileSync(cursorPath(sessionId, destination), "utf-8")) as {
      offset?: unknown;
      generation?: unknown;
      headHash?: unknown;
      hidden?: unknown;
    };
    if (
      typeof cursor.offset === "number" &&
      typeof cursor.generation === "number"
    ) {
      return {
        offset: cursor.offset,
        generation: cursor.generation,
        headHash: typeof cursor.headHash === "string" ? cursor.headHash : "",
        hidden: cursor.hidden === true,
      };
    }
  } catch {}
  return { offset: bootstrapOffset(fd, size, sessionId), generation: 0, headHash: "" };
}

// Hash of the first `len` bytes. The caller hashes only the already-consumed
// prefix, which is stable while the file is appended to and only changes when
// the file is rewritten or truncated. Hashing the whole head would break append
// detection on small files.
function hashPrefix(fd: number, len: number): string {
  if (len <= 0) return "";
  const buf = Buffer.alloc(len);
  readSync(fd, buf, 0, len, 0);
  return createHash("sha256").update(buf).digest("hex");
}

// Return the rollout bytes appended since the last successful send, cut at the
// last newline so only whole lines go out. A shrunk or rewritten file bumps the
// generation and restarts at offset 0. The cursor advances only when commit()
// runs, so a failed upload re-sends the same bytes on the next call.
export function readRawDelta(
  transcriptPath: string,
  sessionId: string,
  destination: string,
): RawDelta | null {
  if (!existsSync(transcriptPath)) return null;
  ensureDir();
  const fd = openSync(transcriptPath, "r");
  try {
    const size = fstatSync(fd).size;
    const prev = readCursor(fd, size, sessionId, destination);
    let offset = prev.offset;
    let generation = prev.generation;
    let hidden = prev.hidden === true;

    const consumedHead = hashPrefix(fd, Math.min(HEAD_BYTES, prev.offset));
    if (
      size < prev.offset ||
      (prev.headHash && prev.headHash !== consumedHead)
    ) {
      offset = 0;
      generation = prev.generation + 1;
      hidden = false;
    }

    if (size <= offset) return null;
    const len = size - offset;
    const buf = Buffer.alloc(len);
    readSync(fd, buf, 0, len, offset);
    const lastNewline = buf.lastIndexOf(0x0a);
    if (lastNewline === -1) return null;
    const lines = buf
      .subarray(0, lastNewline)
      .toString("utf-8")
      .split("\n")
      .filter((line) => line.trim());
    const filtered = filterRecords(lines, hidden);
    const nextOffset = offset + lastNewline + 1;
    const nextHead = hashPrefix(fd, Math.min(HEAD_BYTES, nextOffset));
    const committedGeneration = generation;

    return {
      raw: filtered.kept.length > 0 ? `${filtered.kept.join("\n")}\n` : "",
      generation,
      offset,
      commit: () =>
        atomicWriteJson(cursorPath(sessionId, destination), {
          offset: nextOffset,
          generation: committedGeneration,
          headHash: nextHead,
          hidden: filtered.hidden,
        }),
    };
  } finally {
    closeSync(fd);
  }
}
