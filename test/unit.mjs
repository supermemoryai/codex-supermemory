/**
 * Unit tests for codex-supermemory using Node's built-in test runner.
 * Run with: node --test test/unit.mjs
 */
import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { writeFileSync, readFileSync, mkdirSync, rmSync, existsSync } from "node:fs";
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

// ─── integration: install/uninstall (skills + hooks) ──────────────────────
//
// These tests spawn the built CLI against a fake $HOME and assert on the
// resulting on-disk state. They depend on dist/cli.js — `npm test` runs
// `npm run build` first, so this should always be present when invoked
// through npm.

describe("integration: install/uninstall", () => {
  const cliBin = new URL("../dist/cli.js", import.meta.url).pathname;

  test("install copies skill SKILL.md files to ~/.codex/skills/", (t) => {
    const { tmpDir, codexDir } = setupCodexHome(t);

    const result = runCli(cliBin, "install", tmpDir);
    assert.equal(result.status, 0, `install should exit 0: ${result.stderr}`);

    const skillsDir = join(codexDir, "skills");
    for (const skillName of ["supermemory-search", "supermemory-save", "supermemory-forget", "supermemory-login"]) {
      const skillMd = join(skillsDir, skillName, "SKILL.md");
      assert.ok(existsSync(skillMd), `${skillName}/SKILL.md should exist`);
      const content = readFileSync(skillMd, "utf-8");
      assert.ok(
        content.includes(`name: ${skillName}`),
        `SKILL.md should contain name: ${skillName}`
      );
    }
  });

  test("uninstall removes skill directories", (t) => {
    const { tmpDir, codexDir } = setupCodexHome(t);

    const installResult = runCli(cliBin, "install", tmpDir);
    assert.equal(installResult.status, 0, `install should exit 0: ${installResult.stderr}`);
    const uninstallResult = runCli(cliBin, "uninstall", tmpDir);
    assert.equal(uninstallResult.status, 0, `uninstall should exit 0: ${uninstallResult.stderr}`);

    const skillsDir = join(codexDir, "skills");
    for (const skillName of ["supermemory-search", "supermemory-save", "supermemory-forget", "supermemory-login"]) {
      assert.ok(
        !existsSync(join(skillsDir, skillName)),
        `${skillName} skill dir should be removed`
      );
    }
  });

  test("uninstall drops empty [features] section", (t) => {
    const { tmpDir, configPath } = setupCodexHome(t);

    const installResult = runCli(cliBin, "install", tmpDir);
    assert.equal(installResult.status, 0, `install should exit 0: ${installResult.stderr}`);
    const uninstallResult = runCli(cliBin, "uninstall", tmpDir);
    assert.equal(uninstallResult.status, 0, `uninstall should exit 0: ${uninstallResult.stderr}`);

    const raw = readFileSync(configPath, "utf-8");
    assert.ok(!raw.includes("[features]"), "stale [features] section should be removed on uninstall");
    const config = readToml(configPath);
    assert.ok(!config.features, "features table should not exist after uninstall");
  });
});


// ─── recall hook output envelope ────────────────────────────────────────────

