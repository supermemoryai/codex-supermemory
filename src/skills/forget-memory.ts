import { isConfigured } from "../config.js";
import { SupermemoryClient } from "../services/client.js";
import { getProjectTag } from "../services/tags.js";

async function main(): Promise<void> {
  if (!isConfigured()) {
    console.log(
      "Supermemory API key not configured. Set SUPERMEMORY_CODEX_API_KEY environment variable."
    );
    process.exit(0);
  }

  const content = process.argv.slice(2).join(" ");

  if (!content.trim()) {
    console.log(
      'No content provided. Usage: node forget-memory.js "content to forget"'
    );
    process.exit(0);
  }

  const client = new SupermemoryClient();
  const projectTag = getProjectTag(process.cwd());

  try {
    const result = await client.forgetMemory(content, projectTag);

    if (result.success) {
      if (result.id) {
        console.log(`Memory forgotten (id: ${result.id})`);
      } else {
        console.log("Memory forgotten");
      }
    } else {
      console.log(`Failed to forget memory: ${result.error}`);
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
