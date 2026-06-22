import Supermemory from "supermemory";
import { CONFIG, isConfigured, getApiKeyValue, getBaseUrl, PLUGIN_VERSION } from "../config.js";
import { log } from "./logger.js";
import type { MemoryType } from "../types/index.js";

const TIMEOUT_MS = 30000;
const SPACE_NAME_TIMEOUT_MS = 5000;
const CODEX_SOURCE = "codex";

function withTimeout<T>(promise: Promise<T>, ms: number): Promise<T> {
  let id: ReturnType<typeof setTimeout>;
  const timeout = new Promise<T>((_, reject) => {
    id = setTimeout(() => reject(new Error(`Timeout after ${ms}ms`)), ms);
  });
  return Promise.race([promise, timeout]).finally(() => clearTimeout(id));
}

/** Canonical search result item used across the codebase. */
export interface SearchResultItem {
  id?: string;
  memory?: string;
  content?: string;
  chunk?: string;
  context?: unknown;
  score?: number;
  similarity?: number;
  title?: string;
  updatedAt?: string;
  metadata?: Record<string, unknown> | null;
}

/** Response shape returned by search APIs. */
export interface SearchResponse {
  success: boolean;
  results?: SearchResultItem[];
  total?: number;
  timing?: number;
  error?: string;
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

export const USER_ENTITY_CONTEXT = `Developer coding session transcript for a persistent user profile.

EXTRACT:
- User preferences: preferred languages, frameworks, libraries, editors, workflows, and communication style
- Stable habits: testing style, code review expectations, formatting preferences, privacy preferences
- Repeated personal decisions: tools the user consistently chooses or avoids
- Long-lived learnings: concepts the user learned or wants remembered across projects

SKIP:
- Project-specific architecture unless it reflects a durable user preference
- One-off assistant suggestions the user did not accept
- Low-level implementation details that only matter inside the current repository`;

export const PROJECT_ENTITY_CONTEXT = `Project/codebase knowledge from Codex coding sessions.

EXTRACT:
- Architecture: repo structure, services, modules, data flow, and integration boundaries
- Conventions: naming, component patterns, API patterns, testing practices, and style rules
- Decisions: chosen approaches, tradeoffs, migrations, and rejected alternatives
- Setup: commands, environment requirements, deployment notes, and debugging workflows
- Implementation lessons: bugs fixed, root causes, and reusable project-specific context

SKIP:
- Generic user preferences that are not specific to this project
- Verbatim assistant explanations unless they became an accepted project decision
- Transient command output with no lasting project value`;

export class SupermemoryClient {
  private client: Supermemory | null = null;

  private getClient(): Supermemory {
    if (!this.client) {
      if (!isConfigured()) {
        throw new Error("SUPERMEMORY_API_KEY not set");
      }
      // `x-sm-source` is read by mono's API to attribute searches and
      // writes to the Codex plugin in PostHog / `document.source`.
      this.client = new Supermemory({
        apiKey: getApiKeyValue(),
        baseURL: getBaseUrl(),
        defaultHeaders: { "x-sm-source": CODEX_SOURCE },
      });
    }
    return this.client;
  }

