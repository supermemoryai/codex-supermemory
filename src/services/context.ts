import type { ProfileWithSearchResult, SearchResponse } from "./client.js";
import type { CustomContainer } from "../config.js";
import { factKey } from "./factCache.js";
import { memoryText } from "./resultText.js";

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

interface BoundedItem {
  before: string;
  prefix: string;
  text: string;
  suffix: string;
}

const CHARS_PER_TOKEN = 4;

function formatBoundedItems(
  items: BoundedItem[],
  maxTokens: number,
  limitName: string,
  render: (body: string) => string,
): FormattedContext {
  if (!Number.isFinite(maxTokens) || maxTokens <= 0) {
    throw new RangeError(`${limitName} must be a positive number`);
  }

  const maxChars = Math.floor(maxTokens * CHARS_PER_TOKEN);
  if (render("").length > maxChars) {
    throw new RangeError(`${limitName} is too small for fixed recall context`);
  }

  let body = "";
  const newFacts: string[] = [];
  for (const item of items) {
    const fullBody = `${body}${item.before}${item.prefix}${item.text}${item.suffix}`;
    if (render(fullBody).length <= maxChars) {
      body = fullBody;
      newFacts.push(item.text);
      continue;
    }

    const fixedBody = `${body}${item.before}${item.prefix}${item.suffix}`;
    const available = maxChars - render(fixedBody).length;
    if (available > 1) {
      const emitted = `${item.text.slice(0, available - 1)}…`;
      body = `${body}${item.before}${item.prefix}${emitted}${item.suffix}`;
      newFacts.push(emitted);
    }
    break;
  }

  return { text: newFacts.length > 0 ? render(body) : "", newFacts };
}

function singleLine(value: string): string {
  return value.replace(/\s+/g, " ").trim();
}

interface RecallItem {
  memory: string;
  title?: string;
  filepath?: string;
}

interface RecallContextOptions {
  containerTag: string;
  maxMemories: number;
  maxTokens: number;
  seenFacts?: Set<string>;
  customContainers?: CustomContainer[];
}

export function formatRecallContext(
  matches: RecallItem[],
  options: RecallContextOptions,
): FormattedContext {
  const seen = new Set(options.seenFacts ?? []);
  const fresh: RecallItem[] = [];
  if (options.maxMemories > 0) {
    for (const match of matches) {
      const text = singleLine(match.memory);
      const key = text ? factKey(text) : "";
      if (!text || seen.has(key)) continue;
      seen.add(key);
      fresh.push({ ...match, memory: text });
      if (fresh.length >= options.maxMemories) break;
    }
  }

  const catalog = options.customContainers?.length
    ? `\n\nConfigured automatic recall containers:\n${options.customContainers
        .map((container) => `- ${singleLine(container.tag)}: ${singleLine(container.description)}`)
        .join("\n")}`
    : "";
  const render = (body: string): string => `<supermemory-recall>
◪ Recalled from supermemory for this prompt (relevance-ranked):
${body}${catalog}

When one of these shapes your answer, credit it naturally with the ◪ prefix (e.g. "◪ earlier you decided X"); if you name the source, say "from supermemory" — never "from memory". For deeper history, call the supermemory search_memory tool (containerTag: ${JSON.stringify(options.containerTag)}).
</supermemory-recall>`;
  const items = fresh.map((item, index) => {
    const title = singleLine(item.title ?? "");
    const prefix = title && !item.memory.startsWith(title) ? `${title} — ` : "";
    const filepath = singleLine(item.filepath ?? "");
    return {
      before: index === 0 ? "" : "\n",
      prefix: `- ◪ ${prefix}`,
      text: item.memory,
      suffix: filepath ? ` (${filepath})` : "",
    };
  });
  return formatBoundedItems(items, options.maxTokens, "maxPromptRecallTokens", render);
}

interface SessionContextOptions {
  maxProfileItems: number;
  maxTokens: number;
  seenFacts?: Set<string>;
  projectName: string;
  containerTag: string;
}

export function formatSessionContext(
  result: ProfileWithSearchResult,
  options: SessionContextOptions,
): FormattedContext {
  const seen = new Set(options.seenFacts ?? []);
  const takeFresh = (facts: string[]): string[] => {
    if (options.maxProfileItems <= 0) return [];
    const fresh: string[] = [];
    for (const fact of facts) {
      const text = fact.trim();
      const key = text ? factKey(text) : "";
      if (!text || seen.has(key)) continue;
      seen.add(key);
      fresh.push(text);
      if (fresh.length >= options.maxProfileItems) break;
    }
    return fresh;
  };
  const facts = result.success && result.profile
    ? [
        ...takeFresh(result.profile.static ?? []),
        ...takeFresh(result.profile.dynamic ?? []),
      ]
    : [];
  const render = (body: string): string => `<supermemory-context>
Recalled memory for this project (${options.projectName}). Every line marked ◪ comes from supermemory — when citing one, keep the mark and phrase it naturally. If you name the source, say "from supermemory" — never "from memory".
This project's memory container: ${options.containerTag}

${ATTRIBUTION_GUIDANCE}

${body}
</supermemory-context>`;
  const items = facts.map((fact, index) => ({
    before: index === 0 ? "[Memory Profile]\n" : "\n",
    prefix: `${index + 1}. ◪ `,
    text: fact,
    suffix: "",
  }));
  return formatBoundedItems(items, options.maxTokens, "maxRecallTokens", render);
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
            ? `◪ [${labels.join(" — ")}] ${singleLine(text)}`
            : `◪ ${singleLine(text)}`,
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
      .map((r, i) => `${i + 1}. ${singleLine(memoryText(r))}`)
      .filter((m) => m.trim().length > 2)
      .join("\n");
    if (memories) {
      parts.push(`[Relevant Memories]\n${memories}`);
    }
  }

  return parts.join("\n\n");
}