describe("recall hook output envelope", () => {
  const recallBin = new URL("../dist/hooks/recall.js", import.meta.url).pathname;

  // Helper: run recall hook with an isolated HOME and a short auth timeout so
  // the first-invocation browser flow times out in 2s rather than 60s.
  function runRecallUnconfigured(t, input) {
    const tmpDir = makeTmpDir();
    mkdirSync(join(tmpDir, ".codex", "supermemory"), { recursive: true });
    t.after(() => rmSync(tmpDir, { recursive: true, force: true }));
    return spawnSync("node", [recallBin], {
      input,
      // Use a 2s auth timeout so the browser flow times out quickly in CI.
      env: { ...process.env, HOME: tmpDir, SUPERMEMORY_CODEX_API_KEY: "", SUPERMEMORY_AUTH_TIMEOUT: "2000" },
      encoding: "utf-8",
      timeout: 5_000,
    });
  }

  test("outputs hookSpecificOutput envelope when not configured", (t) => {
    const result = runRecallUnconfigured(t, JSON.stringify({ session_id: "s1", prompt: "hello" }));
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

  test("never outputs bare additionalContext at top level (old wrong shape)", (t) => {
    // When .auth-attempted already exists (second invocation), the hook exits quickly.
    // Create it ahead of time so this test doesn't incur the 25s auth timeout.
    const tmpDir = makeTmpDir();
    const supermemoryDir = join(tmpDir, ".codex", "supermemory");
    mkdirSync(supermemoryDir, { recursive: true });
    writeFileSync(join(supermemoryDir, ".auth-attempted"), new Date().toISOString());
    t.after(() => rmSync(tmpDir, { recursive: true, force: true }));

    const result = spawnSync("node", [recallBin], {
      input: JSON.stringify({ prompt: "test" }),
      env: { ...process.env, HOME: tmpDir, SUPERMEMORY_CODEX_API_KEY: "" },
      encoding: "utf-8",
    });
    const parsed = JSON.parse(result.stdout);
    assert.ok(!("additionalContext" in parsed), "must NOT have top-level additionalContext");
  });

  test("exits with code 0", (t) => {
    // Pre-create .auth-attempted so the hook returns quickly without the 25s timeout.
    const tmpDir = makeTmpDir();
    const supermemoryDir = join(tmpDir, ".codex", "supermemory");
    mkdirSync(supermemoryDir, { recursive: true });
    writeFileSync(join(supermemoryDir, ".auth-attempted"), new Date().toISOString());
    t.after(() => rmSync(tmpDir, { recursive: true, force: true }));

    const result = spawnSync("node", [recallBin], {
      input: JSON.stringify({ prompt: "test" }),
      env: { ...process.env, HOME: tmpDir, SUPERMEMORY_CODEX_API_KEY: "" },
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

// ─── skill scripts (search/save/forget) ─────────────────────────────────────
//
// These scripts (dist/skills/*.js) are entry-points invoked by Codex skills.
// They reuse SupermemoryClient + tags, so we only smoke-test the CLI shape:
// argument parsing, the unconfigured-fallback message, and clean exit codes.

describe("skill scripts: search/save/forget", () => {
  const searchBin = new URL("../dist/skills/search-memory.js", import.meta.url).pathname;
  const saveBin = new URL("../dist/skills/save-memory.js", import.meta.url).pathname;
  const forgetBin = new URL("../dist/skills/forget-memory.js", import.meta.url).pathname;

  // Run a script with a fresh empty $HOME (no config file) and an empty
  // SUPERMEMORY_CODEX_API_KEY so isConfigured() is false. Returns the spawn result.
  function runSkillUnconfigured(t, bin, args) {
    const tmpDir = makeTmpDir();
    mkdirSync(join(tmpDir, ".codex"), { recursive: true });
    t.after(() => rmSync(tmpDir, { recursive: true, force: true }));
    return spawnSync("node", [bin, ...args], {
      env: { PATH: process.env.PATH, HOME: tmpDir, SUPERMEMORY_CODEX_API_KEY: "" },
      encoding: "utf-8",
    });
  }

  // Run a script with a (fake) API key but no network. We expect arg-parsing
  // branches (missing query/content) to short-circuit before any network call.
  function runSkillNoArgs(t, bin) {
    const tmpDir = makeTmpDir();
    mkdirSync(join(tmpDir, ".codex"), { recursive: true });
    t.after(() => rmSync(tmpDir, { recursive: true, force: true }));
    return spawnSync("node", [bin], {
      env: { PATH: process.env.PATH, HOME: tmpDir, SUPERMEMORY_CODEX_API_KEY: "sm_test" },
      encoding: "utf-8",
    });
  }

  test("search-memory prints not-configured message and exits 1 when no API key", (t) => {
    const result = runSkillUnconfigured(t, searchBin, ["hello"]);
    assert.equal(result.status, 1);
    assert.match(result.stderr, /Supermemory is not authenticated/);
    assert.match(result.stderr, /supermemory-login/);
  });

  test("save-memory prints not-configured message and exits 1 when no API key", (t) => {
    const result = runSkillUnconfigured(t, saveBin, ["some content"]);
    assert.equal(result.status, 1);
    assert.match(result.stderr, /Supermemory is not authenticated/);
  });

  test("forget-memory prints not-configured message and exits 1 when no API key", (t) => {
    const result = runSkillUnconfigured(t, forgetBin, ["some content"]);
    assert.equal(result.status, 1);
    assert.match(result.stderr, /Supermemory is not authenticated/);
  });

  test("search-memory prints usage and exits 0 when no query is given", (t) => {
    const result = runSkillNoArgs(t, searchBin);
    assert.equal(result.status, 0);
    assert.match(result.stdout, /No search query provided/);
    assert.match(result.stdout, /node search-memory\.js/);
  });

  test("save-memory prints usage and exits 0 when no content is given", (t) => {
    const result = runSkillNoArgs(t, saveBin);
    assert.equal(result.status, 0);
    assert.match(result.stdout, /No content provided/);
    assert.match(result.stdout, /node save-memory\.js/);
  });

  test("forget-memory prints usage and exits 0 when no content is given", (t) => {
    const result = runSkillNoArgs(t, forgetBin);
    assert.equal(result.status, 0);
    assert.match(result.stdout, /No content provided/);
    assert.match(result.stdout, /node forget-memory\.js/);
  });

  test("search-memory only treats --user/--project/--both/--no-profile as flags; other args become the query", (t) => {
    // With a fresh HOME and no API key, every invocation hits the unconfigured
    // branch — which is fine. The point of this test is to assert that the
    // script *runs at all* (i.e. arg-parsing doesn't crash) for every flag
    // permutation we expect users to send.
    for (const args of [
      ["--user", "find", "thing"],
      ["--project", "find", "thing"],
      ["--both", "find", "thing"],
      ["--no-profile", "find", "thing"],
      ["--user", "--no-profile", "find", "thing"],
    ]) {
      const result = runSkillUnconfigured(t, searchBin, args);
      assert.equal(result.status, 1, `flags ${args.join(" ")} should exit 1 when unconfigured`);
      assert.match(
        result.stderr,
        /Supermemory is not authenticated/,
        `flags ${args.join(" ")} should hit the unconfigured branch`
      );
    }
  });
});
