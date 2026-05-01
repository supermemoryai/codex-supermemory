import type { ProfileWithSearchResult, SearchResponse } from "./client.js";

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
 *
 * Memories from both containers are interleaved by alternating picks so that
 * neither source is entirely crowded out when the total exceeds maxMemories.
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

  // Collect memories from both user (profile API) and project (search API)
  // containers. Deduplicate by id when available, falling back to content.
  const seen = new Set<string>();

  function dedupKey(id: string | undefined, text: string): string {
    if (id) return `id:${id}`;
    return `content:${text.toLowerCase().trim()}`;
  }

  const userMemories: string[] = [];
  if (result.searchResults && result.searchResults.results.length > 0) {
    for (const r of result.searchResults.results) {
      const text = r.memory || "";
      const key = dedupKey(r.id, text);
      if (key && !seen.has(key)) {
        seen.add(key);
        userMemories.push(text);
      }
    }
  }

  const projectMemories: string[] = [];
  if (projectSearchResult?.success && projectSearchResult.results && projectSearchResult.results.length > 0) {
    for (const r of projectSearchResult.results) {
      const text = r.memory ?? r.chunk ?? r.content ?? "";
      const key = dedupKey(r.id, text);
      if (key && !seen.has(key)) {
        seen.add(key);
        projectMemories.push(text);
      }
    }
  }

  // Interleave user and project memories so neither source is dropped when
  // the total exceeds maxMemories. Alternate picks: user, project, user, …
  const allMemories: string[] = [];
  let ui = 0;
  let pi = 0;
  while (allMemories.length < maxMemories && (ui < userMemories.length || pi < projectMemories.length)) {
    if (ui < userMemories.length) {
      allMemories.push(userMemories[ui++]);
    }
    if (allMemories.length < maxMemories && pi < projectMemories.length) {
      allMemories.push(projectMemories[pi++]);
    }
  }

  const memories = allMemories
    .map((m, i) => `${i + 1}. ${m}`)
    .filter((m) => m.trim().length > 2)
    .join("\n");
  if (memories) {
    parts.push(`[Relevant Memories]\n${memories}`);
  }

  return parts.join("\n\n");
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
