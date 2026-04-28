import { isConfigured } from "../config.js";
import { SupermemoryClient } from "../services/client.js";
import { getProjectTag } from "../services/tags.js";

async function main(): Promise<void> {
  if (!isConfigured()) {
    console.error(
      "Supermemory is not authenticated.\n" +
      "Run /supermemory-login to connect, or set SUPERMEMORY_CODEX_API_KEY in your shell profile."
    );
    process.exit(1);
  }

  const content = process.argv.slice(2).join(" ");

  if (!content.trim()) {
    console.log('No content provided. Usage: node save-memory.js "content to save"');
    process.exit(0);
  }

  const client = new SupermemoryClient();
  const projectTag = getProjectTag(process.cwd());

  try {
    const metadata = {
      type: "project-knowledge" as const,
      source: "skill",
      timestamp: new Date().toISOString(),
    };

    const result = await client.addMemory(content, projectTag, metadata);

    if (result.success) {
      console.log(`Memory saved (id: ${result.id}) to project '${projectTag}'`);
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
