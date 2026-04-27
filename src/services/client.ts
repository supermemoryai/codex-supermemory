import Supermemory from "supermemory";
import { CONFIG, SUPERMEMORY_API_KEY, isConfigured } from "../config.js";
import { log } from "./logger.js";
import type {
  ConversationIngestResponse,
  ConversationMessage,
  MemoryType,
} from "../types/index.js";

const TIMEOUT_MS = 30000;

const CODEX_ENTITY_CONTEXT = `Developer coding session transcript. Focus on USER message and intent.

RULES:
- Extract USER's action/intent, not every detail assistant provides matter
- Condense assistant responses into what user gained from it
- Skip granular facts from assistant output

EXTRACT:
- Research: "researched whisper.cpp for speech recognition"
- Actions: "built auth flow with JWT", "fixed memory leak in useEffect"
- Preferences: "prefers Tailwind over CSS modules"
- Decisions: "chose SQLite for local storage"
- Learnings: "learned about React Server Components"

EXAMPLES:
| Transcript | Memory |
| [role:user] research about the whisper.cpp -> https://github.com/ggml-org/whisper.cpp/blob/master/src/whisper.cpp [user:end]| "<User> starts research about whisper.cpp" |
| [role:assistant] ## whisper.cpp Architecture Summary \n This is highly relevant for your parakeet.cpp implementation. Here are the key patterns: \n ### Core Architecture \n **Two-level context design:**\n - whisper_context - holds model weights, vocab, hyperparameters (persistent) \n - whisper_state - runtime state, KV caches, backends (can have multiple per context) [assistant:end] | "Assistant did a deep dive on whisper architecture" |
| [role:user] Can we explain what we are currently doing in this repository? [user:end] | "<Multiple comprehensive memories using assistant reponse>" |

SKIP:
- Every fact assistant mentions (condense to user's action)
- Generic assistant explanations user didn't confirm/use`;
const MAX_CONVERSATION_CHARS = 100_000;

function withTimeout<T>(promise: Promise<T>, ms: number): Promise<T> {
  let id: ReturnType<typeof setTimeout>;
  const timeout = new Promise<T>((_, reject) => {
    id = setTimeout(() => reject(new Error(`Timeout after ${ms}ms`)), ms);
  });
  return Promise.race([promise, timeout]).finally(() => clearTimeout(id));
}

export class SupermemoryClient {
  private client: Supermemory | null = null;

  private formatConversationMessage(message: ConversationMessage): string {
    const content =
      typeof message.content === "string"
        ? message.content
        : message.content
            .map((part) =>
              part.type === "text"
                ? part.text
                : `[image] ${part.imageUrl.url}`
            )
            .join("\n");

    const trimmed = content.trim();
    if (trimmed.length === 0) {
      return `[${message.role}]`;
    }
    return `[${message.role}] ${trimmed}`;
  }

  private formatConversationTranscript(messages: ConversationMessage[]): string {
    return messages
      .map((message, idx) => `${idx + 1}. ${this.formatConversationMessage(message)}`)
      .join("\n");
  }

  private getClient(): Supermemory {
    if (!this.client) {
      if (!isConfigured()) {
        throw new Error("SUPERMEMORY_API_KEY not set");
      }
      this.client = new Supermemory({ apiKey: SUPERMEMORY_API_KEY });
    }
    return this.client;
  }

  async searchMemories(query: string, containerTag: string) {
    log("searchMemories: start", { containerTag });
    try {
      const result = await withTimeout(
        this.getClient().search.memories({
          q: query,
          containerTag,
          threshold: CONFIG.similarityThreshold,
          limit: CONFIG.maxMemories,
          searchMode: "hybrid",
        }),
        TIMEOUT_MS
      );
      log("searchMemories: success", { count: result.results?.length || 0 });
      return { success: true as const, ...result };
    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : String(error);
      log("searchMemories: error", { error: errorMessage });
      return { success: false as const, error: errorMessage, results: [], total: 0, timing: 0 };
    }
  }

