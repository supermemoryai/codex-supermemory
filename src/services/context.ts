import type { ProfileWithSearchResult, SearchResponse } from "./client.js";
import { factKey } from "./factCache.js";
import { boundedMemoryText, memoryText } from "./resultText.js";

const ATTRIBUTION_GUIDANCE =
  "Items marked ◪ were recalled from supermemory. Use them when relevant; if you mention the source, say \"from supermemory\".";

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

/**
 * Format context from the unified project profile and its embedded search.
 *
 * Facts already seen in this session (passed via `seenFacts`) are skipped
 * to avoid wasting tokens on repeated context.
 */
export function formatCombinedContext(
  result: ProfileWithSearchResult,
  maxMemories: number,
  maxProfileItems: number,
  seenFacts: Set<string> = new Set(),
): FormattedContext {
  const parts: string[] = [];
  const newFacts: string[] = [];
  const currentFactKeys = new Set(seenFacts);

  // Collect profile items, filtering out already-seen facts
  if (result.success && result.profile) {
    const takeFresh = (facts: string[]): string[] => {
      if (maxProfileItems <= 0) return [];
      const items: string[] = [];
      for (const fact of facts) {
        const item = fact.trim();
        if (!item) continue;
        const key = factKey(item);
        if (currentFactKeys.has(key)) continue;
        currentFactKeys.add(key);
        items.push(item);
        if (items.length >= maxProfileItems) break;
      }
      return items;
    };
    // Match Claude's profile budget: maxProfileItems applies independently to
    // persistent and recent facts so one section cannot starve the other.
    const items = [
      ...takeFresh(result.profile.static ?? []),
      ...takeFresh(result.profile.dynamic ?? []),
    ];
    if (items.length > 0) {
      parts.push(
        `[Memory Profile]\n${items.map((s, i) => `${i + 1}. ◪ ${s}`).join("\n")}`
      );
      newFacts.push(...items);
    }
  }

  // Deduplicate embedded search results by id, falling back to content.
  const seenKeys = new Set<string>();

  function dedupKey(id: string | undefined, text: string): string {
    const normalized = text.toLowerCase().trim();
    if (normalized) return `content:${normalized}`;
    return id ? `id:${id}` : "";
  }

  const allMemories: Array<{ text: string; display: string }> = [];
  if (result.searchResults && result.searchResults.results.length > 0) {
    for (const r of result.searchResults.results) {
      const text = memoryText(r);
      const textKey = text ? factKey(text) : "";
      if (!text || currentFactKeys.has(textKey)) continue;
      const key = dedupKey(r.id, text);
      if (key && !seenKeys.has(key)) {
        seenKeys.add(key);
        currentFactKeys.add(textKey);
        const labels = [r.title, r.filepath]
          .filter((label): label is string => typeof label === "string" && label.trim().length > 0);
        allMemories.push({
          text,
          display: labels.length > 0
            ? `◪ [${labels.join(" — ")}] ${boundedMemoryText(r)}`
            : `◪ ${boundedMemoryText(r)}`,
        });
      }
    }
  }

  if (allMemories.length > 0) {
    const limitedMemories = allMemories.slice(0, maxMemories);
    const memories = limitedMemories
      .map((memory, i) => `${i + 1}. ${memory.display}`)
      .filter((m) => m.trim().length > 2)
      .join("\n");
    if (memories) {
      parts.push(`[Relevant Memories]\n${memories}`);
      newFacts.push(...limitedMemories.map((memory) => memory.text));
    }
  }

  return {
    text: parts.length > 0 ? `${ATTRIBUTION_GUIDANCE}\n\n${parts.join("\n\n")}` : "",
    newFacts,
  };
}

/**
 * Format context from separate search + profile results.
 * Used by the search-memory skill script which makes its own API calls.
 */
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
      parts.push(`[Memory Profile]\n${profileText}`);
    }
  }

  if (searchResult.success && searchResult.results && searchResult.results.length > 0) {
    const memories = searchResult.results
      .slice(0, maxMemories)
      .map((r, i) => `${i + 1}. ${boundedMemoryText(r)}`)
      .filter((m) => m.trim().length > 2)
      .join("\n");
    if (memories) {
      parts.push(`[Relevant Memories]\n${memories}`);
    }
  }

  return parts.join("\n\n");
}
