export interface MemoryTextShape {
  memory?: unknown;
  chunk?: unknown;
  content?: unknown;
  text?: unknown;
  context?: unknown;
  title?: unknown;
  filepath?: unknown;
  filePath?: unknown;
  path?: unknown;
  metadata?: unknown;
}

export const RECALL_MIN_SIMILARITY = 0.55;

/** Return only a real string field; never stringify objects as `[object Object]`. */
export function memoryText(result: MemoryTextShape): string {
  for (const value of [
    result.memory,
    result.chunk,
    result.content,
    result.text,
    result.context,
  ]) {
    if (typeof value === "string" && value.trim()) return value.trim();
  }
  return "";
}

function stringValue(...values: unknown[]): string | undefined {
  const value = values.find(
    (candidate) => typeof candidate === "string" && candidate.trim().length > 0,
  );
  return typeof value === "string" ? value.trim() : undefined;
}

export function recallProvenance(
  result: MemoryTextShape,
): { title?: string; filepath?: string } {
  const metadata =
    result.metadata && typeof result.metadata === "object"
      ? result.metadata as Record<string, unknown>
      : {};
  return {
    title: stringValue(result.title, metadata.title),
    filepath: stringValue(
      result.filepath,
      result.filePath,
      result.path,
      metadata.filepath,
      metadata.filePath,
      metadata.path,
    ),
  };
}
