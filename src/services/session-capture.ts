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
}

function ensureDir(): void {
  if (!existsSync(SESSION_DIR)) mkdirSync(SESSION_DIR, { recursive: true });
}

function cursorPath(sessionId: string): string {
  return join(SESSION_DIR, `${sessionId}.json`);
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

function readCursor(sessionId: string): SessionCursor {
  try {
    const cursor = JSON.parse(readFileSync(cursorPath(sessionId), "utf-8")) as {
      offset?: unknown;
      generation?: unknown;
      headHash?: unknown;
    };
    if (
      typeof cursor.offset === "number" &&
      typeof cursor.generation === "number"
    ) {
      return {
        offset: cursor.offset,
        generation: cursor.generation,
        headHash: typeof cursor.headHash === "string" ? cursor.headHash : "",
      };
    }
  } catch {}
  return { offset: 0, generation: 0, headHash: "" };
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
): RawDelta | null {
  if (!existsSync(transcriptPath)) return null;
  ensureDir();
  const prev = readCursor(sessionId);
  const fd = openSync(transcriptPath, "r");
  try {
    const size = fstatSync(fd).size;
    let offset = prev.offset;
    let generation = prev.generation;

    const consumedHead = hashPrefix(fd, Math.min(HEAD_BYTES, prev.offset));
    if (
      size < prev.offset ||
      (prev.headHash && prev.headHash !== consumedHead)
    ) {
      offset = 0;
      generation = prev.generation + 1;
    }

    if (size <= offset) return null;
    const len = size - offset;
    const buf = Buffer.alloc(len);
    readSync(fd, buf, 0, len, offset);
    const lastNewline = buf.lastIndexOf(0x0a);
    if (lastNewline === -1) return null;
    const raw = buf.subarray(0, lastNewline + 1).toString("utf-8");
    const nextOffset = offset + lastNewline + 1;
    const nextHead = hashPrefix(fd, Math.min(HEAD_BYTES, nextOffset));
    const committedGeneration = generation;

    return {
      raw,
      generation,
      offset,
      commit: () =>
        atomicWriteJson(cursorPath(sessionId), {
          offset: nextOffset,
          generation: committedGeneration,
          headHash: nextHead,
        }),
    };
  } finally {
    closeSync(fd);
  }
}
