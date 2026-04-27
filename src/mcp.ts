import { createInterface } from "node:readline";
import { SupermemoryClient } from "./services/client.js";
import { getTags } from "./services/tags.js";
import { stripPrivateContent } from "./services/privacy.js";
import { isConfigured } from "./config.js";
import { log } from "./services/logger.js";

interface JsonRpcRequest {
  jsonrpc: "2.0";
  id: string | number | null;
  method: string;
  params?: unknown;
}

interface JsonRpcNotification {
  jsonrpc: "2.0";
  method: string;
  params?: unknown;
}

type IncomingMessage = JsonRpcRequest | JsonRpcNotification;

function isRequest(msg: IncomingMessage): msg is JsonRpcRequest {
  return "id" in msg;
}

function send(msg: object): void {
  process.stdout.write(JSON.stringify(msg) + "\n");
}

function respond(id: string | number | null, result: unknown): void {
  send({ jsonrpc: "2.0", id, result });
}

function rpcError(id: string | number | null, code: number, message: string): void {
  send({ jsonrpc: "2.0", id, error: { code, message } });
}

const TOOLS = [
  {
    name: "memory",
    description:
      "Save a new memory or forget an existing one. " +
      "Use mode='add' with content to save; mode='forget' with memoryId to delete.",
    inputSchema: {
      type: "object",
      properties: {
        mode: {
          type: "string",
          enum: ["add", "forget"],
          description: "add: save a new memory; forget: delete by ID",
        },
        content: { type: "string", description: "Content to save (required for add)" },
        memoryId: { type: "string", description: "Memory ID to delete (required for forget)" },
        scope: {
          type: "string",
          enum: ["user", "project"],
          description: "user: cross-project memories; project: current project only (default)",
        },
      },
      required: ["mode"],
    },
  },
  {
    name: "recall",
    description: "Search memories by natural-language query.",
    inputSchema: {
      type: "object",
      properties: {
        query: { type: "string", description: "Natural-language search query" },
        scope: {
          type: "string",
          enum: ["user", "project", "both"],
          description: "Scope to search (default: both)",
        },
      },
      required: ["query"],
    },
  },
  {
    name: "listProjects",
    description: "List recent memories in the current project or user scope.",
    inputSchema: {
      type: "object",
      properties: {
        scope: {
          type: "string",
          enum: ["user", "project"],
          description: "Scope to list (default: project)",
        },
        limit: { type: "number", description: "Max results to return (default: 20)" },
      },
    },
  },
];

const cwd = process.cwd();
const tags = getTags(cwd);
const client = new SupermemoryClient();

