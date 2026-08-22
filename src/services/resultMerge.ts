import type {
  ProfileWithSearchResult,
  SearchResponse,
  SearchResultItem,
} from "./client.js";
import {
  boundedMemoryText,
  memoryText,
  recallProvenance,
  RECALL_MAX_RESULTS,
  RECALL_MIN_SIMILARITY,
} from "./resultText.js";

function normalize(value: unknown): string {
  return String(value ?? "").toLowerCase().trim();
}

function dedupe<T>(items: T[], getKey: (item: T) => string): T[] {
  const seen = new Set<string>();
  return items.filter((item) => {
    const key = normalize(getKey(item));
    if (!key || seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

function searchKey(result: SearchResultItem): string {
  const content = normalize(memoryText(result));
  if (content) return `content:${content}`;
  return result.id ? `id:${result.id}` : "";
}

function score(result: SearchResultItem): number {
  return result.similarity ?? result.score ?? -1;
}

export function mergeSearchResponses(
  responses: SearchResponse[],
  limit: number,
): SearchResponse {
  const successful = responses.filter((response) => response.success);
  if (successful.length === 0) {
    return {
      success: false,
      error: responses.find((response) => response.error)?.error || "All container searches failed",
      results: [],
      total: 0,
      timing: 0,
    };
  }

  const results = successful
    .flatMap((response) => response.results ?? [])
    .sort((a, b) => {
      const scoreDiff = score(b) - score(a);
      if (scoreDiff !== 0) return scoreDiff;
      const aTime = a.updatedAt ? Date.parse(a.updatedAt) : 0;
      const bTime = b.updatedAt ? Date.parse(b.updatedAt) : 0;
      return bTime - aTime;
    });
  const merged = dedupe(results, searchKey).slice(0, limit);
  return {
    success: true,
    results: merged,
    total: merged.length,
    timing: Math.max(0, ...successful.map((response) => response.timing ?? 0)),
  };
}

export function mergeProfileResults(
  responses: ProfileWithSearchResult[],
  limit: number,
): ProfileWithSearchResult {
  const successful = responses.filter((response) => response.success && response.profile);
  if (successful.length === 0) {
    return {
      success: false,
      error: responses.find((response) => response.error)?.error || "All profile requests failed",
      profile: null,
    };
  }

  const staticFacts = dedupe(
    successful.flatMap((response) => response.profile?.static ?? []),
    (fact) => fact,
  );
  const staticKeys = new Set(staticFacts.map(normalize));
  const dynamicFacts = dedupe(
    successful.flatMap((response) => response.profile?.dynamic ?? []),
    (fact) => fact,
  ).filter((fact) => !staticKeys.has(normalize(fact)));
  const mergedSearch = mergeSearchResponses(
    successful.map((response) => ({
      success: true,
      results: (response.searchResults?.results ?? []).filter(
        (result) =>
          score(result) >= RECALL_MIN_SIMILARITY && memoryText(result).length > 0,
      ),
      total: response.searchResults?.total ?? 0,
      timing: response.searchResults?.timing,
    })),
    Math.min(limit, RECALL_MAX_RESULTS),
  );

  return {
    success: true,
    profile: { static: staticFacts, dynamic: dynamicFacts },
    searchResults:
      mergedSearch.results && mergedSearch.results.length > 0
        ? {
            results: mergedSearch.results.map((result) => {
              const provenance = recallProvenance(result);
              return {
                id: result.id,
                memory: boundedMemoryText(result),
                similarity: result.similarity,
                title: provenance.title,
                filepath: provenance.filepath,
                updatedAt: result.updatedAt,
              };
            }),
            total: mergedSearch.total ?? mergedSearch.results.length,
            timing: mergedSearch.timing,
          }
        : undefined,
  };
}
