import { isConfigured } from "../config.js";
import { SupermemoryClient, USER_ENTITY_CONTEXT } from "../services/client.js";
import { getPersonalTag, getProjectName } from "../services/tags.js";

async function main(): Promise<void> {
  if (!isConfigured()) {
    console.error(
      "Supermemory is not authenticated.\n" +
      "Run /supermemory-login to connect, or set SUPERMEMORY_CODEX_API_KEY in your shell profile.",
    );
    process.exit(1);
  }

  const content = process.argv.slice(2).join(" ").trim();
  if (!content) {
    console.log('No content provided. Usage: node add-memory.js "content to remember"');
    process.exit(0);
  }

  const cwd = process.cwd();
  const containerTag = getPersonalTag(cwd);
  const projectName = getProjectName(cwd);
  const client = new SupermemoryClient();
  const result = await client.addMemory(
    content,
    containerTag,
    {
      type: "manual",
      project: projectName,
      sm_scope: "personal",
      sm_capture_mode: "explicit",
      timestamp: new Date().toISOString(),
    },
    { entityContext: USER_ENTITY_CONTEXT },
  );

  if (!result.success) {
    console.log(`Failed to add personal memory: ${result.error}`);
    return;
  }
  console.log(`Personal memory added for ${projectName} (id: ${result.id})`);
}

main().catch((error) => {
  console.error(`Failed to add personal memory: ${error instanceof Error ? error.message : String(error)}`);
  process.exit(1);
});
