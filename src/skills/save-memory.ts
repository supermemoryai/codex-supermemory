import { isConfigured } from "../config.js";
import { SupermemoryClient } from "../services/client.js";
import { getProjectTag } from "../services/tags.js";

function parseArgs(args: string[]): { content: string; containerTag?: string } {
  let containerTag: string | undefined;
  const contentParts: string[] = [];

  for (let i = 0; i < args.length; i++) {
    if (args[i] === "--container" && i + 1 < args.length) {
      containerTag = args[++i];
    } else {
      contentParts.push(args[i]);
    }
  }

  return { content: contentParts.join(" "), containerTag };
}

async function main(): Promise<void> {
  if (!isConfigured()) {
    console.error(
      "Supermemory is not authenticated.\n" +
      "Run /supermemory-login to connect, or set SUPERMEMORY_CODEX_API_KEY in your shell profile."
    );
    process.exit(1);
  }

  const { content, containerTag } = parseArgs(process.argv.slice(2));

  if (!content.trim()) {
    console.log('No content provided. Usage: node save-memory.js [--container <tag>] "content to save"');
    process.exit(0);
  }

  const client = new SupermemoryClient();
  const effectiveTag = containerTag || getProjectTag(process.cwd());

  try {
    const metadata = {
      type: "project-knowledge" as const,
      source: "skill",
      timestamp: new Date().toISOString(),
    };

    const result = await client.addMemory(content, effectiveTag, metadata);

    if (result.success) {
      const tagLabel = containerTag ? `container '${containerTag}'` : `project '${effectiveTag}'`;
      console.log(`Memory saved (id: ${result.id}) to ${tagLabel}`);
    } else {
      console.log(`Failed to save memory: ${result.error}`);
    }
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    console.log(`Failed to save memory: ${message}`);
  }
}

main().catch((error) => {
  const message = error instanceof Error ? error.message : String(error);
  console.log(`Failed to save memory: ${message}`);
});
