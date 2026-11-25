import Supermemory, { SupermemoryError, type FilterExpression, type RequestOptions } from "supermemory";
import { getAuthToken, getBaseUrl } from "../config.js";
import type { ProfileWithSearchResult, SearchResultItem, MemoryScope } from "./client.js";
import { memoryText, recallProvenance } from "./resultText.js";

export function createV5Client(fetchImpl?: typeof fetch): Supermemory {
  const baseUrl = getBaseUrl();
  return new Supermemory({
    apiKey: () => getAuthToken(undefined, baseUrl),
    baseUrl,
    headers: { "x-sm-source": "codex" },
    timeoutInSeconds: 60,
    maxRetries: 2,
    fetch: fetchImpl,
  });
}

export function apiErrorMessage(error: unknown): string {
  if (error instanceof SupermemoryError) {
    return typeof error.statusCode === "number"
      ? `API request failed (${error.statusCode})`
      : "API request failed";
  }
  return error instanceof Error ? error.message : String(error);
}

export function scopeFilter(scope?: MemoryScope): FilterExpression | undefined {
  return scope ? { field: "sm_scope", operator: "eq", value: scope } : undefined;
}

export function profileFacts(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  return value.map((fact) => typeof fact === "string"
    ? fact
    : fact && typeof fact === "object" ? memoryText(fact) : "")
    .filter((fact) => fact.trim().length > 0);
}

export function normalizeSearchItem(item: SearchResultItem): SearchResultItem {
  const provenance = recallProvenance(item);
  return {
    ...item,
    title: provenance.title,
    filepath: provenance.filepath,
    updatedAt: item.updatedAt ?? item.system?.updatedAt,
  };
}

export async function searchV5(
  client: Supermemory,
  namespace: string,
  query: string,
  scope?: MemoryScope,
  requestOptions?: RequestOptions,
): Promise<{ results: Array<SearchResultItem & { memory: string }>; total: number; timing?: number }> {
  const search = await client.search(namespace, {
    query,
    filter: scopeFilter(scope),
    searchMode: "memories",
    threshold: 0.6,
    limit: 10,
    rerank: "none",
    rewriteQuery: false,
    include: { documents: false, related: false, forgotten: false },
  }, requestOptions);
  const results = search.results.map(normalizeSearchItem).map((item) => ({
    ...item,
    memory: memoryText(item),
  })).filter((item) => item.memory.length > 0);
  return { results, total: results.length, timing: search.searchTime };
}

export async function readV5Profile(
  client: Supermemory,
  namespace: string,
  query?: string,
  scope?: MemoryScope,
  requestOptions?: RequestOptions,
): Promise<ProfileWithSearchResult> {
  const [profile, searchResults] = await Promise.all([
    client.profile(namespace, { filter: scopeFilter(scope) }, requestOptions),
    query ? searchV5(client, namespace, query, scope, requestOptions) : undefined,
  ]);
  return {
    success: true,
    profile: {
      static: profileFacts(profile.profile?.static),
      dynamic: profileFacts(profile.profile?.dynamic),
    },
    searchResults,
  };
}
