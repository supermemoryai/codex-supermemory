import { CONFIG, getAuthToken, getBaseUrl, getApiVersion } from "../config.js";
import type { ProfileWithSearchResult, SearchResponse, SearchResultItem } from "./client.js";
import { mergeSearchResponses, passesRecallThreshold } from "./resultMerge.js";
import { memoryText, recallProvenance, RECALL_MAX_RESULTS } from "./resultText.js";
import { createV5Client, searchV5, apiErrorMessage } from "./api.js";

export const HOOK_RECALL_TIMEOUT_MS = 3000;

interface HookRecallOptions {
  timeoutMs?: number;
  fetchImpl?: typeof fetch;
}

function stringFacts(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  return value.filter(
    (fact): fact is string => typeof fact === "string" && fact.trim().length > 0,
  );
}

function normalizeProfileResponse(raw: unknown): ProfileWithSearchResult {
  const value = raw && typeof raw === "object"
    ? raw as Record<string, unknown>
    : {};
  const profile = value.profile && typeof value.profile === "object"
    ? value.profile as Record<string, unknown>
    : {};
  const searchResults = value.searchResults && typeof value.searchResults === "object"
    ? value.searchResults as Record<string, unknown>
    : null;
  const rawResults = Array.isArray(searchResults?.results)
    ? searchResults.results as SearchResultItem[]
    : [];
  const results = rawResults
    .map((result) => {
      const provenance = recallProvenance(result);
      return {
        id: result.id,
        memory: memoryText(result),
        score: result.score,
        similarity: result.similarity,
        title: provenance.title,
        filepath: provenance.filepath,
        updatedAt: result.updatedAt,
      };
    })
    .filter((result) => result.memory.length > 0);

  return {
    success: true,
    profile: {
      static: stringFacts(profile.static),
      dynamic: stringFacts(profile.dynamic),
    },
    searchResults: searchResults
      ? {
          results,
          total: typeof searchResults.total === "number" ? searchResults.total : results.length,
          timing: typeof searchResults.timing === "number" ? searchResults.timing : undefined,
        }
      : undefined,
  };
}

async function searchContainer(
  containerTag: string,
  query: string,
  options: Required<HookRecallOptions>,
): Promise<SearchResponse> {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), options.timeoutMs);
  try {
    const apiKey = await getAuthToken(Math.min(options.timeoutMs, 3000));
    controller.signal.throwIfAborted();
    if (getApiVersion() === "v5") {
      return {
        success: true,
        ...(await searchV5(createV5Client(options.fetchImpl), containerTag, query, undefined, {
          timeoutInSeconds: options.timeoutMs / 1000,
          maxRetries: 0,
          abortSignal: controller.signal,
        })),
      };
    }
    const response = await options.fetchImpl(`${getBaseUrl().replace(/\/+$/, "")}/v4/profile`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${apiKey}`,
        "Content-Type": "application/json",
        "x-sm-source": "codex",
      },
      body: JSON.stringify({ containerTag, q: query }),
      signal: controller.signal,
    });
    if (!response.ok) {
      return { success: false, error: `Profile request failed (${response.status})` };
    }
    const legacy = normalizeProfileResponse(await response.json());
    return { success: true, ...legacy.searchResults };
  } catch (error) {
    return { success: false, error: apiErrorMessage(error) };
  } finally {
    clearTimeout(timeout);
  }
}

export async function searchHookMemories(
  containerTags: string[],
  query: string,
  options: HookRecallOptions = {},
): Promise<SearchResponse> {
  const resolved = {
    timeoutMs: options.timeoutMs ?? HOOK_RECALL_TIMEOUT_MS,
    fetchImpl: options.fetchImpl ?? fetch,
  };
  const uniqueTags = [...new Set(containerTags.filter(Boolean))];
  const responses = await Promise.all(
    uniqueTags.map((containerTag) => searchContainer(containerTag, query, resolved)),
  );
  return mergeSearchResponses(
    responses.map((response) => ({
      ...response,
      results: response.results?.filter((result) =>
        passesRecallThreshold(result) && memoryText(result).length > 0),
    })),
    Math.min(CONFIG.maxMemories, RECALL_MAX_RESULTS),
  );
}
