import {
  mkdirSync,
  writeFileSync,
  readFileSync,
  existsSync,
  copyFileSync,
  rmSync,
} from "node:fs";
import { loadCredentials } from "./services/auth.js";
import { writeInstallDefaults, CONFIG_FILE, getRecallModeSummary } from "./config.js";
import { join, dirname } from "node:path";
import { homedir } from "node:os";
import { fileURLToPath } from "node:url";
import * as TOML from "@iarna/toml";

// Resolve this script's directory in a way that works across both ESM and the
// CJS bundle produced by esbuild.
declare const __dirname: string | undefined;
function getScriptDir(): string {
  // CJS (esbuild's CommonJS bundle) — __dirname is provided by Node.
  if (typeof __dirname !== "undefined") {
    return __dirname;
  }
  // ESM fallback (e.g. running ts-node directly). Use eval so esbuild doesn't
  // try to resolve `import.meta` when bundling for CJS.
  // eslint-disable-next-line no-eval
  const importMetaUrl = (eval("import.meta.url") as string) ?? "";
  return dirname(fileURLToPath(importMetaUrl));
}

const CODEX_DIR = join(homedir(), ".codex");
const CODEX_CONFIG_TOML = join(CODEX_DIR, "config.toml");
const CODEX_HOOKS_JSON = join(CODEX_DIR, "hooks.json");
const SUPERMEMORY_HOOKS_DIR = join(CODEX_DIR, "supermemory");
const LOGGED_OUT_FILE = join(SUPERMEMORY_HOOKS_DIR, ".logged-out");
const RECALL_SCRIPT = join(SUPERMEMORY_HOOKS_DIR, "recall.js");
const RECALL_APPROVE_SCRIPT = join(SUPERMEMORY_HOOKS_DIR, "recall-approve.js");
const MCP_PROXY_SCRIPT = join(SUPERMEMORY_HOOKS_DIR, "mcp-proxy.js");
const FLUSH_SCRIPT = join(SUPERMEMORY_HOOKS_DIR, "flush.js");
const SESSION_START_SCRIPT = join(SUPERMEMORY_HOOKS_DIR, "session-start.js");
const CODEX_SKILLS_DIR = join(homedir(), ".codex", "skills");
const CODEX_PETS_DIR = join(CODEX_DIR, "pets");
const SUPERMEMORY_PET_DIR = join(CODEX_PETS_DIR, "supermemory");
const SUPERMEMORY_PET_MARKER = join(SUPERMEMORY_PET_DIR, ".codex-supermemory-owned");
const SUPERMEMORY_PET_ID = "supermemory";
const RECALL_TIMEOUT_SECONDS = 5;
const RECALL_APPROVE_TIMEOUT_SECONDS = 5;
const FLUSH_TIMEOUT_SECONDS = 30;
const SESSION_START_TIMEOUT_SECONDS = 30;
const SUPERMEMORY_MCP_MATCHER = "^mcp__supermemory__";

// Skill metadata — single source of truth for install/uninstall/status.
const SKILLS = [
  { name: "supermemory-status", script: "status.js" },
] as const;

const LEGACY_SUPERMEMORY_SCRIPTS = [
  "capture.js",
  "capture-turn.js",
  "tags.js",
  "search-memory.js",
  "add-memory.js",
  "save-memory.js",
  "forget-memory.js",
  "profile-memory.js",
  "login.js",
  "logout.js",
] as const;

const LEGACY_SKILLS = [
  "supermemory-search",
  "supermemory-add",
  "supermemory-save",
  "supermemory-forget",
  "supermemory-profile",
  "supermemory-login",
  "supermemory-logout",
] as const;

const SCRIPT_DIR = getScriptDir();
const DIST_HOOKS_DIR = join(SCRIPT_DIR, "hooks");
const DIST_PET_DIR = join(SCRIPT_DIR, "pet");

