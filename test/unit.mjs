/**
 * Unit tests for codex-supermemory using Node's built-in test runner.
 * Run with: node --test test/unit.mjs
 */
import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { writeFileSync, readFileSync, mkdirSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import * as TOML from "@iarna/toml";

// ─── helpers ────────────────────────────────────────────────────────────────

function makeTmpDir() {
  const dir = join(tmpdir(), `csm-test-${Date.now()}-${Math.random().toString(36).slice(2)}`);
  mkdirSync(dir, { recursive: true });
  return dir;
}

// Set up a fake $HOME with an empty .codex/ subdir. Registers an `after` hook
// on `t` that nukes the temp dir even if the test throws, so failed assertions
// don't leak directories under /tmp.
function setupCodexHome(t) {
  const tmpDir = makeTmpDir();
  const codexDir = join(tmpDir, ".codex");
  mkdirSync(codexDir, { recursive: true });
  const configPath = join(codexDir, "config.toml");
  t.after(() => rmSync(tmpDir, { recursive: true, force: true }));
  return { tmpDir, codexDir, configPath };
}

function runCli(cliBin, cmd, tmpDir) {
  return spawnSync("node", [cliBin, cmd], {
    env: { ...process.env, HOME: tmpDir, SUPERMEMORY_CODEX_API_KEY: "sm_test" },
    encoding: "utf-8",
  });
}

function readToml(path) {
  return TOML.parse(readFileSync(path, "utf-8"));
}

// Inline the stripPrivateContent logic (mirrors src/services/privacy.ts exactly)
function stripPrivateContent(s) {
  return s.replace(/<private>[\s\S]*?<\/private>/gi, "[REDACTED]");
}

// ─── stripPrivateContent ────────────────────────────────────────────────────

describe("stripPrivateContent", () => {
  test("leaves plain text unchanged", () => {
    assert.equal(stripPrivateContent("hello world"), "hello world");
  });

  test("redacts a single private block", () => {
    assert.equal(
      stripPrivateContent("before <private>secret</private> after"),
      "before [REDACTED] after"
    );
  });

  test("redacts multiple private blocks", () => {
    assert.equal(
      stripPrivateContent("<private>a</private> mid <private>b</private>"),
      "[REDACTED] mid [REDACTED]"
    );
  });

  test("redacts multiline private block", () => {
    assert.equal(stripPrivateContent("<private>\nline1\nline2\n</private>"), "[REDACTED]");
  });

  test("is case-insensitive", () => {
    assert.equal(stripPrivateContent("<PRIVATE>secret</PRIVATE>"), "[REDACTED]");
  });
});

// ─── hooks.json format ──────────────────────────────────────────────────────

describe("hooks.json format", () => {
  test("array-of-MatcherGroups shape is valid JSON", () => {
    const recallScript = "/home/user/.codex/supermemory/recall.js";
    const captureScript = "/home/user/.codex/supermemory/capture.js";

    const hooks = {
      UserPromptSubmit: [{ hooks: [{ type: "command", command: `node ${recallScript}`, timeout: 30 }] }],
      Stop: [{ hooks: [{ type: "command", command: `node ${captureScript}`, timeout: 60 }] }],
    };
    const json = JSON.stringify(hooks, null, 2);
    const parsed = JSON.parse(json);

    assert.ok(Array.isArray(parsed.UserPromptSubmit), "UserPromptSubmit must be an array");
    assert.ok(Array.isArray(parsed.UserPromptSubmit[0].hooks), "UserPromptSubmit[0].hooks must be an array");
    assert.equal(parsed.UserPromptSubmit[0].hooks[0].type, "command");
    assert.ok(Array.isArray(parsed.Stop), "Stop must be an array");
    assert.ok(Array.isArray(parsed.Stop[0].hooks), "Stop[0].hooks must be an array");
    assert.equal(parsed.Stop[0].hooks[0].type, "command");
  });

  test("dedup: adding same command twice results in exactly one entry", () => {
    const recallCmd = "/home/user/.codex/supermemory/recall.js";
    const hooks = { UserPromptSubmit: [] };

    function addRecall(h) {
      const hasRecall = h.UserPromptSubmit.some((g) =>
        g.hooks.some((e) => e.command === recallCmd)
      );
      if (!hasRecall) {
        const globalGroup = h.UserPromptSubmit.find((g) => !g.matcher);
        if (globalGroup) {
          globalGroup.hooks.push({ type: "command", command: recallCmd });
        } else {
          h.UserPromptSubmit.push({ hooks: [{ type: "command", command: recallCmd }] });
        }
      }
      return h;
    }

    addRecall(hooks);
    addRecall(hooks); // second call — should be no-op

    const total = hooks.UserPromptSubmit.flatMap((g) => g.hooks).filter(
      (e) => e.command === recallCmd
    );
    assert.equal(total.length, 1, "should have exactly one recall hook after two installs");
  });

  test("dedup: appends new global group when existing groups are all matcher-scoped", () => {
    const recallCmd = "/home/user/.codex/supermemory/recall.js";
    const hooks = {
      UserPromptSubmit: [
        { matcher: "shell", hooks: [{ type: "command", command: "other-hook" }] },
      ],
    };

    const hasRecall = hooks.UserPromptSubmit.some((g) =>
      g.hooks.some((e) => e.command === recallCmd)
    );
    if (!hasRecall) {
      const globalGroup = hooks.UserPromptSubmit.find((g) => !g.matcher);
      if (globalGroup) {
        globalGroup.hooks.push({ type: "command", command: recallCmd });
      } else {
        hooks.UserPromptSubmit.push({ hooks: [{ type: "command", command: recallCmd }] });
      }
    }

    assert.equal(hooks.UserPromptSubmit.length, 2, "should have two groups");
    assert.equal(hooks.UserPromptSubmit[0].matcher, "shell", "first group unchanged");
    assert.ok(!hooks.UserPromptSubmit[1].matcher, "second group has no matcher");
    assert.equal(hooks.UserPromptSubmit[1].hooks[0].command, recallCmd);
  });

  test("uninstall: removes hooks from all groups and drops empty groups", () => {
    const recallCmd = "/home/user/.codex/supermemory/recall.js";
    let hooks = {
      UserPromptSubmit: [
        { hooks: [{ type: "command", command: recallCmd }] },
        { matcher: "shell", hooks: [{ type: "command", command: "other" }] },
      ],
    };

    hooks.UserPromptSubmit = hooks.UserPromptSubmit
      .map((g) => ({ ...g, hooks: g.hooks.filter((h) => h.command !== recallCmd) }))
      .filter((g) => g.hooks.length > 0);

    assert.equal(hooks.UserPromptSubmit.length, 1, "empty group should be dropped");
    assert.equal(hooks.UserPromptSubmit[0].matcher, "shell", "matcher-scoped group preserved");
  });
});

// ─── integration: install/uninstall MCP server registration ─────────────────
//
// These tests spawn the built CLI against a fake $HOME and assert on the
// resulting config.toml. They depend on dist/cli.js — `npm test` runs
// `npm run build` first, so this should always be present when invoked
// through npm.

describe("integration: install/uninstall MCP server registration", () => {
  const cliBin = new URL("../dist/cli.js", import.meta.url).pathname;

  test("install adds mcp_servers.supermemory to config.toml", (t) => {
    const { tmpDir, configPath } = setupCodexHome(t);

    runCli(cliBin, "install", tmpDir);

    const config = readToml(configPath);
    assert.ok(config.mcp_servers, "mcp_servers table should exist");
    assert.deepEqual(
      config.mcp_servers.supermemory,
      { url: "https://mcp.supermemory.ai/mcp" },
      "supermemory entry should have the expected url"
    );
  });

  test("uninstall removes mcp_servers.supermemory from config.toml", (t) => {
    const { tmpDir, configPath } = setupCodexHome(t);

    runCli(cliBin, "install", tmpDir);
    runCli(cliBin, "uninstall", tmpDir);

    const config = readToml(configPath);
    assert.ok(
      !config.mcp_servers || !config.mcp_servers.supermemory,
      "supermemory entry should be gone"
    );
  });

  test("install preserves existing mcp_servers entries (and registers supermemory with correct URL)", (t) => {
    const { tmpDir, configPath } = setupCodexHome(t);

    writeFileSync(
      configPath,
      '[mcp_servers.my-other-tool]\nurl = "https://example.com/mcp"\n'
    );

    runCli(cliBin, "install", tmpDir);

    const config = readToml(configPath);
    assert.deepEqual(
      config.mcp_servers.supermemory,
      { url: "https://mcp.supermemory.ai/mcp" },
      "supermemory entry should be present with the expected url"
    );
    assert.deepEqual(
      config.mcp_servers["my-other-tool"],
      { url: "https://example.com/mcp" },
      "existing my-other-tool entry should be preserved verbatim"
    );
  });

  test("uninstall preserves other mcp_servers entries", (t) => {
    const { tmpDir, configPath } = setupCodexHome(t);

    writeFileSync(
      configPath,
      '[mcp_servers.my-other-tool]\nurl = "https://example.com/mcp"\n'
    );
    runCli(cliBin, "install", tmpDir);
    runCli(cliBin, "uninstall", tmpDir);

    const config = readToml(configPath);
    assert.ok(
      !config.mcp_servers.supermemory,
      "supermemory entry should be removed"
    );
    assert.deepEqual(
      config.mcp_servers["my-other-tool"],
      { url: "https://example.com/mcp" },
      "my-other-tool entry should be preserved"
    );
  });

  test("install does NOT clobber a user-customized supermemory entry", (t) => {
    const { tmpDir, configPath } = setupCodexHome(t);

    // User has manually configured the supermemory MCP entry with custom keys
    // (e.g. bearer_token_env_var, custom URL). Install should leave it alone.
    const userConfig = TOML.stringify({
      mcp_servers: {
        supermemory: {
          url: "https://custom.example.com/mcp",
          bearer_token_env_var: "MY_TOKEN",
        },
      },
    });
    writeFileSync(configPath, userConfig);

    runCli(cliBin, "install", tmpDir);

    const config = readToml(configPath);
    assert.deepEqual(
      config.mcp_servers.supermemory,
      {
        url: "https://custom.example.com/mcp",
        bearer_token_env_var: "MY_TOKEN",
      },
      "user-customized supermemory entry must be preserved verbatim"
    );
  });

  test("uninstall does NOT remove a user-customized supermemory entry", (t) => {
    const { tmpDir, configPath } = setupCodexHome(t);

    // Pre-existing user config that doesn't match the installer-managed shape.
    const userConfig = TOML.stringify({
      mcp_servers: {
        supermemory: {
          url: "https://custom.example.com/mcp",
          bearer_token_env_var: "MY_TOKEN",
        },
      },
    });
    writeFileSync(configPath, userConfig);

    // install is a no-op for this entry (suggestion above), then uninstall
    // should still leave the customized entry alone.
    runCli(cliBin, "install", tmpDir);
    runCli(cliBin, "uninstall", tmpDir);

    const config = readToml(configPath);
    assert.deepEqual(
      config.mcp_servers.supermemory,
      {
        url: "https://custom.example.com/mcp",
        bearer_token_env_var: "MY_TOKEN",
      },
      "user-customized supermemory entry must survive uninstall"
    );
  });

  test("uninstall drops empty [features] section", (t) => {
    const { tmpDir, configPath } = setupCodexHome(t);

    runCli(cliBin, "install", tmpDir);
    runCli(cliBin, "uninstall", tmpDir);

    const raw = readFileSync(configPath, "utf-8");
    assert.ok(!raw.includes("[features]"), "stale [features] section should be removed on uninstall");
    const config = readToml(configPath);
    assert.ok(!config.features, "features table should not exist after uninstall");
  });
});

// ─── recall hook output envelope ────────────────────────────────────────────

describe("recall hook output envelope", () => {
  const recallBin = new URL("../dist/hooks/recall.js", import.meta.url).pathname;

  test("outputs hookSpecificOutput envelope when not configured", () => {
    const result = spawnSync("node", [recallBin], {
      input: JSON.stringify({ session_id: "s1", prompt: "hello" }),
      env: { ...process.env, SUPERMEMORY_CODEX_API_KEY: "" },
      encoding: "utf-8",
    });
    const parsed = JSON.parse(result.stdout);
    assert.ok("hookSpecificOutput" in parsed, "must have hookSpecificOutput key");
    assert.equal(parsed.hookSpecificOutput.hookEventName, "UserPromptSubmit");
    assert.equal(typeof parsed.hookSpecificOutput.additionalContext, "string");
  });

  test("outputs hookSpecificOutput envelope on empty prompt", () => {
    const result = spawnSync("node", [recallBin], {
      input: JSON.stringify({ session_id: "s1", prompt: "" }),
      env: { ...process.env, SUPERMEMORY_CODEX_API_KEY: "sm_test" },
      encoding: "utf-8",
    });
    const parsed = JSON.parse(result.stdout);
    assert.equal(parsed.hookSpecificOutput.hookEventName, "UserPromptSubmit");
    assert.equal(parsed.hookSpecificOutput.additionalContext, "");
  });

  test("outputs hookSpecificOutput envelope on malformed JSON input", () => {
    const result = spawnSync("node", [recallBin], {
      input: "not-json",
      env: { ...process.env, SUPERMEMORY_CODEX_API_KEY: "sm_test" },
      encoding: "utf-8",
    });
    const parsed = JSON.parse(result.stdout);
    assert.equal(parsed.hookSpecificOutput.hookEventName, "UserPromptSubmit");
  });

  test("never outputs bare additionalContext at top level (old wrong shape)", () => {
    const result = spawnSync("node", [recallBin], {
      input: JSON.stringify({ prompt: "test" }),
      env: { ...process.env, SUPERMEMORY_CODEX_API_KEY: "" },
      encoding: "utf-8",
    });
    const parsed = JSON.parse(result.stdout);
    assert.ok(!("additionalContext" in parsed), "must NOT have top-level additionalContext");
  });

  test("exits with code 0", () => {
    const result = spawnSync("node", [recallBin], {
      input: JSON.stringify({ prompt: "test" }),
      env: { ...process.env, SUPERMEMORY_CODEX_API_KEY: "" },
      encoding: "utf-8",
    });
    assert.equal(result.status, 0);
  });
});

// ─── capture hook — Stop payload handling ───────────────────────────────────

describe("capture hook Stop payload", () => {
  const captureBin = new URL("../dist/hooks/capture.js", import.meta.url).pathname;

  test("exits 0 with no transcript_path and no last_assistant_message", () => {
    const result = spawnSync("node", [captureBin], {
      input: JSON.stringify({ session_id: "s1", transcript_path: null }),
      env: { ...process.env, SUPERMEMORY_CODEX_API_KEY: "" },
      encoding: "utf-8",
    });
    assert.equal(result.status, 0);
  });

  test("exits 0 when not configured (even with last_assistant_message)", () => {
    const result = spawnSync("node", [captureBin], {
      input: JSON.stringify({ session_id: "s1", last_assistant_message: "hello" }),
      env: { ...process.env, SUPERMEMORY_CODEX_API_KEY: "" },
      encoding: "utf-8",
    });
    assert.equal(result.status, 0);
  });

  test("exits 0 on malformed JSON input", () => {
    const result = spawnSync("node", [captureBin], {
      input: "not-json",
      env: { ...process.env, SUPERMEMORY_CODEX_API_KEY: "" },
      encoding: "utf-8",
    });
    assert.equal(result.status, 0);
  });

  test("reads transcript_path JSONL file when it exists (exits 0 without API key)", (t) => {
    const tmpDir = makeTmpDir();
    t.after(() => rmSync(tmpDir, { recursive: true, force: true }));
    const transcriptFile = join(tmpDir, "transcript.jsonl");
    writeFileSync(
      transcriptFile,
      [
        JSON.stringify({ role: "user", content: "What is 2+2?" }),
        JSON.stringify({ role: "assistant", content: "4" }),
      ].join("\n")
    );

    const result = spawnSync("node", [captureBin], {
      input: JSON.stringify({
        session_id: "s1",
        transcript_path: transcriptFile,
        cwd: tmpDir,
      }),
      env: { ...process.env, SUPERMEMORY_CODEX_API_KEY: "" },
      encoding: "utf-8",
    });
    assert.equal(result.status, 0);
  });

  test("does not crash when transcript_path points to nonexistent file", () => {
    const result = spawnSync("node", [captureBin], {
      input: JSON.stringify({
        session_id: "s1",
        transcript_path: "/nonexistent/path/transcript.jsonl",
      }),
      env: { ...process.env, SUPERMEMORY_CODEX_API_KEY: "" },
      encoding: "utf-8",
    });
    assert.equal(result.status, 0);
  });
});
