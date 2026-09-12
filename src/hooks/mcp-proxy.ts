import { createInterface } from "node:readline";
import { getApiKeyValue } from "../config.js";
import { getProjectTag } from "../services/tags.js";

const MCP_URL =
  process.env.SUPERMEMORY_MCP_URL || "https://mcp.supermemory.ai/mcp";
const REQUEST_TIMEOUT_MS = 30_000;

// Hosted MCP treats a missing containerTag as the user's durable activeSpace,
// which is shared across every MCP client and is not this repo. Hooks already
// read/write the repo tag; inject it on space-scoped tools so MCP hits the
// same container. Leave an explicit containerTag and set-active-tag alone.
const REPO_SCOPED_TOOLS = new Set([
  "search_memory",
  "add_memory",
  "listDocuments",
  "listMemories",
  "memory-graph",
  "fetch-graph-data",
  "save-memory",
]);

let sessionId: string | null = null;

interface JsonRpcMessage {
  id?: string | number | null;
  method?: string;
  params?: unknown;
  [key: string]: unknown;
}

function injectRepoContainerTag(
  message: JsonRpcMessage,
  containerTag: string | null,
): void {
  if (!containerTag || message.method !== "tools/call") return;
  const params = message.params;
  if (!params || typeof params !== "object" || Array.isArray(params)) return;
  const record = params as Record<string, unknown>;
  if (typeof record.name !== "string" || !REPO_SCOPED_TOOLS.has(record.name)) {
    return;
  }

  let args = record.arguments;
  let encoded = false;
  if (args == null) {
    record.arguments = { containerTag };
    return;
  }
  if (typeof args === "string") {
    try {
      args = JSON.parse(args) as unknown;
      encoded = true;
    } catch {
      return;
    }
  }
  if (!args || typeof args !== "object" || Array.isArray(args)) return;
  const body = args as Record<string, unknown>;
  if (typeof body.containerTag === "string" && body.containerTag.trim()) return;

  body.containerTag = containerTag;
  record.arguments = encoded ? JSON.stringify(body) : body;
}

function send(message: unknown): void {
  process.stdout.write(`${JSON.stringify(message)}\n`);
}

function sendError(
  id: JsonRpcMessage["id"],
  code: number,
  message: string,
): void {
  if (id === undefined || id === null) return;
  send({ jsonrpc: "2.0", id, error: { code, message } });
}

function emitSseData(body: string): void {
  for (const event of body.split("\n\n")) {
    for (const line of event.split("\n")) {
      if (!line.startsWith("data:")) continue;
      const data = line.slice(5).trim();
      if (data) process.stdout.write(`${data}\n`);
    }
  }
}

async function forward(message: JsonRpcMessage, apiKey: string): Promise<void> {
  const headers: Record<string, string> = {
    Authorization: `Bearer ${apiKey}`,
    "Content-Type": "application/json",
    Accept: "application/json, text/event-stream",
  };
  if (sessionId) headers["Mcp-Session-Id"] = sessionId;

  const response = await fetch(MCP_URL, {
    method: "POST",
    headers,
    body: JSON.stringify(message),
    signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
  });

  const nextSessionId = response.headers.get("mcp-session-id");
  if (nextSessionId) sessionId = nextSessionId;

  if (response.status === 202) return;
  if (!response.ok) {
    const body = await response.text().catch(() => "");
    sendError(
      message.id,
      -32000,
      `Supermemory MCP ${response.status}: ${body.slice(0, 200) || "request failed"}`,
    );
    return;
  }

  const contentType = response.headers.get("content-type") || "";
  const body = await response.text();
  if (!body.trim()) return;

  if (contentType.includes("text/event-stream")) emitSseData(body);
  else process.stdout.write(`${body.trim()}\n`);
}

function main(): void {
  const apiKey = getApiKeyValue();
  let repoContainerTag: string | null = null;
  try {
    repoContainerTag = getProjectTag(process.cwd());
  } catch {
    repoContainerTag = null;
  }
  let queue = Promise.resolve();
  const lines = createInterface({ input: process.stdin });

  lines.on("line", (line) => {
    if (!line.trim()) return;

    let message: JsonRpcMessage;
    try {
      message = JSON.parse(line) as JsonRpcMessage;
    } catch {
      return;
    }

    queue = queue.then(async () => {
      if (!apiKey) {
        sendError(
          message.id,
          -32001,
          "Supermemory is not authenticated. Start a new Codex task to log in, or set SUPERMEMORY_CODEX_API_KEY.",
        );
        return;
      }

      try {
        injectRepoContainerTag(message, repoContainerTag);
        await forward(message, apiKey);
      } catch (error) {
        const detail = error instanceof Error ? error.message : String(error);
        sendError(message.id, -32000, `Supermemory MCP proxy error: ${detail}`);
      }
    });
  });

  lines.on("close", () => {
    queue.finally(() => process.exit(0));
  });
}

main();