function configParseError(filePath: string, parser: string, cause: unknown): Error {
  const detail = cause instanceof Error ? cause.message : String(cause);
  return new Error(
    [
      `Failed to parse ${filePath}.`,
      "",
      `The existing configuration contains invalid ${parser}.`,
      detail,
      "",
      "No changes were made.",
      "Please fix the syntax error and rerun the command.",
    ].join("\n"),
  );
}

function ensureCodexDir() {
  mkdirSync(CODEX_DIR, { recursive: true });
  mkdirSync(SUPERMEMORY_HOOKS_DIR, { recursive: true });
}

/** Parse existing Codex config files, or throw before any install/uninstall writes. */
function assertCodexConfigReadable(): void {
  readConfigToml();
  readHooksJson();
}

function readConfigToml(): Record<string, unknown> {
  if (!existsSync(CODEX_CONFIG_TOML)) return {};

  try {
    const content = readFileSync(CODEX_CONFIG_TOML, "utf-8");
    return TOML.parse(content) as Record<string, unknown>;
  } catch (error) {
    throw configParseError(CODEX_CONFIG_TOML, "TOML", error);
  }
}

function readHooksJson(): HookEvents {
  if (!existsSync(CODEX_HOOKS_JSON)) return {};

  try {
    const content = readFileSync(CODEX_HOOKS_JSON, "utf-8");
    return normalizeHookEvents(JSON.parse(content));
  } catch (error) {
    throw configParseError(CODEX_HOOKS_JSON, "JSON", error);
  }
}

function ownsSupermemoryPet(): boolean {
  return existsSync(SUPERMEMORY_PET_MARKER);
}

function installPetAssets(): boolean {
  if (existsSync(SUPERMEMORY_PET_DIR) && !ownsSupermemoryPet()) {
    console.warn(
      `! Kept existing unowned pet directory at ${SUPERMEMORY_PET_DIR}`,
    );
    return false;
  }

  mkdirSync(SUPERMEMORY_PET_DIR, { recursive: true });
  copyFileSync(join(DIST_PET_DIR, "pet.json"), join(SUPERMEMORY_PET_DIR, "pet.json"));
  copyFileSync(
    join(DIST_PET_DIR, "spritesheet.png"),
    join(SUPERMEMORY_PET_DIR, "spritesheet.png"),
  );
  writeFileSync(SUPERMEMORY_PET_MARKER, "codex-supermemory\n");
  return true;
}

function removePetAssets(): void {
  if (ownsSupermemoryPet()) {
    rmSync(SUPERMEMORY_PET_DIR, { recursive: true, force: true });
  }
}