async function executeTool(name: string, args: Record<string, unknown>): Promise<string> {
  if (!isConfigured()) {
    return JSON.stringify({
      success: false,
      error: "SUPERMEMORY_CODEX_API_KEY is not set. Export it and restart Codex.",
    });
  }

  log("mcp: tool call", { name, args });

  try {
    switch (name) {
      case "memory": {
        const mode = args.mode as string;
        const scope = (args.scope as string) ?? "project";
        const containerTag = scope === "user" ? tags.user : tags.project;

        if (mode === "add") {
          if (!args.content) {
            return JSON.stringify({ success: false, error: "content is required for add" });
          }
          const content = stripPrivateContent(String(args.content));
          const result = await client.addMemory(content, containerTag);
          if (!result.success) return JSON.stringify({ success: false, error: result.error });
          return JSON.stringify({ success: true, id: result.id, scope, message: "Memory saved." });
        }

        if (mode === "forget") {
          if (!args.memoryId) {
            return JSON.stringify({ success: false, error: "memoryId is required for forget" });
          }
          const result = await client.deleteMemory(String(args.memoryId));
          if (!result.success) return JSON.stringify({ success: false, error: result.error });
          return JSON.stringify({ success: true, message: `Memory ${args.memoryId} forgotten.` });
        }

        return JSON.stringify({ success: false, error: `Unknown mode: ${mode}. Use add or forget.` });
      }

      case "recall": {
        if (!args.query) {
          return JSON.stringify({ success: false, error: "query is required" });
        }
        const query = String(args.query);
        const scope = (args.scope as string) ?? "both";

        const [userResult, projectResult] = await Promise.all([
          scope !== "project"
            ? client.searchMemories(query, tags.user)
            : Promise.resolve({ success: false as const, results: [], total: 0, timing: 0, error: "" }),
          scope !== "user"
            ? client.searchMemories(query, tags.project)
            : Promise.resolve({ success: false as const, results: [], total: 0, timing: 0, error: "" }),
        ]);

        const combined = [
          ...(userResult.results ?? []).map((r) => ({ ...r, scope: "user" as const })),
          ...(projectResult.results ?? []).map((r) => ({ ...r, scope: "project" as const })),
        ].sort((a, b) => ((b as { similarity?: number }).similarity ?? 0) - ((a as { similarity?: number }).similarity ?? 0));

        return JSON.stringify({
          success: true,
          count: combined.length,
          results: combined.slice(0, 10).map((r) => ({
            id: (r as { id?: string }).id,
            content: (r as { memory?: string; chunk?: string; content?: string }).memory
              ?? (r as { chunk?: string }).chunk
              ?? (r as { content?: string }).content
              ?? "",
            similarity: Math.round(((r as { similarity?: number }).similarity ?? 0) * 100),
            scope: r.scope,
          })),
        });
      }

      case "listProjects": {
        const scope = (args.scope as string) ?? "project";
        const limit = typeof args.limit === "number" ? args.limit : 20;
        const containerTag = scope === "user" ? tags.user : tags.project;

        const result = await client.listMemories(containerTag, limit);
        if (!result.success) return JSON.stringify({ success: false, error: result.error });

        return JSON.stringify({
          success: true,
          scope,
          count: result.memories.length,
          memories: result.memories.map((m) => ({
            id: m.id,
            content: m.summary ?? m.content ?? "",
            createdAt: m.createdAt,
          })),
        });
      }

      default:
        return JSON.stringify({ success: false, error: `Unknown tool: ${name}` });
    }
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    log("mcp: tool error", { name, error: message });
    return JSON.stringify({ success: false, error: message });
  }
}

async function main() {
  log("mcp: server started", { cwd, configured: isConfigured() });

  const rl = createInterface({ input: process.stdin, crlfDelay: Infinity });

  let inflight = 0;
  let closing = false;

  function maybeExit() {
    if (closing && inflight === 0) process.exit(0);
  }

  rl.on("line", async (line) => {
    const trimmed = line.trim();
    if (!trimmed) return;

    let msg: IncomingMessage;
    try {
      msg = JSON.parse(trimmed) as IncomingMessage;
    } catch {
      send({ jsonrpc: "2.0", id: null, error: { code: -32700, message: "Parse error" } });
      return;
    }

    // Notifications have no id — no response needed
    if (!isRequest(msg)) return;

    const { id, method } = msg;

    inflight++;
    try {
      switch (method) {
        case "initialize":
          respond(id, {
            protocolVersion: "2024-11-05",
            capabilities: { tools: {} },
            serverInfo: { name: "supermemory", version: "1.0.0" },
          });
          break;

        case "ping":
          respond(id, {});
          break;

        case "tools/list":
          respond(id, { tools: TOOLS });
          break;

        case "tools/call": {
          const params = msg.params as { name?: string; arguments?: Record<string, unknown> } | undefined;
          if (!params?.name) {
            rpcError(id, -32602, "Missing tool name");
            break;
          }
          const text = await executeTool(params.name, params.arguments ?? {});
          respond(id, { content: [{ type: "text", text }] });
          break;
        }

        default:
          rpcError(id, -32601, `Method not found: ${method}`);
      }
    } finally {
      inflight--;
      maybeExit();
    }
  });

  rl.on("close", () => {
    log("mcp: stdin closed");
    closing = true;
    maybeExit();
  });
}

main().catch((err) => {
  process.stderr.write(`supermemory mcp fatal: ${String(err)}\n`);
  process.exit(1);
});
