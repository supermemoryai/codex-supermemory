import { CONFIG, getApiKeyValue, getBaseUrl } from "../config.js";
import type { ProfileWithSearchResult, SearchResultItem } from "./client.js";
import { mergeProfileResults } from "./resultMerge.js";
import { memoryText, recallProvenance } from "./resultText.js";

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

async function fetchProfile(
  containerTag: string,
  query: string,
  options: Required<HookRecallOptions>,
): Promise<ProfileWithSearchResult> {
  const apiKey = getApiKeyValue();
  if (!apiKey) return { success: false, error: "Missing API key", profile: null };

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), options.timeoutMs);
  try {
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
      return { success: false, error: `Profile request failed (${response.status})`, profile: null };
    }
    return normalizeProfileResponse(await response.json());
  } catch (error) {
    return {
      success: false,
      error: error instanceof Error ? error.message : String(error),
      profile: null,
    };
  } finally {
    clearTimeout(timeout);
  }
}

export async function getHookProfileWithSearchMany(
  containerTags: string[],
  query: string,
  options: HookRecallOptions = {},
): Promise<ProfileWithSearchResult> {
  const resolved = {
    timeoutMs: options.timeoutMs ?? HOOK_RECALL_TIMEOUT_MS,
    fetchImpl: options.fetchImpl ?? fetch,
  };
  const uniqueTags = [...new Set(containerTags.filter(Boolean))];
  const results = await Promise.all(
    uniqueTags.map((containerTag) => fetchProfile(containerTag, query, resolved)),
  );
  return mergeProfileResults(results, CONFIG.maxMemories);
}