function mergeConfigToml(enable: boolean, managePet: boolean): boolean {
  if (!enable && !existsSync(CODEX_CONFIG_TOML)) {
    // Nothing to disable — file doesn't exist yet.
    return false;
  }

  const config = readConfigToml();
  let persistentIndicatorEnabled = false;

  // Hooks are enabled by default in current Codex. Remove only the deprecated
  // alias written by older codex-supermemory releases; preserve any explicit
  // user choice for the canonical `features.hooks` key.
  const features = config.features as Record<string, unknown> | undefined;
  if (features) {
    delete features.codex_hooks;
    if (Object.keys(features).length === 0) delete config.features;
  }

  if (enable) {
    if (!config.mcp_servers) config.mcp_servers = {};
    const mcpServers = config.mcp_servers as Record<string, unknown>;

    // Merge so user-set fields (enabled, timeouts, env, approvals) survive updates.
    const existing = mcpServers.supermemory;
    const server: Record<string, unknown> =
      existing && typeof existing === "object" && !Array.isArray(existing)
        ? { ...(existing as Record<string, unknown>) }
        : {};

    server.command = "node";
    server.args = [MCP_PROXY_SCRIPT];

    const envVars = Array.isArray(server.env_vars)
      ? server.env_vars.filter((v): v is string => typeof v === "string")
      : [];
    if (!envVars.includes("SUPERMEMORY_CODEX_API_KEY")) {
      envVars.push("SUPERMEMORY_CODEX_API_KEY");
    }
    server.env_vars = envVars;

    // stdio entry — these are streamable-HTTP only.
    delete server.url;
    delete server.bearer_token_env_var;

    mcpServers.supermemory = server;

    if (managePet) {
      if (!config.tui) config.tui = {};
      const tui = config.tui as Record<string, unknown>;
      const hasPetSelection = Object.prototype.hasOwnProperty.call(tui, "pet");
      if (!hasPetSelection) {
        tui.pet = SUPERMEMORY_PET_ID;
        tui.pet_anchor = "screen-bottom";
      } else if (tui.pet === SUPERMEMORY_PET_ID && tui.pet_anchor === undefined) {
        tui.pet_anchor = "screen-bottom";
      }
      persistentIndicatorEnabled = tui.pet === SUPERMEMORY_PET_ID;
    }
  } else {
    const mcpServers = config.mcp_servers as Record<string, unknown> | undefined;
    const server = mcpServers?.supermemory as Record<string, unknown> | undefined;
    if (
      server?.command === "node" &&
      Array.isArray(server.args) &&
      server.args.length === 1 &&
      server.args[0] === MCP_PROXY_SCRIPT
    ) {
      if (mcpServers) delete mcpServers.supermemory;
      if (mcpServers && Object.keys(mcpServers).length === 0) delete config.mcp_servers;
    }

    const tui = config.tui as Record<string, unknown> | undefined;
    if (managePet && tui?.pet === SUPERMEMORY_PET_ID) {
      delete tui.pet;
      if (tui.pet_anchor === "screen-bottom") delete tui.pet_anchor;
      if (Object.keys(tui).length === 0) delete config.tui;
    }
  }

  writeFileSync(CODEX_CONFIG_TOML, TOML.stringify(config as TOML.JsonMap));
  return persistentIndicatorEnabled;
}

interface HookEntry {
  type: string;
  command: string;
  timeout?: number;
  statusMessage?: string;
  async?: boolean;
}

// Codex hooks.json schema: each event key maps to an array of MatcherGroup objects.
// See HookEventsToml / MatcherGroup in the Codex source.
interface MatcherGroup {
  matcher?: string;
  hooks: HookEntry[];
}

interface HookEvents {
  UserPromptSubmit?: MatcherGroup[];
  Stop?: MatcherGroup[];
  [key: string]: MatcherGroup[] | undefined;
}

interface HooksJson {
  hooks?: HookEvents;
}

function normalizeHookEvents(raw: unknown): HookEvents {
  if (!raw || typeof raw !== "object") return {};

  const maybeWrapped = raw as HooksJson & HookEvents;
  // Codex expects hooks.json to contain a top-level `hooks` object. Older
  // codex-supermemory versions accidentally wrote event keys at the root, so
  // accept both shapes and always write back the documented one.
  const events =
    maybeWrapped.hooks && typeof maybeWrapped.hooks === "object"
      ? maybeWrapped.hooks
      : (maybeWrapped as HookEvents);

  for (const key of ["SessionStart", "UserPromptSubmit", "PreToolUse", "Stop"] as const) {
    const val = events[key];
    if (val !== undefined && !Array.isArray(val)) {
      events[key] = [val as unknown as MatcherGroup];
    }
  }

  return events;
}

/**
 * Ensure a hook is registered in the given event's MatcherGroup array.
 * If the command already exists, update its timeout and statusMessage.
 * Otherwise, append it to an existing global (no-matcher) group or create one.
 */
function ensureHookRegistered(
  groups: MatcherGroup[],
  command: string,
  timeout: number,
  statusMessage: string,
  background = false,
  matcher?: string,
): void {
  const exists = groups.some((g) => g.hooks.some((h) => h.command === command));
  if (exists) {
    for (const group of groups) {
      for (const hook of group.hooks) {
        if (hook.command === command) {
          hook.timeout = timeout;
          hook.statusMessage = statusMessage;
          if (background) hook.async = true;
          else delete hook.async;
        }
      }
    }
  } else {
    const matchingGroup = groups.find((g) =>
      matcher ? g.matcher === matcher : !g.matcher
    );
    const entry: HookEntry = {
      type: "command",
      command,
      timeout,
      statusMessage,
      ...(background ? { async: true } : {}),
    };
    if (matchingGroup) {
      matchingGroup.hooks.push(entry);
    } else {
      groups.push({ ...(matcher ? { matcher } : {}), hooks: [entry] });
    }
  }
}

