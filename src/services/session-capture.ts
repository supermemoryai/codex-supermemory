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
const MAX_CHUNK_BYTES = 256 * 1024;
const MAX_READ_BYTES = 8 * 1024 * 1024;
const MAX_RECORD_STRING_CHARS = 16 * 1024;
const MAX_SKIPPED_RANGES = 20;

export interface SkippedRange {
  generation: number;
  offset: number;
  end: number;
  reason: string;
}

export interface RawChunk {
  raw: string;
  generation: number;
  offset: number;
  end: number;
  oversizedBytes: number;
  truncatedBytes: number;
  commit: (skipReason?: string) => void;
}

interface SessionCursor {
  offset: number;
  generation: number;
  headHash: string;
  hidden?: boolean;
  skipped?: SkippedRange[];
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
  if (value.skipped?.length === 0) delete value.skipped;
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

function truncateLongStrings(_key: string, value: unknown): unknown {
  if (typeof value !== "string") return value;
  const text = stripPrivateContent(value);
  return text.length > MAX_RECORD_STRING_CHARS
    ? `${text.slice(0, MAX_RECORD_STRING_CHARS)}…[truncated ${text.length - MAX_RECORD_STRING_CHARS} chars]`
    : text;
}

// Strips <private> blocks, drops a fully private prompt's turn (null), and cuts long strings in a record too big for one request.
function filterRecord(line: string, state: { hidden: boolean }): { text: string; truncatedBytes: number } | null {
  const record = parseRecord(line);
  const prompt = promptText(record);
  if (prompt !== null) state.hidden = isFullyPrivate(prompt);
  if (state.hidden) return null;
  if (!record) return { text: stripPrivateContent(line), truncatedBytes: 0 };
  const kept = JSON.stringify(record, redactPrivate);
  const keptBytes = Buffer.byteLength(kept);
  if (keptBytes <= MAX_CHUNK_BYTES) return { text: kept, truncatedBytes: 0 };
  const text = JSON.stringify(record, truncateLongStrings);
  return { text, truncatedBytes: keptBytes - Buffer.byteLength(text) };
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
      skipped?: unknown;
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
        skipped: Array.isArray(cursor.skipped) ? cursor.skipped as SkippedRange[] : [],
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

function findNewline(fd: number, from: number, size: number): number {
  const block = Buffer.alloc(64 * 1024);
  for (let position = from; position < size; position += block.length) {
    const read = readSync(fd, block, 0, Math.min(block.length, size - position), position);
    const index = block.subarray(0, read).indexOf(0x0a);
    if (index !== -1) return position + index;
  }
  return -1;
}

// Splits the bytes appended since the last accepted send into whole-line chunks, reading at most MAX_READ_BYTES per call, so an outage or one huge turn never builds a request the server can't take.
export function readRawChunks(
  transcriptPath: string,
  sessionId: string,
  destination: string,
): RawChunk[] {
  if (!existsSync(transcriptPath)) return [];
  ensureDir();
  const fd = openSync(transcriptPath, "r");
  try {
    const size = fstatSync(fd).size;
    const prev = readCursor(fd, size, sessionId, destination);
    let offset = prev.offset;
    let generation = prev.generation;
    const state = { hidden: prev.hidden === true };
    const skipped = [...(prev.skipped ?? [])];

    const consumedHead = hashPrefix(fd, Math.min(HEAD_BYTES, prev.offset));
    if (
      size < prev.offset ||
      (prev.headHash && prev.headHash !== consumedHead)
    ) {
      offset = 0;
      generation = prev.generation + 1;
      state.hidden = false;
    }

    if (size <= offset) return [];
    const len = Math.min(size - offset, MAX_READ_BYTES);
    const buf = Buffer.alloc(len);
    readSync(fd, buf, 0, len, offset);
    const cursorFile = cursorPath(sessionId, destination);
    const chunks: RawChunk[] = [];
    const pushChunk = (start: number, end: number, lines: string[], hidden: boolean, truncatedBytes = 0, oversizedBytes = 0) => {
      const headHash = hashPrefix(fd, Math.min(HEAD_BYTES, end));
      chunks.push({
        raw: lines.length > 0 ? `${lines.join("\n")}\n` : "",
        generation,
        offset: start,
        end,
        oversizedBytes,
        truncatedBytes,
        commit: (skipReason) => {
          if (skipReason) {
            skipped.push({ generation, offset: start, end, reason: skipReason });
            skipped.splice(0, Math.max(0, skipped.length - MAX_SKIPPED_RANGES));
          }
          atomicWriteJson(cursorFile, { offset: end, generation, headHash, hidden, skipped });
        },
      });
    };

    const lastNewline = buf.lastIndexOf(0x0a);
    if (lastNewline === -1) {
      if (len < MAX_READ_BYTES) return [];
      const lineEnd = findNewline(fd, offset + len, size);
      if (lineEnd !== -1) pushChunk(offset, lineEnd + 1, [], state.hidden, 0, lineEnd + 1 - offset);
      return chunks;
    }

    let chunkStart = offset;
    let chunkLines: string[] = [];
    let chunkBytes = 0;
    let chunkTruncated = 0;
    for (let lineStart = 0; lineStart <= lastNewline;) {
      const newline = buf.indexOf(0x0a, lineStart);
      const lineOffset = offset + lineStart;
      const line = buf.subarray(lineStart, newline).toString("utf-8");
      lineStart = newline + 1;
      const hiddenBefore = state.hidden;
      const kept = line.trim() ? filterRecord(line, state) : null;
      if (kept === null) continue;
      const keptBytes = Buffer.byteLength(kept.text) + 1;
      if (chunkLines.length > 0 && chunkBytes + keptBytes > MAX_CHUNK_BYTES) {
        pushChunk(chunkStart, lineOffset, chunkLines, hiddenBefore, chunkTruncated);
        chunkStart = lineOffset;
        chunkLines = [];
        chunkBytes = 0;
        chunkTruncated = 0;
      }
      chunkLines.push(kept.text);
      chunkBytes += keptBytes;
      chunkTruncated += kept.truncatedBytes;
    }
    pushChunk(chunkStart, offset + lastNewline + 1, chunkLines, state.hidden, chunkTruncated);
    return chunks;
  } finally {
    closeSync(fd);
  }
}
