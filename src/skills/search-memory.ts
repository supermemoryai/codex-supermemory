import { CONFIG, isConfigured, validateContainerTag } from "../config.js";
import { SupermemoryClient, type SearchResponse } from "../services/client.js";
import { formatContextForPrompt } from "../services/context.js";
import { getProjectTag, getRepoSearchTags, getUserTag } from "../services/tags.js";

type Scope = "user" | "project" | "both" | "custom";

interface ParsedArgs {
  scope: Scope;
  includeProfile: boolean;
  query: string;
  containerTag?: string;
}

function parseArgs(args: string[]): ParsedArgs {
  let scope: Scope = "both";
  let includeProfile = true;
  let containerTag: string | undefined;
  const queryParts: string[] = [];

  for (let i = 0; i < args.length; i++) {
    if (args[i] === "--user") {
      scope = "user";
    } else if (args[i] === "--project") {
      scope = "project";
    } else if (args[i] === "--both") {
      scope = "both";
    } else if (args[i] === "--no-profile") {
      includeProfile = false;
    } else if (args[i] === "--container" && i + 1 < args.length) {
      containerTag = args[++i];
      scope = "custom";
    } else {
      queryParts.push(args[i]);
    }
  }

  return { scope, includeProfile, query: queryParts.join(" "), containerTag };
}

async function main(): Promise<void> {
  if (!isConfigured()) {
    console.error(
      "Supermemory is not authenticated.\n" +
      "Run /supermemory-login to connect, or set SUPERMEMORY_CODEX_API_KEY in your shell profile."
    );
    process.exit(1);
  }

  const { scope, includeProfile, query, containerTag } = parseArgs(process.argv.slice(2));

  if (!query.trim()) {
    console.log(
      'No search query provided. Usage: node search-memory.js [--user|--project|--both|--container <tag>] "query"'
    );
    process.exit(0);
  }

  const client = new SupermemoryClient();
  const userTag = getUserTag();
  const repoTag = getProjectTag(process.cwd());
  const repoSearchTags = getRepoSearchTags(process.cwd());

  if (containerTag) {
    const validationError = validateContainerTag(containerTag);
    if (validationError) {
      console.log(validationError);
      process.exit(1);
    }
  }

  try {
    let searchResult: SearchResponse;

    if (scope === "custom" && containerTag) {
      searchResult = await client.searchMemories(query, containerTag);

      if (!searchResult.success) {
        console.log(`Failed to search container '${containerTag}': ${searchResult.error}`);
        return;
      }
    } else if (scope === "both") {
      searchResult = await client.searchMemoriesAcrossContainers(query, repoSearchTags);

      if (!searchResult.success) {
        console.log(`Failed to search memories: ${searchResult.error}`);
        return;
      }
    } else {
      searchResult = scope === "user"
        ? await client.searchMemories(query, userTag)
        : await client.searchMemoriesAcrossContainers(query, repoSearchTags);

      // Surface error for single-scope search failure
      if (!searchResult.success) {
        console.log(`Failed to search memories: ${searchResult.error}`);
        return;
      }
    }

    const profileResult = includeProfile
      ? await client.getProfile(repoTag, query)
      : { success: false as const, profile: null };

    const output = formatContextForPrompt(
      searchResult,
      profileResult,
      CONFIG.maxMemories,
      CONFIG.maxProfileItems
    );

    if (output.trim()) {
      console.log(output);
    } else {
      console.log(`No memories found for "${query}"`);
    }
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    console.log(`Failed to search memories: ${message}`);
  }
}

main().catch((error) => {
  const message = error instanceof Error ? error.message : String(error);
  console.log(`Failed to search memories: ${message}`);
});
