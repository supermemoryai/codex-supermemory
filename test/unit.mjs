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
import { fileURLToPath } from "node:url";
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
  test("wrapped hooks.json shape is valid JSON", () => {
    const recallScript = "/home/user/.codex/supermemory/recall.js";
    const flushScript = "/home/user/.codex/supermemory/flush.js";

    const hooksJson = {
      hooks: {
        UserPromptSubmit: [{ hooks: [{ type: "command", command: `node ${recallScript}`, timeout: 90 }] }],
        Stop: [{ hooks: [{ type: "command", command: `node ${flushScript}`, timeout: 60 }] }],
      },
    };
    const json = JSON.stringify(hooksJson, null, 2);
    const parsed = JSON.parse(json);

    assert.ok(parsed.hooks, "must have top-level hooks key");
    assert.ok(!parsed.UserPromptSubmit, "must NOT have UserPromptSubmit at top level");
    assert.ok(Array.isArray(parsed.hooks.UserPromptSubmit), "hooks.UserPromptSubmit must be an array");
    assert.equal(parsed.hooks.UserPromptSubmit[0].hooks[0].timeout, 90);
    assert.ok(Array.isArray(parsed.hooks.Stop), "hooks.Stop must be an array");
    assert.equal(parsed.hooks.Stop[0].hooks[0].type, "command");
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
  const cliBin = fileURLToPath(new URL("../dist/cli.js", import.meta.url));

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
  const recallBin = fileURLToPath(new URL("../dist/hooks/recall.js", import.meta.url));

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

  test("emits no envelope on empty prompt (so Codex doesn't render an empty hook context line)", () => {
    const result = spawnSync("node", [recallBin], {
      input: JSON.stringify({ session_id: "s1", prompt: "" }),
      env: { ...process.env, SUPERMEMORY_CODEX_API_KEY: "sm_test" },
      encoding: "utf-8",
    });
    assert.equal(result.status, 0);
    assert.equal(result.stdout, "", "empty context should produce empty stdout");
  });

  test("emits no envelope on malformed JSON input", () => {
    const result = spawnSync("node", [recallBin], {
      input: "not-json",
      env: { ...process.env, SUPERMEMORY_CODEX_API_KEY: "sm_test" },
      encoding: "utf-8",
    });
    assert.equal(result.status, 0);
    assert.equal(result.stdout, "");
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

// ─── flush hook — Stop payload handling ──────────────────────────────────────

describe("flush hook Stop payload", () => {
  const flushBin = fileURLToPath(new URL("../dist/hooks/flush.js", import.meta.url));

  test("exits 0 with no transcript_path", () => {
    const result = spawnSync("node", [flushBin], {
      input: JSON.stringify({ session_id: "s1", transcript_path: null }),
      env: { ...process.env, SUPERMEMORY_CODEX_API_KEY: "" },
      encoding: "utf-8",
    });
    assert.equal(result.status, 0);
  });

  test("exits 0 when not configured", () => {
    const result = spawnSync("node", [flushBin], {
      input: JSON.stringify({ session_id: "s1", cwd: "/tmp" }),
      env: { ...process.env, SUPERMEMORY_CODEX_API_KEY: "" },
      encoding: "utf-8",
    });
    assert.equal(result.status, 0);
  });

  test("exits 0 on malformed JSON input", () => {
    const result = spawnSync("node", [flushBin], {
      input: "not-json",
      env: { ...process.env, SUPERMEMORY_CODEX_API_KEY: "" },
      encoding: "utf-8",
    });
    assert.equal(result.status, 0);
  });

  test("exits 0 without API key even when transcript exists (smoke test)", (t) => {
    const tmpDir = makeTmpDir();
    t.after(() => rmSync(tmpDir, { recursive: true, force: true }));
    const transcriptFile = join(tmpDir, "transcript.jsonl");
    writeFileSync(
      transcriptFile,
      [
        JSON.stringify({ type: "event_msg", payload: { type: "user_message", message: "What is 2+2?" } }),
        JSON.stringify({ type: "event_msg", payload: { type: "assistant_output_text", text: "4" } }),
      ].join("\n")
    );

    const result = spawnSync("node", [flushBin], {
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
    const result = spawnSync("node", [flushBin], {
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
  const searchBin = fileURLToPath(new URL("../dist/skills/search-memory.js", import.meta.url));
  const saveBin = fileURLToPath(new URL("../dist/skills/save-memory.js", import.meta.url));
  const forgetBin = fileURLToPath(new URL("../dist/skills/forget-memory.js", import.meta.url));

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

// ─── formatCombinedContext — interleaved memory merging ──────────────────────

describe("formatCombinedContext interleaving", () => {
  // Simulate the formatCombinedContext interleaving logic inline to test without
  // importing the ESM module (which is bundled into CJS by esbuild).
  function interleaveMemories(userMemories, projectMemories, maxMemories) {
    const allMemories = [];
    let ui = 0;
    let pi = 0;
    while (allMemories.length < maxMemories && (ui < userMemories.length || pi < projectMemories.length)) {
      if (ui < userMemories.length) {
        allMemories.push(userMemories[ui++]);
      }
      if (allMemories.length < maxMemories && pi < projectMemories.length) {
        allMemories.push(projectMemories[pi++]);
      }
    }
    return allMemories;
  }

  test("interleaves user and project memories evenly", () => {
    const user = ["u1", "u2", "u3"];
    const project = ["p1", "p2", "p3"];
    const result = interleaveMemories(user, project, 6);
    assert.deepEqual(result, ["u1", "p1", "u2", "p2", "u3", "p3"]);
  });

  test("limits total to maxMemories while preserving both sources", () => {
    const user = ["u1", "u2", "u3", "u4", "u5"];
    const project = ["p1", "p2", "p3", "p4", "p5"];
    const result = interleaveMemories(user, project, 5);
    // Should interleave: u1, p1, u2, p2, u3
    assert.equal(result.length, 5);
    assert.ok(result.some(m => m.startsWith("u")), "must include user memories");
    assert.ok(result.some(m => m.startsWith("p")), "must include project memories");
  });

  test("project memories not dropped when user has many results", () => {
    const user = ["u1", "u2", "u3", "u4", "u5", "u6"];
    const project = ["p1", "p2"];
    const result = interleaveMemories(user, project, 5);
    // Should interleave: u1, p1, u2, p2, u3
    assert.ok(result.includes("p1"), "project memory p1 must be included");
    assert.ok(result.includes("p2"), "project memory p2 must be included");
  });

  test("handles empty project memories", () => {
    const user = ["u1", "u2", "u3"];
    const project = [];
    const result = interleaveMemories(user, project, 5);
    assert.deepEqual(result, ["u1", "u2", "u3"]);
  });

  test("handles empty user memories", () => {
    const user = [];
    const project = ["p1", "p2", "p3"];
    const result = interleaveMemories(user, project, 5);
    assert.deepEqual(result, ["p1", "p2", "p3"]);
  });

  test("handles both empty", () => {
    const result = interleaveMemories([], [], 5);
    assert.deepEqual(result, []);
  });
});

// ─── dedup by id — memory deduplication ──────────────────────────────────────

describe("memory deduplication by id", () => {
  function dedupKey(id, text) {
    if (id) return `id:${id}`;
    return `content:${text.toLowerCase().trim()}`;
  }

  test("deduplicates by id when available", () => {
    const seen = new Set();
    const memories = [
      { id: "mem-1", memory: "React components" },
      { id: "mem-1", memory: "react components" }, // same id, different casing
      { id: "mem-2", memory: "Vue components" },
    ];

    const result = memories.filter(m => {
      const key = dedupKey(m.id, m.memory);
      if (seen.has(key)) return false;
      seen.add(key);
      return true;
    });

    assert.equal(result.length, 2, "should deduplicate by id");
  });

  test("falls back to content-based dedup when id is missing", () => {
    const seen = new Set();
    const memories = [
      { memory: "React components" },
      { memory: "react components" }, // same content, different casing
      { memory: "Vue components" },
    ];

    const result = memories.filter(m => {
      const key = dedupKey(m.id, m.memory);
      if (seen.has(key)) return false;
      seen.add(key);
      return true;
    });

    assert.equal(result.length, 2, "should deduplicate by lowercased content");
  });

  test("does not over-deduplicate when ids differ but content matches", () => {
    const seen = new Set();
    const memories = [
      { id: "mem-1", memory: "React components" },
      { id: "mem-2", memory: "React components" }, // different id, same content
    ];

    const result = memories.filter(m => {
      const key = dedupKey(m.id, m.memory);
      if (seen.has(key)) return false;
      seen.add(key);
      return true;
    });

    assert.equal(result.length, 2, "should keep both since ids differ");
  });
});
