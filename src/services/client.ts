import Supermemory from "supermemory";
import type { ProfileParams } from "supermemory/resources/top-level.js";
import { CONFIG, isConfigured, getApiKeyValue, getBaseUrl, PLUGIN_VERSION } from "../config.js";
import { log } from "./logger.js";
import type { MemoryType } from "../types/index.js";
import { mergeProfileResults, mergeSearchResponses } from "./resultMerge.js";

// The installed SDK's `ProfileParams` doesn't declare `filters` even though
// `/v4/profile` accepts one and the client sends whatever body it's given
// (see `Supermemory#profile`, a raw pass-through) - the same shape
// `search.memories` already types correctly. This just closes that gap
// locally rather than leaving `tsc --noEmit` broken.
type ProfileParamsWithFilters = ProfileParams & {
  filters?: ReturnType<typeof getScopeFilters>;
};

const TIMEOUT_MS = 30000;
const SPACE_NAME_TIMEOUT_MS = 5000;
const CODEX_SOURCE = "codex";

export type MemoryScope = "personal" | "project";

function getScopeFilters(scope: MemoryScope) {
  return {
    AND: [{ key: "sm_scope", value: scope, filterType: "metadata" as const }],
  };
}

function supportsScopedCanonicalTag(containerTag: string): boolean {
  return /^repo_.+__[0-9a-f]{16}$/i.test(containerTag);
}

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
  containerTag?: string;
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

export const AGENT_ENTITY_CONTEXT = `Shared coding-agent memory for one software repository.

RULES:
- Preserve durable context that helps Claude Code, Codex, OpenCode, or Cursor continue the work
- Condense assistant responses into decisions, outcomes, and reusable knowledge
- Keep user preferences and project facts concise and independently understandable

EXTRACT:
- User preferences, accepted decisions, durable workflows, actions, and learnings
- Architecture: "uses monorepo with turborepo", "API in /apps/api"
- Conventions: "components in PascalCase", "hooks prefixed with use"
- Patterns: "all API routes use withAuth wrapper", "errors thrown as ApiError"
- Setup: "requires .env with DATABASE_URL", "run pnpm db:migrate first"
- Decisions: "chose Drizzle over Prisma for performance", "using RSC for data fetching"

SKIP:
- Generic assistant suggestions the user did not accept
- Transient command output and low-value implementation chatter
- Granular details that do not help future work`;

export const USER_ENTITY_CONTEXT = AGENT_ENTITY_CONTEXT;
export const PROJECT_ENTITY_CONTEXT = AGENT_ENTITY_CONTEXT;

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
   * Get a profile with embedded search results from one container. A scope is
   * optional because default recall searches the unified project container.
   */
  async getProfileWithSearch(
    containerTag: string,
    query?: string,
    scope?: MemoryScope,
  ): Promise<ProfileWithSearchResult> {
    log("getProfileWithSearch: start", { containerTag, hasQuery: !!query });
    try {
      const result = await withTimeout(
        this.getClient().profile({
          containerTag,
          q: query,
          filters: scope ? getScopeFilters(scope) : undefined,
        } satisfies ProfileParamsWithFilters as ProfileParams),
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

  async getProfileWithSearchMany(
    containerTags: string[],
    query?: string,
  ): Promise<ProfileWithSearchResult> {
    const uniqueTags = [...new Set(containerTags.filter(Boolean))];
    const results = await Promise.all(
      uniqueTags.map((containerTag) => this.getProfileWithSearch(containerTag, query)),
    );
    return mergeProfileResults(results, CONFIG.maxMemories);
  }

  async getProfileWithSearchScoped(
    canonicalTag: string,
    containerTags: string[],
    scope: MemoryScope,
    query?: string,
  ): Promise<ProfileWithSearchResult> {
    const legacyTags = [...new Set(
      containerTags.filter((tag) => tag && tag !== canonicalTag),
    )];
    const results = await Promise.all([
      this.getProfileWithSearch(
        canonicalTag,
        query,
        supportsScopedCanonicalTag(canonicalTag) ? scope : undefined,
      ),
      ...legacyTags.map((containerTag) =>
        this.getProfileWithSearch(containerTag, query),
      ),
    ]);
    return mergeProfileResults(results, CONFIG.maxMemories);
  }

  // Keep old methods for backward compatibility

  async searchMemories(
    query: string,
    containerTag: string,
    scope?: MemoryScope,
  ): Promise<SearchResponse> {
    log("searchMemories: start", { containerTag });
    try {
      const result = await withTimeout(
        this.getClient().search.memories({
          q: query,
          containerTag,
          threshold: CONFIG.similarityThreshold,
          limit: CONFIG.maxMemories,
          searchMode: "hybrid",
          filters: scope ? getScopeFilters(scope) : undefined,
        }),
        TIMEOUT_MS
      );
      log("searchMemories: success", { count: result.results?.length || 0 });
      const results = (result.results as SearchResultItem[]).map((item) => ({
        ...item,
        containerTag,
      }));
      return { success: true, results, total: result.total, timing: result.timing };
    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : String(error);
      log("searchMemories: error", { error: errorMessage });
      return { success: false, error: errorMessage, results: [], total: 0, timing: 0 };
    }
  }

  async searchMemoriesMany(query: string, containerTags: string[]): Promise<SearchResponse> {
    const uniqueTags = [...new Set(containerTags.filter(Boolean))];
    const results = await Promise.all(
      uniqueTags.map((containerTag) => this.searchMemories(query, containerTag)),
    );
    return mergeSearchResponses(results, CONFIG.maxMemories);
  }

  async searchMemoriesScoped(
    query: string,
    canonicalTag: string,
    containerTags: string[],
    scope: MemoryScope,
  ): Promise<SearchResponse> {
    const legacyTags = [...new Set(
      containerTags.filter((tag) => tag && tag !== canonicalTag),
    )];
    const results = await Promise.all([
      this.searchMemories(
        query,
        canonicalTag,
        supportsScopedCanonicalTag(canonicalTag) ? scope : undefined,
      ),
      ...legacyTags.map((containerTag) =>
        this.searchMemories(query, containerTag),
      ),
    ]);
    return mergeSearchResponses(results, CONFIG.maxMemories);
  }

  async getProfile(containerTag: string, query?: string, scope?: MemoryScope) {
    log("getProfile: start", { containerTag });
    try {
      const result = await withTimeout(
        this.getClient().profile({
          containerTag,
          q: query,
          filters: scope ? getScopeFilters(scope) : undefined,
        } satisfies ProfileParamsWithFilters as ProfileParams),
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

  async getProfileMany(containerTags: string[], query?: string): Promise<ProfileWithSearchResult> {
    return this.getProfileWithSearchMany(containerTags, query);
  }

  async getProfileScopedMany(
    canonicalTag: string,
    containerTags: string[],
    scope: MemoryScope,
    query?: string,
  ): Promise<ProfileWithSearchResult> {
    return this.getProfileWithSearchScoped(
      canonicalTag,
      containerTags,
      scope,
      query,
    );
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
        !currentName.startsWith("Codex · ") &&
        !currentName.startsWith("Agents · ")
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