/**
 * Remove all hooks matching any of the given commands from an event's groups.
 * Returns the filtered groups (empty groups are dropped).
 */
function removeHookCommands(
  groups: MatcherGroup[],
  commands: string[],
): MatcherGroup[] {
  return groups
    .map((g) => ({ ...g, hooks: g.hooks.filter((h) => !commands.includes(h.command)) }))
    .filter((g) => g.hooks.length > 0);
}

function mergeHooksJson(add: boolean) {
  if (!add && !existsSync(CODEX_HOOKS_JSON)) {
    // Nothing to remove — file doesn't exist yet.
    return;
  }

  const hooks = readHooksJson();

  if (add) {
    const recallCmd = `node ${RECALL_SCRIPT}`;
    const recallApproveCmd = `node ${RECALL_APPROVE_SCRIPT}`;
    const flushCmd = `node ${FLUSH_SCRIPT}`;
    const sessionStartCmd = `node ${SESSION_START_SCRIPT}`;
    const oldCaptureCmd = `node ${join(SUPERMEMORY_HOOKS_DIR, "capture.js")}`;
    const oldTurnCaptureCmd = `node ${join(SUPERMEMORY_HOOKS_DIR, "capture-turn.js")}`;

    if (!hooks.SessionStart) hooks.SessionStart = [];
    ensureHookRegistered(
      hooks.SessionStart,
      sessionStartCmd,
      SESSION_START_TIMEOUT_SECONDS,
      "Loading memory profile...",
    );

    // Recall must stay synchronous because its output is injected.
    if (!hooks.UserPromptSubmit) hooks.UserPromptSubmit = [];
    ensureHookRegistered(hooks.UserPromptSubmit, recallCmd, RECALL_TIMEOUT_SECONDS, "Searching memories...");

    // Remove the old per-prompt capture hook. Stop now owns automatic capture.
    hooks.UserPromptSubmit = removeHookCommands(
      hooks.UserPromptSubmit,
      [oldTurnCaptureCmd],
    );

    if (!hooks.PreToolUse) hooks.PreToolUse = [];
    ensureHookRegistered(
      hooks.PreToolUse,
      recallApproveCmd,
      RECALL_APPROVE_TIMEOUT_SECONDS,
      "Checking Supermemory recall...",
      false,
      SUPERMEMORY_MCP_MATCHER,
    );

    // Remove old capture.js Stop hook from previous installs
    if (hooks.Stop) {
      hooks.Stop = removeHookCommands(hooks.Stop, [oldCaptureCmd]);
      if (hooks.Stop.length === 0) delete hooks.Stop;
    }

    // Register Stop hook for flush
    if (!hooks.Stop) hooks.Stop = [];
    ensureHookRegistered(
      hooks.Stop,
      flushCmd,
      FLUSH_TIMEOUT_SECONDS,
      "Saving to memory...",
      true,
    );
  } else {
    // Remove our hooks from every MatcherGroup, then drop empty groups.
    const recallCmd = `node ${RECALL_SCRIPT}`;
    const recallApproveCmd = `node ${RECALL_APPROVE_SCRIPT}`;
    const flushCmd = `node ${FLUSH_SCRIPT}`;
    const sessionStartCmd = `node ${SESSION_START_SCRIPT}`;
    const oldCaptureCmd = `node ${join(SUPERMEMORY_HOOKS_DIR, "capture.js")}`;
    const oldTurnCaptureCmd = `node ${join(SUPERMEMORY_HOOKS_DIR, "capture-turn.js")}`;

    if (hooks.SessionStart) {
      hooks.SessionStart = removeHookCommands(hooks.SessionStart, [sessionStartCmd]);
      if (hooks.SessionStart.length === 0) delete hooks.SessionStart;
    }
    if (hooks.UserPromptSubmit) {
      hooks.UserPromptSubmit = removeHookCommands(
        hooks.UserPromptSubmit,
        [recallCmd, oldTurnCaptureCmd],
      );
      if (hooks.UserPromptSubmit.length === 0) delete hooks.UserPromptSubmit;
    }
    if (hooks.PreToolUse) {
      hooks.PreToolUse = removeHookCommands(hooks.PreToolUse, [recallApproveCmd]);
      if (hooks.PreToolUse.length === 0) delete hooks.PreToolUse;
    }
    if (hooks.Stop) {
      hooks.Stop = removeHookCommands(hooks.Stop, [flushCmd, oldCaptureCmd]);
      if (hooks.Stop.length === 0) delete hooks.Stop;
    }
  }

  writeFileSync(CODEX_HOOKS_JSON, JSON.stringify({ hooks }, null, 2));
}

