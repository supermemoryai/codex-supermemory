import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";
import { SupermemoryClient } from "./services/client.js";
import { isConfigured, CONFIG } from "./config.js";
import { getProjectTag, getUserTag } from "./services/tags.js";
import { formatContextForPrompt } from "./services/context.js";
import { log } from "./services/logger.js";

async function main() {
  if (!isConfigured()) {
    console.error("supermemory MCP server: SUPERMEMORY_CODEX_API_KEY not set");
    process.exit(1);
  }

  const server = new McpServer({ name: "supermemory", version: "1.0.0" });
  const client = new SupermemoryClient();

  server.registerTool(
    "memory",
    {
      description:
        "Save or forget information about the user. Use 'save' when user shares preferences, facts, or asks to remember something. Use 'forget' when information is outdated or user requests removal.",
      inputSchema: {
        content: z
          .string()
          .max(200000)
          .describe("The memory content to save or forget"),
        action: z.enum(["save", "forget"]).optional().default("save"),
        containerTag: z
          .string()
          .max(128)
          .optional()
          .describe(
            "Optional project to scope memories. Defaults to current directory."
          ),
      },
    },
    async (args) => {
      const effectiveTag = args.containerTag || getProjectTag(process.cwd());
      const action = args.action ?? "save";
      log("mcp memory tool", { action, containerTag: effectiveTag });

      if (action === "forget") {
        const result = await client.forgetMemory(args.content, effectiveTag);
        if (result.success) {
          return {
            content: [
              {
                type: "text",
                text: `Memory forgotten${result.id ? ` (id: ${result.id})` : ""} from project '${effectiveTag}'.`,
              },
            ],
          };
        }
        return {
          content: [
            {
              type: "text",
              text: `Failed to forget memory: ${result.error}`,
            },
          ],
          isError: true,
        };
      }

      const result = await client.addMemory(args.content, effectiveTag, {
        type: "note",
        source: "mcp",
      } as unknown as Parameters<typeof client.addMemory>[2]);
      if (result.success) {
        return {
          content: [
            {
              type: "text",
              text: `Memory saved (id: ${result.id}) to project '${effectiveTag}'.`,
            },
          ],
        };
      }
      return {
        content: [
          {
            type: "text",
            text: `Failed to save memory: ${result.error}`,
          },
        ],
        isError: true,
      };
    }
  );

  server.registerTool(
    "recall",
    {
      description:
        "Search the user's memories. Returns relevant memories plus their profile summary.",
      inputSchema: {
        query: z
          .string()
          .max(1000)
          .describe("The search query to find relevant memories"),
        includeProfile: z.boolean().optional().default(true),
        containerTag: z
          .string()
          .max(128)
          .optional()
          .describe(
            "Optional project to scope search. Defaults to current directory."
          ),
      },
    },
    async (args) => {
      const effectiveTag = args.containerTag || getProjectTag(process.cwd());
      const includeProfile = args.includeProfile ?? true;
      log("mcp recall tool", { containerTag: effectiveTag, includeProfile });

      const searchResult = await client.searchMemories(args.query, effectiveTag);
      const profileResult = includeProfile
        ? await client.getProfile(getUserTag(), args.query)
        : { success: true as const, profile: null };

      const text = formatContextForPrompt(
        searchResult,
        profileResult,
        CONFIG.maxMemories,
        CONFIG.maxProfileItems
      );

      return {
        content: [
          {
            type: "text",
            text: text || "No relevant memories or profile found.",
          },
        ],
      };
    }
  );

  server.registerTool(
    "listProjects",
    {
      description:
        "List all available projects (container tags) for organizing memories.",
      inputSchema: {},
    },
    async () => {
      log("mcp listProjects tool");
      const result = await client.listProjects();
      if (!result.success) {
        return {
          content: [
            {
              type: "text",
              text: `Failed to list projects: ${result.error}`,
            },
          ],
          isError: true,
        };
      }
      if (result.projects.length === 0) {
        return {
          content: [
            {
              type: "text",
              text: "No projects found.",
            },
          ],
        };
      }
      const text = result.projects.map((p, i) => `${i + 1}. ${p}`).join("\n");
      return {
        content: [
          {
            type: "text",
            text: `Projects:\n${text}`,
          },
        ],
      };
    }
  );

  const transport = new StdioServerTransport();
  await server.connect(transport);
  console.error("supermemory MCP server running on stdio");
}

main().catch((error) => {
  console.error("Fatal error:", error);
  process.exit(1);
});
