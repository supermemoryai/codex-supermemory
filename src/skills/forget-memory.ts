import { isConfigured } from "../config.js";
import { SupermemoryClient } from "../services/client.js";
import { getProjectTag, getUserTag } from "../services/tags.js";

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
  const userTag = getUserTag();

  try {
    // Forget from both project and user scopes since memories may exist in either.
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
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    console.log(`Failed to forget memory: ${message}`);
  }
}

main().catch((error) => {
  const message = error instanceof Error ? error.message : String(error);
  console.log(`Failed to forget memory: ${message}`);
});