  async getProfile(containerTag: string, query?: string) {
    log("getProfile: start", { containerTag });
    try {
      const result = await withTimeout(
        this.getClient().profile({
          containerTag,
          q: query,
        }),
        TIMEOUT_MS
      );
      log("getProfile: success", { hasProfile: !!result?.profile });
      return { success: true as const, ...result };
    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : String(error);
      log("getProfile: error", { error: errorMessage });
      return { success: false as const, error: errorMessage, profile: null };
    }
  }

  async addMemory(
    content: string,
    containerTag: string,
    metadata?: { type?: MemoryType; tool?: string; [key: string]: unknown },
    entityContext = CODEX_ENTITY_CONTEXT
  ) {
    log("addMemory: start", { containerTag, contentLength: content.length });
    try {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const payload: any = {
        content,
        containerTag,
        metadata: metadata as Record<string, string | number | boolean | string[]>,
        entityContext,
      };
      const result = await withTimeout(
        this.getClient().memories.add(payload),
        TIMEOUT_MS
      );
      log("addMemory: success", { id: result.id });
      return { success: true as const, ...result };
    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : String(error);
      log("addMemory: error", { error: errorMessage });
      return { success: false as const, error: errorMessage };
    }
  }

  async deleteMemory(memoryId: string) {
    log("deleteMemory: start", { memoryId });
    try {
      await withTimeout(this.getClient().memories.delete(memoryId), TIMEOUT_MS);
      log("deleteMemory: success", { memoryId });
      return { success: true as const };
    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : String(error);
      log("deleteMemory: error", { memoryId, error: errorMessage });
      return { success: false as const, error: errorMessage };
    }
  }

  async listMemories(containerTag: string, limit = 20) {
    log("listMemories: start", { containerTag, limit });
    try {
      const result = await withTimeout(
        this.getClient().memories.list({
          containerTags: [containerTag],
          limit,
          order: "desc",
          sort: "createdAt",
          includeContent: true,
        }),
        TIMEOUT_MS
      );
      log("listMemories: success", { count: result.memories?.length ?? 0 });
      return { success: true as const, memories: (result.memories ?? []) as Array<{ id: string; summary?: string; content?: string; createdAt?: string }> };
    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : String(error);
      log("listMemories: error", { error: errorMessage });
      return { success: false as const, error: errorMessage, memories: [] };
    }
  }

  async ingestConversation(
    conversationId: string,
    messages: ConversationMessage[],
    containerTags: string[],
    metadata?: Record<string, string | number | boolean>
  ) {
    log("ingestConversation: start", {
      conversationId,
      messageCount: messages.length,
      containerTags,
    });

    if (messages.length === 0) {
      return { success: false as const, error: "No messages to ingest" };
    }

    const uniqueTags = [...new Set(containerTags)].filter((tag) => tag.length > 0);
    if (uniqueTags.length === 0) {
      return { success: false as const, error: "At least one containerTag is required" };
    }

    const transcript = this.formatConversationTranscript(messages);
    const rawContent = `[Conversation ${conversationId}]\n${transcript}`;
    const content =
      rawContent.length > MAX_CONVERSATION_CHARS
        ? `${rawContent.slice(0, MAX_CONVERSATION_CHARS)}\n...[truncated]`
        : rawContent;

    const ingestMetadata = {
      type: "conversation" as const,
      conversationId,
      messageCount: messages.length,
      originalContainerTags: uniqueTags,
      ...metadata,
    };

    const savedIds: string[] = [];
    let firstError: string | null = null;

    for (const tag of uniqueTags) {
      const result = await this.addMemory(content, tag, ingestMetadata);
      if (result.success) {
        savedIds.push(result.id);
      } else if (!firstError) {
        firstError = result.error || "Failed to store conversation";
      }
    }

    if (savedIds.length === 0) {
      log("ingestConversation: error", { conversationId, error: firstError });
      return {
        success: false as const,
        error: firstError || "Failed to ingest conversation",
      };
    }

    const status =
      savedIds.length === uniqueTags.length ? "stored" : "partial";
    const response: ConversationIngestResponse = {
      id: savedIds[0]!,
      conversationId,
      status,
    };

    log("ingestConversation: success", {
      conversationId,
      status,
      storedCount: savedIds.length,
      requestedCount: uniqueTags.length,
    });

    return {
      success: true as const,
      ...response,
      storedMemoryIds: savedIds,
    };
  }
}
