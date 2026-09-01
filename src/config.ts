import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { homedir } from "node:os";
import { loadCredentialData, loadCredentials } from "./services/auth.js";

export { PLUGIN_VERSION } from "./version.js";

export const CONFIG_FILE = join(homedir(), ".codex", "supermemory.json");
export const DEFAULT_BASE_URL = "https://api.supermemory.ai";

export type RecallMode = "direct" | "off" | "advisory";
export const DEFAULT_RECALL_DIRECTIVE =
  "Relevant prior context may exist in Supermemory. Search memory before answering when the request depends on previous decisions, preferences, or project history.";

interface CodexSupermemoryConfig {
  apiKey?: string;
  baseUrl?: string;
  similarityThreshold?: number;
  maxMemories?: number;
  maxProfileItems?: number;
  injectProfile?: boolean;
  containerTagPrefix?: string;
  userContainerTag?: string;
  projectContainerTag?: string;
  filterPrompt?: string;
  debug?: boolean;
  signalExtraction?: boolean;
  signalKeywords?: string[];
  signalTurnsBefore?: number;
  /** @deprecated Use captureEveryNTurns */
  autoSaveEveryTurns?: number;
  autoRecallEveryPrompt?: boolean;
  recallMode?: RecallMode;
  recallDirective?: string;
  captureEveryNTurns?: number;
}

const DEFAULT_SIGNAL_KEYWORDS = [
  "prefer", "like", "love", "use", "hate", "dislike", "avoid",
  "remember", "forget", "note",
  "decision", "decided", "chose", "choose", "picked", "switched", "moved", "migrated",
  "architecture", "pattern", "approach", "design", "tradeoff",
  "implementation", "refactor", "upgrade", "deprecate",
  "bug", "fix", "fixed", "solved", "solution", "important",
  "stack", "framework", "library", "tool", "database",
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
  signalExtraction: false,
  signalKeywords: DEFAULT_SIGNAL_KEYWORDS,
  signalTurnsBefore: 3,
  autoSaveEveryTurns: 3,
  autoRecallEveryPrompt: false,
  recallMode: "direct" as RecallMode,
  captureEveryNTurns: 0,
};

function loadRawConfig(): { config: CodexSupermemoryConfig; existed: boolean } {
  if (existsSync(CONFIG_FILE)) {
    try {
      const content = readFileSync(CONFIG_FILE, "utf-8");
      return { config: JSON.parse(content) as CodexSupermemoryConfig, existed: true };
    } catch {
      // Soft-fail for runtime reads (hooks/skills); writers must use loadRawConfigForWrite.
      return { config: {}, existed: true };
    }
  }
  return { config: {}, existed: false };
}

/** Parse supermemory.json for write paths — never treat invalid JSON as empty. */
function loadRawConfigForWrite(): { config: CodexSupermemoryConfig; existed: boolean } {
  if (!existsSync(CONFIG_FILE)) {
    return { config: {}, existed: false };
  }

  try {
    const content = readFileSync(CONFIG_FILE, "utf-8");
    return { config: JSON.parse(content) as CodexSupermemoryConfig, existed: true };
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error);
    throw new Error(
      [
        `Failed to parse ${CONFIG_FILE}.`,
        "",
        "The existing configuration contains invalid JSON.",
        detail,
        "",
        "No changes were made.",
        "Please fix the syntax error and rerun the command.",
      ].join("\n"),
    );
  }
}

const { config: fileConfig, existed: configExisted } = loadRawConfig();

function resolveCaptureEveryNTurns(config: CodexSupermemoryConfig): number {
  if (config.captureEveryNTurns !== undefined) return config.captureEveryNTurns;
  if (config.autoSaveEveryTurns !== undefined) return config.autoSaveEveryTurns;
  if (configExisted) return 3;
  return DEFAULTS.captureEveryNTurns;
}

function resolveRecallMode(config: CodexSupermemoryConfig): RecallMode {
  if (["direct", "off", "advisory"].includes(config.recallMode ?? "")) {
    return config.recallMode as RecallMode;
  }
  if (config.autoRecallEveryPrompt !== undefined) {
    return config.autoRecallEveryPrompt ? "direct" : "off";
  }
  return DEFAULTS.recallMode;
}

function getApiKey(): string | undefined {
  if (process.env.SUPERMEMORY_CODEX_API_KEY) return process.env.SUPERMEMORY_CODEX_API_KEY;
  if (fileConfig.apiKey) return fileConfig.apiKey;
  return loadCredentials();
}

export let SUPERMEMORY_API_KEY = getApiKey();

export function reloadApiKey(): void {
  SUPERMEMORY_API_KEY = getApiKey();
}

const recallMode = resolveRecallMode(fileConfig);

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
  signalExtraction: fileConfig.signalExtraction ?? DEFAULTS.signalExtraction,
  signalKeywords: fileConfig.signalKeywords ?? DEFAULTS.signalKeywords,
  signalTurnsBefore: fileConfig.signalTurnsBefore ?? DEFAULTS.signalTurnsBefore,
  autoSaveEveryTurns: fileConfig.autoSaveEveryTurns ?? DEFAULTS.autoSaveEveryTurns,
  recallMode,
  recallDirective:
    typeof fileConfig.recallDirective === "string" && fileConfig.recallDirective.trim()
      ? fileConfig.recallDirective.trim()
      : DEFAULT_RECALL_DIRECTIVE,
  /** @deprecated Prefer recallMode. */
  autoRecallEveryPrompt: recallMode === "direct",
  captureEveryNTurns: resolveCaptureEveryNTurns(fileConfig),
};

export function isConfigured(): boolean {
  return !!SUPERMEMORY_API_KEY;
}

export function getApiKeyValue(): string | undefined {
  return SUPERMEMORY_API_KEY;
}

function normalizeBaseUrl(baseUrl: unknown): string | null {
  if (typeof baseUrl !== "string" || !baseUrl.trim()) return null;

  const trimmed = baseUrl.trim();
  try {
    const url = new URL(trimmed);
    if (url.protocol !== "http:" && url.protocol !== "https:") return null;
    return trimmed;
  } catch {
    return null;
  }
}

export function getBaseUrl(): string {
  const configured =
    process.env.SUPERMEMORY_API_URL ||
    process.env.SUPERMEMORY_BASE_URL ||
    fileConfig.baseUrl ||
    loadCredentialData()?.apiBaseUrl ||
    DEFAULT_BASE_URL;
  const normalized = normalizeBaseUrl(configured);
  if (!normalized) {
    throw new Error("Invalid baseUrl: expected an absolute http(s) URL");
  }
  return normalized;
}

// Backwards-compatible alias for the credential-based accessor introduced on main.
export function getApiBaseUrl(): string {
  return getBaseUrl();
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

/** Persist explicit recall/capture defaults for fresh installs or legacy upgrades. */
export function writeInstallDefaults(_isExistingInstall: boolean): void {
  const current = loadRawConfigForWrite().config;
  const next: CodexSupermemoryConfig = { ...current };

  if (next.recallMode === undefined) {
    next.recallMode = next.autoRecallEveryPrompt === false ? "off" : "direct";
  }

  // Per-prompt capture was retired. Stop captures every completed turn.
  next.captureEveryNTurns = 0;

  writeFileSync(CONFIG_FILE, JSON.stringify(next, null, 2));
}

export function getRecallModeSummary(): string {
  if (CONFIG.recallMode === "direct") {
    return "direct: relevant recall on substantive prompts";
  }
  if (CONFIG.recallMode === "advisory") {
    return "advisory: prompt the agent to search memory when needed";
  }
  return "session-start profile + turn-stop capture";
}
