import {
  mkdirSync,
  writeFileSync,
  readFileSync,
  existsSync,
  copyFileSync,
  rmSync,
} from "node:fs";
import { loadCredentials } from "./services/auth.js";
import { writeInstallDefaults, CONFIG_FILE, getRecallModeSummary, CONFIG } from "./config.js";
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
const RECALL_SCRIPT = join(SUPERMEMORY_HOOKS_DIR, "recall.js");
const FLUSH_SCRIPT = join(SUPERMEMORY_HOOKS_DIR, "flush.js");
const SESSION_START_SCRIPT = join(SUPERMEMORY_HOOKS_DIR, "session-start.js");
const CODEX_SKILLS_DIR = join(homedir(), ".codex", "skills");
const RECALL_TIMEOUT_SECONDS = 90;
const FLUSH_TIMEOUT_SECONDS = 60;
const SESSION_START_TIMEOUT_SECONDS = 60;

// Skill metadata — single source of truth for install/uninstall/status.
const SKILLS = [
  { name: "supermemory-search", script: "search-memory.js" },
  { name: "supermemory-add", script: "add-memory.js" },
  { name: "supermemory-save", script: "save-memory.js" },
  { name: "supermemory-forget", script: "forget-memory.js" },
  { name: "supermemory-status", script: "status.js" },
  { name: "supermemory-profile", script: "profile-memory.js" },
  { name: "supermemory-login", script: "login.js" },
  { name: "supermemory-logout", script: "logout.js" },
] as const;

const LEGACY_SUPERMEMORY_SCRIPTS = [
  "capture.js",
  "tags.js",
] as const;

const SCRIPT_DIR = getScriptDir();
const DIST_HOOKS_DIR = join(SCRIPT_DIR, "hooks");

function ensureCodexDir() {
  mkdirSync(CODEX_DIR, { recursive: true });
  mkdirSync(SUPERMEMORY_HOOKS_DIR, { recursive: true });
}

function mergeConfigToml(enable: boolean) {
  if (!enable && !existsSync(CODEX_CONFIG_TOML)) {
    // Nothing to disable — file doesn't exist yet.
    return;
  }

  let config: Record<string, unknown> = {};
  if (existsSync(CODEX_CONFIG_TOML)) {
    try {
      const content = readFileSync(CODEX_CONFIG_TOML, "utf-8");
      config = TOML.parse(content) as Record<string, unknown>;
    } catch {
      // start fresh
    }
  }

  // Toggle the codex_hooks feature flag.
  if (!config.features) config.features = {};
  const features = config.features as Record<string, unknown>;
  if (enable) {
    features.codex_hooks = true;
  } else {
    delete features.codex_hooks;
    // Drop the empty [features] section to keep config.toml clean.
    if (Object.keys(features).length === 0) delete config.features;
  }

  writeFileSync(CODEX_CONFIG_TOML, TOML.stringify(config as TOML.JsonMap));
}

interface HookEntry {
  type: string;
  command: string;
  timeout?: number;
  statusMessage?: string;
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

