import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { homedir } from "node:os";
import { loadCredentials } from "./services/auth.js";

const CONFIG_FILE = join(homedir(), ".codex", "supermemory.json");

export interface CustomContainer {
  tag: string;
  description: string;
}

interface CodexSupermemoryConfig {
  apiKey?: string;
  similarityThreshold?: number;
  maxMemories?: number;
  maxProfileItems?: number;
  injectProfile?: boolean;
  containerTagPrefix?: string;
  userContainerTag?: string;
  projectContainerTag?: string;
  filterPrompt?: string;
  debug?: boolean;
  // Signal extraction settings
  signalExtraction?: boolean;
  signalKeywords?: string[];
  signalTurnsBefore?: number;
  // Auto-save interval
  autoSaveEveryTurns?: number;
  // Custom container routing
  enableCustomContainers?: boolean;
  customContainers?: CustomContainer[];
  customContainerInstructions?: string;
}

const DEFAULT_SIGNAL_KEYWORDS = [
  // Preferences (single words to match "i really like", "i always prefer", etc.)
  "prefer",
  "like",
  "love",
  "use",
  "hate",
  "dislike",
  "avoid",
  // Memory commands
  "remember",
  "forget",
  "note",
  // Decisions & Architecture
  "decision",
  "decided",
  "chose",
  "choose",
  "picked",
  "switched",
  "moved",
  "migrated",
  "architecture",
  "pattern",
  "approach",
  "design",
  "tradeoff",
  // Technical
  "implementation",
  "refactor",
  "upgrade",
  "deprecate",
  // Problem solving
  "bug",
  "fix",
  "fixed",
  "solved",
  "solution",
  "important",
  // Stack/tools
  "stack",
  "framework",
  "library",
  "tool",
  "database",
];

const DEFAULTS = {
  similarityThreshold: 0.6,
  maxMemories: 5,
  maxProfileItems: 5,
  injectProfile: true,
  containerTagPrefix: "codex",
  filterPrompt:
    "You are a stateful coding agent. Remember all the information, including but not limited to user's coding preferences, tech stack, behaviours, workflows, and any other relevant details.",
  debug: false,
  // Signal extraction - disabled by default, captures everything
  signalExtraction: false,
  signalKeywords: DEFAULT_SIGNAL_KEYWORDS,
  signalTurnsBefore: 3,
  // Auto-save interval
  autoSaveEveryTurns: 3,
};

function loadConfig(): CodexSupermemoryConfig {
  if (existsSync(CONFIG_FILE)) {
    try {
      const content = readFileSync(CONFIG_FILE, "utf-8");
      return JSON.parse(content) as CodexSupermemoryConfig;
    } catch {
      // Invalid config, use defaults
    }
  }
  return {};
}

const fileConfig = loadConfig();

function getApiKey(): string | undefined {
  if (process.env.SUPERMEMORY_CODEX_API_KEY) return process.env.SUPERMEMORY_CODEX_API_KEY;
  if (fileConfig.apiKey) return fileConfig.apiKey;
  return loadCredentials();
}

export let SUPERMEMORY_API_KEY = getApiKey();

export function reloadApiKey(): void {
  SUPERMEMORY_API_KEY = getApiKey();
}

export const CONFIG = {
  similarityThreshold: fileConfig.similarityThreshold ?? DEFAULTS.similarityThreshold,
  maxMemories: fileConfig.maxMemories ?? DEFAULTS.maxMemories,
  maxProfileItems: fileConfig.maxProfileItems ?? DEFAULTS.maxProfileItems,
  injectProfile: fileConfig.injectProfile ?? DEFAULTS.injectProfile,
  containerTagPrefix: fileConfig.containerTagPrefix ?? DEFAULTS.containerTagPrefix,
  userContainerTag: fileConfig.userContainerTag,
  projectContainerTag: fileConfig.projectContainerTag,
  filterPrompt: fileConfig.filterPrompt ?? DEFAULTS.filterPrompt,
  debug: fileConfig.debug ?? DEFAULTS.debug,
  // Signal extraction
  signalExtraction: fileConfig.signalExtraction ?? DEFAULTS.signalExtraction,
  signalKeywords: fileConfig.signalKeywords ?? DEFAULTS.signalKeywords,
  signalTurnsBefore: fileConfig.signalTurnsBefore ?? DEFAULTS.signalTurnsBefore,
  // Auto-save interval
  autoSaveEveryTurns: fileConfig.autoSaveEveryTurns ?? DEFAULTS.autoSaveEveryTurns,
  // Custom container routing
  enableCustomContainers: fileConfig.enableCustomContainers ?? false,
  customContainers: (fileConfig.customContainers ?? []).filter(
    (c): c is CustomContainer =>
      !!c && typeof c.tag === "string" && typeof c.description === "string",
  ),
  customContainerInstructions: fileConfig.customContainerInstructions ?? "",
};

export function isConfigured(): boolean {
  return !!SUPERMEMORY_API_KEY;
}

export function getApiKeyValue(): string | undefined {
  return SUPERMEMORY_API_KEY;
}

export function getSignalConfig(): {
  enabled: boolean;
  keywords: string[];
  turnsBefore: number;
} {
  return {
    enabled: CONFIG.signalExtraction,
    keywords: CONFIG.signalKeywords.map((k) => k.toLowerCase()),
    turnsBefore: CONFIG.signalTurnsBefore,
  };
}

export function getContainerCatalog(): string | null {
  if (!CONFIG.enableCustomContainers || CONFIG.customContainers.length === 0) {
    return null;
  }

  const lines: string[] = [];
  lines.push("Custom memory containers are available for organizing memories:");
  lines.push("");
  for (const c of CONFIG.customContainers) {
    lines.push(`- \`${c.tag}\`: ${c.description}`);
  }

  if (CONFIG.customContainerInstructions) {
    lines.push("");
    lines.push(CONFIG.customContainerInstructions);
  }

  lines.push("");
  lines.push(
    "When saving memories with /supermemory-save, use --container <tag> to route to a specific container.",
  );
  lines.push(
    "When searching with /supermemory-search, use --container <tag> to search a specific container.",
  );
  lines.push(
    "When forgetting with /supermemory-forget, use --container <tag> to target a specific container.",
  );
  lines.push("If no container is specified, memories go to the default project/user containers.");

  return lines.join("\n");
}

export function validateContainerTag(tag: string): string | null {
  if (!CONFIG.enableCustomContainers || CONFIG.customContainers.length === 0) {
    return null;
  }

  const validTags = CONFIG.customContainers.map((c) => c.tag);
  if (validTags.includes(tag)) {
    return null;
  }

  const validList = validTags.map((t) => `'${t}'`).join(", ");
  return `Unknown container tag '${tag}'. Valid containers: ${validList}`;
}
