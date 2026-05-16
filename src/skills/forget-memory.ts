import { isConfigured, validateContainerTag } from "../config.js";
import { SupermemoryClient } from "../services/client.js";
import { getProjectTag, getUserTag } from "../services/tags.js";

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
      const projectTag = getProjectTag(process.cwd());
      const userTag = getUserTag();

      const [projectResult, userResult] = await Promise.all([
        client.forgetMemory(content, projectTag),
        client.forgetMemory(content, userTag),
      ]);

      const forgotten: string[] = [];
      const errors: string[] = [];

      if (projectResult.success) {
        forgotten.push(projectResult.id ? `project (id: ${projectResult.id})` : "project");
      } else {
        errors.push(`project: ${projectResult.error}`);
      }

      if (userResult.success) {
        forgotten.push(userResult.id ? `user (id: ${userResult.id})` : "user");
      } else {
        errors.push(`user: ${userResult.error}`);
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