  for (const key of ["UserPromptSubmit", "Stop"] as const) {
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
): void {
  const exists = groups.some((g) => g.hooks.some((h) => h.command === command));
  if (exists) {
    for (const group of groups) {
      for (const hook of group.hooks) {
        if (hook.command === command) {
          hook.timeout = timeout;
          hook.statusMessage = statusMessage;
        }
      }
    }
  } else {
    const globalGroup = groups.find((g) => !g.matcher);
    const entry: HookEntry = { type: "command", command, timeout, statusMessage };
    if (globalGroup) {
      globalGroup.hooks.push(entry);
    } else {
      groups.push({ hooks: [entry] });
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

  let hooks: HookEvents = {};
  if (existsSync(CODEX_HOOKS_JSON)) {
    try {
      const content = readFileSync(CODEX_HOOKS_JSON, "utf-8");
      hooks = normalizeHookEvents(JSON.parse(content));
    } catch {
      // start fresh
    }
  }

  if (add) {
    const recallCmd = `node ${RECALL_SCRIPT}`;
    const flushCmd = `node ${FLUSH_SCRIPT}`;
    const sessionStartCmd = `node ${SESSION_START_SCRIPT}`;
    const oldCaptureCmd = `node ${join(SUPERMEMORY_HOOKS_DIR, "capture.js")}`;

    if (!hooks.SessionStart) hooks.SessionStart = [];
    ensureHookRegistered(
      hooks.SessionStart,
      sessionStartCmd,
      SESSION_START_TIMEOUT_SECONDS,
      "Loading memory profile...",
    );

    // Register UserPromptSubmit hook for optional per-prompt recall / turn capture
    if (!hooks.UserPromptSubmit) hooks.UserPromptSubmit = [];
    ensureHookRegistered(hooks.UserPromptSubmit, recallCmd, RECALL_TIMEOUT_SECONDS, "Searching memories...");

    // Remove old capture.js Stop hook from previous installs
    if (hooks.Stop) {
      hooks.Stop = removeHookCommands(hooks.Stop, [oldCaptureCmd]);
      if (hooks.Stop.length === 0) delete hooks.Stop;
    }

    // Register Stop hook for flush
    if (!hooks.Stop) hooks.Stop = [];
    ensureHookRegistered(hooks.Stop, flushCmd, FLUSH_TIMEOUT_SECONDS, "Saving to memory...");
  } else {
    // Remove our hooks from every MatcherGroup, then drop empty groups.
    const recallCmd = `node ${RECALL_SCRIPT}`;
    const flushCmd = `node ${FLUSH_SCRIPT}`;
    const sessionStartCmd = `node ${SESSION_START_SCRIPT}`;
    const oldCaptureCmd = `node ${join(SUPERMEMORY_HOOKS_DIR, "capture.js")}`;

    if (hooks.SessionStart) {
      hooks.SessionStart = removeHookCommands(hooks.SessionStart, [sessionStartCmd]);
      if (hooks.SessionStart.length === 0) delete hooks.SessionStart;
    }
    if (hooks.UserPromptSubmit) {
      hooks.UserPromptSubmit = removeHookCommands(hooks.UserPromptSubmit, [recallCmd]);
      if (hooks.UserPromptSubmit.length === 0) delete hooks.UserPromptSubmit;
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

  ensureCodexDir();

  const hadExistingConfig = existsSync(CONFIG_FILE);
  writeInstallDefaults(hadExistingConfig);

  // Copy hook scripts
  const recallSrc = join(DIST_HOOKS_DIR, "recall.js");
  const flushSrc = join(DIST_HOOKS_DIR, "flush.js");
  const sessionStartSrc = join(DIST_HOOKS_DIR, "session-start.js");

  if (!existsSync(recallSrc) || !existsSync(flushSrc) || !existsSync(sessionStartSrc)) {
    console.error("Error: Hook scripts not found. Please reinstall the package.");
    process.exit(1);
  }

  copyFileSync(recallSrc, RECALL_SCRIPT);
  copyFileSync(flushSrc, FLUSH_SCRIPT);
  copyFileSync(sessionStartSrc, SESSION_START_SCRIPT);

  // Remove script names left by older package layouts.
  for (const script of LEGACY_SUPERMEMORY_SCRIPTS) {
    const oldScript = join(SUPERMEMORY_HOOKS_DIR, script);
    if (existsSync(oldScript)) rmSync(oldScript);
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
  console.log(`✓ Installed hook and skill scripts to ${SUPERMEMORY_HOOKS_DIR}`);
  console.log(`✓ Installed skills to ${CODEX_SKILLS_DIR}`);

  // Merge config.toml (hooks feature flag)
  mergeConfigToml(true);
  console.log(`✓ Enabled codex_hooks in ${CODEX_CONFIG_TOML}`);

  // Merge hooks.json
  mergeHooksJson(true);
  console.log(`✓ Registered hooks in ${CODEX_HOOKS_JSON}`);

  console.log(`
Installation complete!

You now have:
  • Session-start profile recall (${getRecallModeSummary()})
  • Explicit memory — supermemory-search, supermemory-add, supermemory-save, supermemory-forget, supermemory-profile, supermemory-status, supermemory-login, and supermemory-logout skills

${hadExistingConfig
    ? "Existing install: legacy per-prompt recall/capture preserved in ~/.codex/supermemory.json.\nTo opt into new defaults, set autoRecallEveryPrompt=false and captureEveryNTurns=0.\n"
    : "Fresh install: session-start profile + session-end flush only.\nEnable autoRecallEveryPrompt or captureEveryNTurns in ~/.codex/supermemory.json if needed.\n"}

Next steps:
  1. Start Codex — on your first prompt, a browser window will open to
     authenticate with Supermemory automatically.

  Or authenticate manually:
     /supermemory-login      (inside Codex)
     export SUPERMEMORY_CODEX_API_KEY="sm_..."   (in your shell profile)

  2. Get an API key at: https://app.supermemory.ai/?view=integrations (if needed)

Optional: Enable debug logging:
  export SUPERMEMORY_DEBUG=true
`);
}

function uninstall() {
  console.log("Uninstalling codex-supermemory...\n");

  mergeHooksJson(false);
  console.log(`✓ Removed hooks from ${CODEX_HOOKS_JSON}`);

  mergeConfigToml(false);
  console.log(`✓ Disabled codex_hooks in ${CODEX_CONFIG_TOML}`);

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
    existsSync(FLUSH_SCRIPT) &&
    existsSync(SESSION_START_SCRIPT);
  const hooksJsonExists = existsSync(CODEX_HOOKS_JSON);
  const configTomlExists = existsSync(CODEX_CONFIG_TOML);

  let hooksEnabled = false;
  if (hooksJsonExists) {
    try {
      const hooks = normalizeHookEvents(JSON.parse(readFileSync(CODEX_HOOKS_JSON, "utf-8")));
      const recallCmd = `node ${RECALL_SCRIPT}`;
      const flushCmd = `node ${FLUSH_SCRIPT}`;
      const sessionStartCmd = `node ${SESSION_START_SCRIPT}`;
      const recallRegistered = hooks.UserPromptSubmit?.some((g: MatcherGroup) =>
        g.hooks.some((h: HookEntry) => h.command === recallCmd)
      );
      const flushRegistered = hooks.Stop?.some((g: MatcherGroup) =>
        g.hooks.some((h: HookEntry) => h.command === flushCmd)
      );
      const sessionStartRegistered = hooks.SessionStart?.some((g: MatcherGroup) =>
        g.hooks.some((h: HookEntry) => h.command === sessionStartCmd)
      );
      hooksEnabled = !!(recallRegistered && flushRegistered && sessionStartRegistered);
    } catch {
      // ignore
    }
  }

  const skillsInstalled = SKILLS.every(({ name }) =>
    existsSync(join(CODEX_SKILLS_DIR, name, "SKILL.md"))
  );

  console.log("codex-supermemory status:\n");
  console.log(`  API key:       ${apiKey ? `✓ set (${apiKeySource})` : "✗ not set"}`);
  console.log(`  Recall mode:   ${getRecallModeSummary()}`);
  console.log(`  Hook scripts:  ${hooksInstalled ? `✓ installed at ${SUPERMEMORY_HOOKS_DIR}` : "✗ not installed"}`);
  console.log(`  hooks.json:    ${hooksEnabled ? "✓ registered (implicit memory)" : "✗ not registered"}`);
  console.log(`  Skills:        ${skillsInstalled ? `✓ installed (${SKILLS.map(s => s.name).join(", ")})` : "✗ not installed"}`);
  console.log(`  config.toml:   ${configTomlExists ? "✓ exists" : "✗ not found"}`);

  if (!apiKey || !hooksInstalled || !hooksEnabled || !skillsInstalled) {
    console.log("\nRun `npx codex-supermemory install` to set up.");
  } else {
    console.log("\nAll good! Memory is active.");
  }
}

const command = process.argv[2];
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