function install() {
  console.log("Installing codex-supermemory...\n");

  assertCodexConfigReadable();
  ensureCodexDir();

  const hadExistingConfig = existsSync(CONFIG_FILE);
  writeInstallDefaults(hadExistingConfig);

  // Copy hook scripts
  const recallSrc = join(DIST_HOOKS_DIR, "recall.js");
  const recallApproveSrc = join(DIST_HOOKS_DIR, "recall-approve.js");
  const mcpProxySrc = join(DIST_HOOKS_DIR, "mcp-proxy.js");
  const flushSrc = join(DIST_HOOKS_DIR, "flush.js");
  const sessionStartSrc = join(DIST_HOOKS_DIR, "session-start.js");
  const petManifestSrc = join(DIST_PET_DIR, "pet.json");
  const petSpritesheetSrc = join(DIST_PET_DIR, "spritesheet.png");

  if (
    !existsSync(recallSrc) ||
    !existsSync(recallApproveSrc) ||
    !existsSync(mcpProxySrc) ||
    !existsSync(flushSrc) ||
    !existsSync(sessionStartSrc) ||
    !existsSync(petManifestSrc) ||
    !existsSync(petSpritesheetSrc)
  ) {
    console.error("Error: Installation assets not found. Please reinstall the package.");
    process.exit(1);
  }

  copyFileSync(recallSrc, RECALL_SCRIPT);
  copyFileSync(recallApproveSrc, RECALL_APPROVE_SCRIPT);
  copyFileSync(mcpProxySrc, MCP_PROXY_SCRIPT);
  copyFileSync(flushSrc, FLUSH_SCRIPT);
  copyFileSync(sessionStartSrc, SESSION_START_SCRIPT);

  // Remove script names left by older package layouts.
  for (const script of LEGACY_SUPERMEMORY_SCRIPTS) {
    const oldScript = join(SUPERMEMORY_HOOKS_DIR, script);
    if (existsSync(oldScript)) rmSync(oldScript);
  }
  if (existsSync(LOGGED_OUT_FILE)) rmSync(LOGGED_OUT_FILE);

  // Remove command skills retired by the hosted MCP architecture.
  for (const name of LEGACY_SKILLS) {
    const skillDir = join(CODEX_SKILLS_DIR, name);
    if (existsSync(skillDir)) rmSync(skillDir, { recursive: true, force: true });
  }

  // Copy skill scripts and SKILL.md files
  for (const { name, script } of SKILLS) {
    copyFileSync(
      join(SCRIPT_DIR, "skills", script),
      join(SUPERMEMORY_HOOKS_DIR, script)
    );
    const skillDir = join(CODEX_SKILLS_DIR, name);
    mkdirSync(skillDir, { recursive: true });
    copyFileSync(
      join(SCRIPT_DIR, "skills", name, "SKILL.md"),
      join(skillDir, "SKILL.md")
    );
  }
  console.log(`✓ Installed hooks and MCP proxy to ${SUPERMEMORY_HOOKS_DIR}`);
  console.log(`✓ Installed the supermemory-status skill to ${CODEX_SKILLS_DIR}`);

  // Install the persistent TUI mark without overwriting an existing pet.
  const petInstalled = installPetAssets();

  // Merge config.toml (hosted MCP server + persistent mark)
  const persistentIndicatorEnabled = mergeConfigToml(true, petInstalled);
  console.log(`✓ Registered the Supermemory MCP server in ${CODEX_CONFIG_TOML}`);
  if (persistentIndicatorEnabled) {
    console.log("✓ Enabled the persistent Supermemory mark at the bottom of Codex");
  } else if (petInstalled) {
    console.log("✓ Installed the Supermemory mark and preserved your existing Codex pet selection");
  }

  // Merge hooks.json
  mergeHooksJson(true);
  console.log(`✓ Registered hooks in ${CODEX_HOOKS_JSON}`);

  console.log(`
Installation complete!

You now have:
  • Automatic session and prompt recall (${getRecallModeSummary()})
  • Hosted Supermemory MCP tools for deeper search and explicit memory operations
  • The supermemory-status skill for connection diagnostics
  • A persistent Supermemory mark in compatible Codex terminals${persistentIndicatorEnabled ? "" : " (existing pet selection preserved)"}

${hadExistingConfig
    ? "Existing recall/capture preferences were preserved in ~/.codex/supermemory.json.\nSet recallMode to direct, off, or advisory to change recall behavior.\n"
    : "Fresh install: direct relevant-memory recall plus session-start profile and turn-stop flush.\nSet recallMode to off or advisory in ~/.codex/supermemory.json if preferred.\n"}

Next steps:
  1. Start Codex — on your first prompt, a browser window will open to
     authenticate with Supermemory automatically.

  Or set SUPERMEMORY_CODEX_API_KEY="sm_..." in your shell profile.

  2. Get an API key at: https://console.supermemory.ai (if needed)

Optional: Enable debug logging:
  export SUPERMEMORY_DEBUG=true
`);
}

