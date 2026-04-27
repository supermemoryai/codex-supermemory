import { CONFIG, isConfigured } from "../config.js";
import { SupermemoryClient } from "../services/client.js";
import { formatContextForPrompt } from "../services/context.js";
import { getProjectTag, getUserTag } from "../services/tags.js";

type Scope = "user" | "project" | "both";

interface ParsedArgs {
  scope: Scope;
  includeProfile: boolean;
  query: string;
}

function parseArgs(args: string[]): ParsedArgs {
  let scope: Scope = "both";
  let includeProfile = true;
  const queryParts: string[] = [];

  for (const arg of args) {
    if (arg === "--user") {
      scope = "user";
    } else if (arg === "--project") {
      scope = "project";
    } else if (arg === "--both") {
      scope = "both";
    } else if (arg === "--no-profile") {
      includeProfile = false;
    } else {
      queryParts.push(arg);
    }
  }

  return { scope, includeProfile, query: queryParts.join(" ") };
}

async function main(): Promise<void> {
  if (!isConfigured()) {
    console.log(
      "Supermemory API key not configured. Set SUPERMEMORY_CODEX_API_KEY environment variable."
    );
    process.exit(0);
  }

  const { scope, includeProfile, query } = parseArgs(process.argv.slice(2));

  if (!query.trim()) {
    console.log(
      'No search query provided. Usage: node search-memory.js [--user|--project|--both] "query"'
    );
    process.exit(0);
  }

  const client = new SupermemoryClient();
  const userTag = getUserTag();
  const projectTag = getProjectTag(process.cwd());

  try {
    let searchResult: Awaited<ReturnType<typeof client.searchMemories>>;

    if (scope === "both") {
      const [userResult, projectResult] = await Promise.all([
        client.searchMemories(query, userTag),
        client.searchMemories(query, projectTag),
      ]);

      // Surface errors when all searches fail
      if (!userResult.success && !projectResult.success) {
        console.log(`Failed to search memories: ${userResult.error}`);
        return;
      }

      const combinedResults = [
        ...(userResult.success ? userResult.results ?? [] : []),
        ...(projectResult.success ? projectResult.results ?? [] : []),
      ];

      searchResult = {
        success: true as const,
        results: combinedResults,
        total: combinedResults.length,
        timing: 0,
      } as Awaited<ReturnType<typeof client.searchMemories>>;
    } else {
      const tag = scope === "user" ? userTag : projectTag;
      searchResult = await client.searchMemories(query, tag);

      // Surface error for single-scope search failure
      if (!searchResult.success) {
        console.log(`Failed to search memories: ${searchResult.error}`);
        return;
      }
    }

    const profileResult = includeProfile
      ? await client.getProfile(userTag, query)
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
