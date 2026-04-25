import {
  mkdirSync,
  writeFileSync,
  readFileSync,
  existsSync,
  copyFileSync,
  rmSync,
} from "node:fs";
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
const CAPTURE_SCRIPT = join(SUPERMEMORY_HOOKS_DIR, "capture.js");

const SCRIPT_DIR = getScriptDir();
const DIST_HOOKS_DIR = join(SCRIPT_DIR, "hooks");

function ensureCodexDir() {
  mkdirSync(CODEX_DIR, { recursive: true });
  mkdirSync(SUPERMEMORY_HOOKS_DIR, { recursive: true });
}

function mergeConfigToml(enable: boolean) {
  let config: Record<string, unknown> = {};
  if (existsSync(CODEX_CONFIG_TOML)) {
    try {
      const content = readFileSync(CODEX_CONFIG_TOML, "utf-8");
      config = TOML.parse(content) as Record<string, unknown>;
    } catch {
      // start fresh
    }
  }

  if (!config.features) config.features = {};
  const features = config.features as Record<string, unknown>;
  if (enable) {
    features.codex_hooks = true;
  } else {
    delete features.codex_hooks;
  }

  writeFileSync(CODEX_CONFIG_TOML, TOML.stringify(config as TOML.JsonMap));
}

interface HookEntry {
  type: string;
  command: string;
  timeout?: number;
  statusMessage?: string;
}

interface HooksJson {
  UserPromptSubmit?: { hooks: HookEntry[] };
  Stop?: { hooks: HookEntry[] };
  [key: string]: { hooks: HookEntry[] } | undefined;
}

function mergeHooksJson(add: boolean) {
  let hooks: HooksJson = {};
  if (existsSync(CODEX_HOOKS_JSON)) {
    try {
      const content = readFileSync(CODEX_HOOKS_JSON, "utf-8");
      hooks = JSON.parse(content) as HooksJson;
    } catch {
      // start fresh
    }
  }

  if (add) {
    // Add UserPromptSubmit hook (dedup by command)
    if (!hooks.UserPromptSubmit) hooks.UserPromptSubmit = { hooks: [] };
    const recallCmd = `node ${RECALL_SCRIPT}`;
    const hasRecall = hooks.UserPromptSubmit.hooks.some((h) => h.command === recallCmd);
    if (!hasRecall) {
      hooks.UserPromptSubmit.hooks.push({
        type: "command",
        command: recallCmd,
        timeout: 30,
        statusMessage: "Searching memories...",
      });
    }

    // Add Stop hook (dedup by command)
    if (!hooks.Stop) hooks.Stop = { hooks: [] };
    const captureCmd = `node ${CAPTURE_SCRIPT}`;
    const hasCapture = hooks.Stop.hooks.some((h) => h.command === captureCmd);
    if (!hasCapture) {
      hooks.Stop.hooks.push({
        type: "command",
        command: captureCmd,
        timeout: 60,
        statusMessage: "Saving to memory...",
      });
    }
  } else {
    // Remove our hooks
    const recallCmd = `node ${RECALL_SCRIPT}`;
    const captureCmd = `node ${CAPTURE_SCRIPT}`;
    if (hooks.UserPromptSubmit) {
      hooks.UserPromptSubmit.hooks = hooks.UserPromptSubmit.hooks.filter(
        (h) => h.command !== recallCmd
      );
    }
    if (hooks.Stop) {
      hooks.Stop.hooks = hooks.Stop.hooks.filter((h) => h.command !== captureCmd);
    }
  }

  writeFileSync(CODEX_HOOKS_JSON, JSON.stringify(hooks, null, 2));
}

function install() {
  console.log("Installing codex-supermemory...\n");

  ensureCodexDir();

  // Copy hook scripts
  const recallSrc = join(DIST_HOOKS_DIR, "recall.js");
  const captureSrc = join(DIST_HOOKS_DIR, "capture.js");

  if (!existsSync(recallSrc) || !existsSync(captureSrc)) {
    console.error("Error: Hook scripts not found. Please reinstall the package.");
    process.exit(1);
  }

  copyFileSync(recallSrc, RECALL_SCRIPT);
  copyFileSync(captureSrc, CAPTURE_SCRIPT);
  console.log(`✓ Hook scripts installed to ${SUPERMEMORY_HOOKS_DIR}`);

  // Merge config.toml
  mergeConfigToml(true);
  console.log(`✓ Enabled codex_hooks in ${CODEX_CONFIG_TOML}`);

  // Merge hooks.json
  mergeHooksJson(true);
  console.log(`✓ Registered hooks in ${CODEX_HOOKS_JSON}`);

  console.log(`
Installation complete!

Next steps:
  1. Add your API key to your shell profile:
     export SUPERMEMORY_CODEX_API_KEY="sm_..."

  2. Get your API key at: https://console.supermemory.ai/keys

  3. Restart Codex CLI to activate memory.

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

  console.log("\ncodex-supermemory uninstalled.");
}

function status() {
  const apiKey = process.env.SUPERMEMORY_CODEX_API_KEY;
  const hooksInstalled = existsSync(RECALL_SCRIPT) && existsSync(CAPTURE_SCRIPT);
  const hooksJsonExists = existsSync(CODEX_HOOKS_JSON);
  const configTomlExists = existsSync(CODEX_CONFIG_TOML);

  let hooksEnabled = false;
  if (hooksJsonExists) {
    try {
      const hooks = JSON.parse(readFileSync(CODEX_HOOKS_JSON, "utf-8")) as HooksJson;
      const recallCmd = `node ${RECALL_SCRIPT}`;
      hooksEnabled = !!(
        hooks.UserPromptSubmit?.hooks?.some((h) => h.command === recallCmd)
      );
    } catch {
      // ignore
    }
  }

  console.log("codex-supermemory status:\n");
  console.log(`  API key:       ${apiKey ? "✓ set (SUPERMEMORY_CODEX_API_KEY)" : "✗ not set"}`);
  console.log(`  Hook scripts:  ${hooksInstalled ? `✓ installed at ${SUPERMEMORY_HOOKS_DIR}` : "✗ not installed"}`);
  console.log(`  hooks.json:    ${hooksEnabled ? "✓ registered" : "✗ not registered"}`);
  console.log(`  config.toml:   ${configTomlExists ? "✓ exists" : "✗ not found"}`);

  if (!apiKey || !hooksInstalled || !hooksEnabled) {
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