function uninstall() {
  console.log("Uninstalling codex-supermemory...\n");

  assertCodexConfigReadable();
  mergeHooksJson(false);
  console.log(`✓ Removed hooks from ${CODEX_HOOKS_JSON}`);

  const petOwned = ownsSupermemoryPet();
  mergeConfigToml(false, petOwned);
  console.log(`✓ Removed the Supermemory MCP server from ${CODEX_CONFIG_TOML}`);

  removePetAssets();
  if (petOwned) console.log(`✓ Removed the persistent Supermemory mark from ${SUPERMEMORY_PET_DIR}`);

  if (existsSync(SUPERMEMORY_HOOKS_DIR)) {
    rmSync(SUPERMEMORY_HOOKS_DIR, { recursive: true, force: true });
    console.log(`✓ Removed ${SUPERMEMORY_HOOKS_DIR}`);
  }

  // Remove skill directories
  for (const { name } of SKILLS) {
    const skillDir = join(CODEX_SKILLS_DIR, name);
    if (existsSync(skillDir)) {
      rmSync(skillDir, { recursive: true, force: true });
    }
  }
  console.log(`✓ Removed skills from ${CODEX_SKILLS_DIR}`);

  console.log("\ncodex-supermemory uninstalled.");
}

function status() {
  const envApiKey = process.env.SUPERMEMORY_CODEX_API_KEY;
  const credentialsApiKey = !envApiKey ? loadCredentials() : undefined;
  const apiKey = envApiKey || credentialsApiKey;
  const apiKeySource = envApiKey
    ? "SUPERMEMORY_CODEX_API_KEY env var"
    : credentialsApiKey
    ? "credentials file (~/.codex/supermemory/credentials.json)"
    : null;

  const hooksInstalled =
    existsSync(RECALL_SCRIPT) &&
    existsSync(RECALL_APPROVE_SCRIPT) &&
    existsSync(MCP_PROXY_SCRIPT) &&
    existsSync(FLUSH_SCRIPT) &&
    existsSync(SESSION_START_SCRIPT);
  const hooksJsonExists = existsSync(CODEX_HOOKS_JSON);
  const configTomlExists = existsSync(CODEX_CONFIG_TOML);

  let hooksEnabled = false;
  if (hooksJsonExists) {
    try {
      const hooks = normalizeHookEvents(JSON.parse(readFileSync(CODEX_HOOKS_JSON, "utf-8")));
      const recallCmd = `node ${RECALL_SCRIPT}`;
      const recallApproveCmd = `node ${RECALL_APPROVE_SCRIPT}`;
      const flushCmd = `node ${FLUSH_SCRIPT}`;
      const sessionStartCmd = `node ${SESSION_START_SCRIPT}`;
      const recallRegistered = hooks.UserPromptSubmit?.some((g: MatcherGroup) =>
        g.hooks.some((h: HookEntry) => h.command === recallCmd)
      );
      const recallApproveRegistered = hooks.PreToolUse?.some((g: MatcherGroup) =>
        g.matcher === SUPERMEMORY_MCP_MATCHER &&
        g.hooks.some((h: HookEntry) => h.command === recallApproveCmd)
      );
      const flushRegistered = hooks.Stop?.some((g: MatcherGroup) =>
        g.hooks.some((h: HookEntry) => h.command === flushCmd && h.async === true)
      );
      const sessionStartRegistered = hooks.SessionStart?.some((g: MatcherGroup) =>
        g.hooks.some((h: HookEntry) => h.command === sessionStartCmd)
      );
      hooksEnabled = !!(
        recallRegistered &&
        recallApproveRegistered &&
        flushRegistered &&
        sessionStartRegistered
      );
    } catch {
      // ignore
    }
  }

  const statusSkillInstalled = SKILLS.every(({ name }) =>
    existsSync(join(CODEX_SKILLS_DIR, name, "SKILL.md"))
  );

  let mcpInstalled = false;
  let persistentIndicatorEnabled = false;
  if (configTomlExists) {
    try {
      const config = readConfigToml();
      const server = (config.mcp_servers as Record<string, unknown> | undefined)
        ?.supermemory as Record<string, unknown> | undefined;
      mcpInstalled = server?.command === "node" &&
        Array.isArray(server.args) &&
        server.args.length === 1 &&
        server.args[0] === MCP_PROXY_SCRIPT;
      persistentIndicatorEnabled =
        (config.tui as Record<string, unknown> | undefined)?.pet === SUPERMEMORY_PET_ID &&
        ownsSupermemoryPet();
    } catch {}
  }

  console.log("codex-supermemory status:\n");
  console.log(`  API key:       ${apiKey ? `✓ set (${apiKeySource})` : "✗ not set"}`);
  console.log(`  Recall mode:   ${getRecallModeSummary()}`);
  console.log(`  Hook scripts:  ${hooksInstalled ? `✓ installed at ${SUPERMEMORY_HOOKS_DIR}` : "✗ not installed"}`);
  console.log(`  hooks.json:    ${hooksEnabled ? "✓ registered (implicit memory)" : "✗ not registered"}`);
  console.log(`  MCP server:    ${mcpInstalled ? "✓ registered (hosted tools via local proxy)" : "✗ not registered"}`);
  console.log(`  Status skill:  ${statusSkillInstalled ? "✓ installed" : "✗ not installed"}`);
  console.log(`  Persistent mark: ${persistentIndicatorEnabled ? "✓ enabled" : ownsSupermemoryPet() ? "○ installed, another pet selection is active" : "✗ not installed"}`);
  console.log(`  config.toml:   ${configTomlExists ? "✓ exists" : "✗ not found"}`);

  if (!apiKey || !hooksInstalled || !hooksEnabled || !mcpInstalled || !statusSkillInstalled) {
    console.log("\nRun `npx codex-supermemory install` to set up.");
  } else {
    console.log("\nAll good! Memory is active.");
  }
}

const command = process.argv[2];
try {
  switch (command) {
    case "install":
      install();
      break;
    case "uninstall":
      uninstall();
      break;
    case "status":
      status();
      break;
    default:
      console.log("Usage: codex-supermemory <install|uninstall|status>");
      process.exit(1);
  }
} catch (error) {
  console.error(error instanceof Error ? error.message : String(error));
  process.exit(1);
}