  /**
   * Get user profile with embedded search results from a single container.
   * The recall hook pairs this with a separate `searchMemories()` call to
   * the project container so both user and project memories are surfaced.
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
          memory: r.memory || r.content || String(r.context ?? ""),
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

  async searchMemories(query: string, containerTag: string): Promise<SearchResponse> {
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
      return { success: true, results: result.results as SearchResultItem[], total: result.total, timing: result.timing };
    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : String(error);
      log("searchMemories: error", { error: errorMessage });
      return { success: false, error: errorMessage, results: [], total: 0, timing: 0 };
    }
  }

  async searchMemoriesAcrossContainers(query: string, containerTags: string[]): Promise<SearchResponse> {
    const uniqueTags = [...new Set(containerTags)].filter((tag) => tag.length > 0);
    log("searchMemoriesAcrossContainers: start", { containerTags: uniqueTags });

    if (uniqueTags.length === 0) {
      return { success: false, error: "At least one containerTag is required", results: [], total: 0, timing: 0 };
    }

    const results = await Promise.all(
      uniqueTags.map((tag) => this.searchMemories(query, tag))
    );
    const successes = results.filter((result) => result.success);

    if (successes.length === 0) {
      return {
        success: false,
        error: results.find((result) => result.error)?.error ?? "Failed to search memories",
        results: [],
        total: 0,
        timing: 0,
      };
    }

    const seen = new Set<string>();
    const merged: SearchResultItem[] = [];

    for (const result of successes) {
      for (const item of result.results ?? []) {
        const text = item.memory ?? item.chunk ?? item.content ?? String(item.context ?? "");
        const key = item.id ? `id:${item.id}` : `content:${text.toLowerCase().trim()}`;
        if (!key || seen.has(key)) continue;
        seen.add(key);
        merged.push(item);
      }
    }

    log("searchMemoriesAcrossContainers: success", {
      containerCount: uniqueTags.length,
      resultCount: merged.length,
    });

    return {
      success: true,
      results: merged,
      total: merged.length,
      timing: successes.reduce((sum, result) => sum + (result.timing ?? 0), 0),
    };
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
    options?: { customId?: string; entityContext?: string }
  ) {
    log("addMemory: start", {
      containerTag,
      contentLength: content.length,
      customId: options?.customId,
      hasEntityContext: !!options?.entityContext,
    });
    try {
      // Always stamp `sm_source` so mono's `document.source` column attributes
      // these writes to the Codex plugin. Caller-provided metadata wins on
      // conflicts so a tool can override the source if it ever needs to.
      const mergedMetadata = {
        sm_source: CODEX_SOURCE,
        sm_client: CODEX_SOURCE,
        sm_plugin_version: PLUGIN_VERSION,
        ...(metadata ?? {}),
      } as Record<string, string | number | boolean | string[]>;

      const payload: {
        content: string;
        containerTag: string;
        metadata?: Record<string, string | number | boolean | string[]>;
        customId?: string;
        entityContext?: string;
      } = {
        content,
        containerTag,
        metadata: mergedMetadata,
      };
      if (options?.customId) {
        payload.customId = options.customId;
      }
      if (options?.entityContext) {
        payload.entityContext = options.entityContext;
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

  async updateContainerTagName(containerTag: string, name: string) {
    log("updateContainerTagName: start", { containerTag, name });
    try {
      const baseUrl = getBaseUrl();
      const currentResponse = await withTimeout(
        fetch(`${baseUrl}/v3/container-tags/${encodeURIComponent(containerTag)}`, {
          headers: {
            Authorization: `Bearer ${getApiKeyValue()}`,
          },
        }),
        SPACE_NAME_TIMEOUT_MS
      );

      if (!currentResponse.ok) {
        log("updateContainerTagName: skipped", {
          containerTag,
          status: currentResponse.status,
        });
        return { success: false as const, error: `HTTP ${currentResponse.status}` };
      }

      const current = (await currentResponse.json()) as { name?: string | null };
      const currentName = current.name?.trim();
      if (
        currentName &&
        currentName !== `Space ${containerTag}` &&
        !currentName.startsWith("Codex · ")
      ) {
        log("updateContainerTagName: kept custom name", { containerTag, currentName });
        return { success: true as const };
      }

      if (currentName === name) {
        return { success: true as const };
      }

      const response = await withTimeout(
        fetch(`${baseUrl}/v3/container-tags/${encodeURIComponent(containerTag)}`, {
          method: "PATCH",
          headers: {
            Authorization: `Bearer ${getApiKeyValue()}`,
            "Content-Type": "application/json",
          },
          body: JSON.stringify({ name }),
        }),
        SPACE_NAME_TIMEOUT_MS
      );

      if (!response.ok) {
        log("updateContainerTagName: skipped", {
          containerTag,
          status: response.status,
        });
        return { success: false as const, error: `HTTP ${response.status}` };
      }

      log("updateContainerTagName: success", { containerTag, name });
      return { success: true as const };
    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : String(error);
      log("updateContainerTagName: error", { containerTag, error: errorMessage });
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
