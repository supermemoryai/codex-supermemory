import Supermemory from "supermemory";
import { CONFIG, isConfigured, getApiKeyValue } from "../config.js";
import { log } from "./logger.js";
import type { MemoryType } from "../types/index.js";

const TIMEOUT_MS = 30000;

function withTimeout<T>(promise: Promise<T>, ms: number): Promise<T> {
  let id: ReturnType<typeof setTimeout>;
  const timeout = new Promise<T>((_, reject) => {
    id = setTimeout(() => reject(new Error(`Timeout after ${ms}ms`)), ms);
  });
  return Promise.race([promise, timeout]).finally(() => clearTimeout(id));
}

interface SearchResultItem {
  id?: string;
  memory?: string;
  content?: string;
  context?: string;
  similarity?: number;
  title?: string;
  updatedAt?: string;
}

export interface ProfileWithSearchResult {
  success: boolean;
  profile: {
    static: string[];
    dynamic: string[];
  } | null;
  searchResults?: {
    results: Array<{
      id?: string;
      memory: string;
      similarity?: number;
      title?: string;
      updatedAt?: string;
    }>;
    total: number;
    timing?: number;
  };
  error?: string;
}

export class SupermemoryClient {
  private client: Supermemory | null = null;

  private getClient(): Supermemory {
    if (!this.client) {
      if (!isConfigured()) {
        throw new Error("SUPERMEMORY_API_KEY not set");
      }
      this.client = new Supermemory({ apiKey: getApiKeyValue() });
    }
    return this.client;
  }

  /**
   * Get profile with embedded search results - single API call.
   * This is the preferred method matching Claude's approach.
   */
  async getProfileWithSearch(containerTag: string, query?: string): Promise<ProfileWithSearchResult> {
    log("getProfileWithSearch: start", { containerTag, hasQuery: !!query });
    try {
      const result = await withTimeout(
        this.getClient().profile({
          containerTag,
          q: query,
        }),
        TIMEOUT_MS
      );

      // Dedupe across static, dynamic, and search results
      const seen = new Set<string>();
      const dedupeWithSeen = <T>(items: T[], getKey: (item: T) => string = (x) => String(x)): T[] =>
        items.filter((item) => {
          const key = getKey(item).toLowerCase().trim();
          if (!key || seen.has(key)) return false;
          seen.add(key);
          return true;
        });

      const staticFacts = dedupeWithSeen(result.profile?.static || [], (x) => x);
      const dynamicFacts = dedupeWithSeen(result.profile?.dynamic || [], (x) => x);

      let searchResults: ProfileWithSearchResult["searchResults"];
      if (result.searchResults) {
        const mapped = (result.searchResults.results as SearchResultItem[]).map((r) => ({
          id: r.id,
          memory: r.memory || r.content || r.context || "",
          similarity: r.similarity,
          title: r.title,
          updatedAt: r.updatedAt,
        }));
        searchResults = {
          results: dedupeWithSeen(mapped, (r) => r.memory),
          total: result.searchResults.total,
          timing: result.searchResults.timing,
        };
      }

      log("getProfileWithSearch: success", {
        staticCount: staticFacts.length,
        dynamicCount: dynamicFacts.length,
        searchCount: searchResults?.results.length || 0,
      });

      return {
        success: true,
        profile: { static: staticFacts, dynamic: dynamicFacts },
        searchResults,
      };
    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : String(error);
      log("getProfileWithSearch: error", { error: errorMessage });
      return { success: false, error: errorMessage, profile: null };
    }
  }

  // Keep old methods for backward compatibility

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
    options?: { customId?: string }
  ) {
    log("addMemory: start", { containerTag, contentLength: content.length, customId: options?.customId });
    try {
      const payload: {
        content: string;
        containerTag: string;
        metadata?: Record<string, string | number | boolean | string[]>;
        customId?: string;
      } = {
        content,
        containerTag,
        metadata: metadata as Record<string, string | number | boolean | string[]>,
      };
      if (options?.customId) {
        payload.customId = options.customId;
      }
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

  async forgetMemory(content: string, containerTag: string): Promise<{ success: true; message: string; id?: string } | { success: false; error: string }> {
    log("forgetMemory: start", { containerTag, contentLength: content.length });
    try {
      const result = await withTimeout(
        this.getClient().memories.forget({ containerTag, content }),
        TIMEOUT_MS
      );
      log("forgetMemory: success", { id: result.id });
      return { success: true, message: "Memory forgotten", id: result.id };
    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : String(error);
      log("forgetMemory: error", { error: errorMessage });
      return { success: false, error: errorMessage };
    }
  }

}
