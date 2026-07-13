import { isConfigured, validateContainerTag } from "../config.js";
import { SupermemoryClient } from "../services/client.js";
import { getTags } from "../services/tags.js";

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
    console.log(
      'No content provided. Usage: node forget-memory.js [--container <tag>] "content to forget"'
    );
    process.exit(0);
  }

  const client = new SupermemoryClient();

  if (containerTag) {
    const validationError = validateContainerTag(containerTag);
    if (validationError) {
      console.log(validationError);
      process.exit(1);
    }
  }

  try {
    if (containerTag) {
      const result = await client.forgetMemory(content, containerTag);
      if (result.success) {
        console.log(`Memory forgotten from container '${containerTag}'${result.id ? ` (id: ${result.id})` : ""}`);
      } else {
        console.log(`Failed to forget memory from container '${containerTag}': ${result.error}`);
      }
    } else {
      const tags = getTags(process.cwd());
      const targetTags = [...new Set([...tags.personalReads, ...tags.projectReads])];
      const results = await Promise.all(
        targetTags.map(async (tag) => ({
          tag,
          result: await client.forgetMemory(content, tag),
        })),
      );

      const forgotten: string[] = [];
      const errors: string[] = [];

      for (const { tag, result } of results) {
        if (result.success) {
          forgotten.push(result.id ? `${tag} (id: ${result.id})` : tag);
        } else {
          errors.push(`${tag}: ${result.error}`);
        }
      }

      if (forgotten.length > 0) {
        console.log(`Memory forgotten from: ${forgotten.join(", ")}`);
      } else {
        console.log(`Failed to forget memory: ${errors.join("; ")}`);
      }
    }
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    console.log(`Failed to forget memory: ${message}`);
  }
}

main().catch((error) => {
  const message = error instanceof Error ? error.message : String(error);
  console.log(`Failed to forget memory: ${message}`);
});
