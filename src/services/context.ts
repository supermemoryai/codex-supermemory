import type { ProfileWithSearchResult } from "./client.js";

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

/**
 * Format context from combined profile+search result.
 * Accepts an optional separate project search result to merge project-scoped
 * memories alongside user-scoped ones from the profile API.
 */
export function formatCombinedContext(
  result: ProfileWithSearchResult,
  maxMemories: number,
  maxProfileItems: number,
  projectSearchResult?: SearchResponse,
): string {
  const parts: string[] = [];

  if (result.success && result.profile) {
    const profileText = formatProfile(result.profile, maxProfileItems);
    if (profileText) {
      parts.push(`[User Profile]\n${profileText}`);
    }
  }

  // Merge memories from both user (profile API) and project (search API) containers.
  // Deduplicate by lowercased content to avoid showing the same memory twice.
  const seen = new Set<string>();
  const allMemories: string[] = [];

  if (result.searchResults && result.searchResults.results.length > 0) {
    for (const r of result.searchResults.results) {
      const text = r.memory || "";
      const key = text.toLowerCase().trim();
      if (key && !seen.has(key)) {
        seen.add(key);
        allMemories.push(text);
      }
    }
  }

  if (projectSearchResult?.success && projectSearchResult.results && projectSearchResult.results.length > 0) {
    for (const r of projectSearchResult.results) {
      const text = r.memory ?? r.chunk ?? r.content ?? "";
      const key = text.toLowerCase().trim();
      if (key && !seen.has(key)) {
        seen.add(key);
        allMemories.push(text);
      }
    }
  }

  const memories = allMemories
    .slice(0, maxMemories)
    .map((m, i) => `${i + 1}. ${m}`)
    .filter((m) => m.trim().length > 2)
    .join("\n");
  if (memories) {
    parts.push(`[Relevant Memories]\n${memories}`);
  }

  return parts.join("\n\n");
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
