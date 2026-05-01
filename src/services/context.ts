import type { ProfileWithSearchResult } from "./client.js";
import { normalizeFact } from "./factCache.js";

interface SearchResult {
  content?: string;
  memory?: string;
  chunk?: string;
  score?: number;
  similarity?: number;
  metadata?: Record<string, unknown> | null;
}

interface SearchResponse {
  success: boolean;
  results?: SearchResult[];
}

interface ProfileShape {
  static?: string[];
  dynamic?: string[];
}

interface ProfileResponse {
  success: boolean;
  profile?: ProfileShape | string | null;
}

function formatProfile(
  profile: ProfileShape | string | null | undefined,
  maxItems: number
): string | null {
  if (!profile) return null;
  if (typeof profile === "string") {
    return profile.trim() || null;
  }
  const items = [
    ...(profile.static ?? []),
    ...(profile.dynamic ?? []),
  ]
    .map((s) => s.trim())
    .filter((s) => s.length > 0)
    .slice(0, maxItems);
  if (items.length === 0) return null;
  return items.map((s, i) => `${i + 1}. ${s}`).join("\n");
}

export interface FormattedContext {
  text: string;
  newFacts: string[];
}

function pickNewProfileItems(
  profile: ProfileWithSearchResult["profile"],
  seen: Set<string>,
  max: number
): string[] {
  if (!profile) return [];
  const items = [...(profile.static ?? []), ...(profile.dynamic ?? [])]
    .map((s) => s.trim())
    .filter((s) => s.length > 0 && !seen.has(normalizeFact(s)));
  return items.slice(0, max);
}

function pickNewMemories(
  results: NonNullable<ProfileWithSearchResult["searchResults"]>["results"],
  seen: Set<string>,
  max: number
): string[] {
  return results
    .map((r) => (r.memory || "").trim())
    .filter((m) => m.length > 2 && !seen.has(normalizeFact(m)))
    .slice(0, max);
}

/**
 * Format only facts the session hasn't seen yet. Already-injected facts live in
 * the model's prior turns, so re-sending them is wasted tokens.
 */
export function formatCombinedContext(
  result: ProfileWithSearchResult,
  maxMemories: number,
  maxProfileItems: number,
  seen: Set<string> = new Set()
): FormattedContext {
  const parts: string[] = [];
  const newFacts: string[] = [];

  if (result.success && result.profile) {
    const items = pickNewProfileItems(result.profile, seen, maxProfileItems);
    if (items.length > 0) {
      parts.push(
        `[User Profile]\n${items.map((s, i) => `${i + 1}. ${s}`).join("\n")}`
      );
      newFacts.push(...items);
    }
  }

  if (result.searchResults && result.searchResults.results.length > 0) {
    const items = pickNewMemories(result.searchResults.results, seen, maxMemories);
    if (items.length > 0) {
      parts.push(
        `[Relevant Memories]\n${items.map((m, i) => `${i + 1}. ${m}`).join("\n")}`
      );
      newFacts.push(...items);
    }
  }

  return { text: parts.join("\n\n"), newFacts };
}

// Keep old method for backward compatibility
export function formatContextForPrompt(
  searchResult: SearchResponse,
  profileResult: ProfileResponse,
  maxMemories: number,
  maxProfileItems: number
): string {
  const parts: string[] = [];

  if (profileResult.success) {
    const profileText = formatProfile(profileResult.profile, maxProfileItems);
    if (profileText) {
      parts.push(`[User Profile]\n${profileText}`);
    }
  }

  if (searchResult.success && searchResult.results && searchResult.results.length > 0) {
    const memories = searchResult.results
      .slice(0, maxMemories)
      .map((r, i) => `${i + 1}. ${r.memory ?? r.chunk ?? r.content ?? ""}`)
      .filter((m) => m.trim().length > 2)
      .join("\n");
    if (memories) {
      parts.push(`[Relevant Memories]\n${memories}`);
    }
  }

  return parts.join("\n\n");
}
