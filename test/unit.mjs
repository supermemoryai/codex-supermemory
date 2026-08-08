/**
 * Unit tests for codex-supermemory using Node's built-in test runner.
 * Run with: node --test test/unit.mjs
 */
import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
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
    env: { ...process.env, HOME: tmpDir, USERPROFILE: tmpDir, SUPERMEMORY_CODEX_API_KEY: "sm_test" },
    encoding: "utf-8",
  });
}

function readToml(path) {
  return TOML.parse(readFileSync(path, "utf-8"));
}

function hash16(input) {
  return createHash("sha256").update(input).digest("hex").slice(0, 16);
}

// Inline the stripPrivateContent logic (mirrors src/services/privacy.ts exactly)
function stripPrivateContent(s) {
  return s.replace(/<private>[\s\S]*?<\/private>/gi, "[REDACTED]");
}

// ─── container tags ─────────────────────────────────────────────────────────

describe("container tags", () => {
  const tagsModule = new URL("../dist/services/tags.js", import.meta.url).href;

  function runGit(args, cwd) {
    const result = spawnSync("git", args, { cwd, encoding: "utf-8" });
    assert.equal(
      result.status,
      0,
      `git ${args.join(" ")} failed:\n${result.stderr || result.stdout}`
    );
    return result.stdout.trim();
  }

  function getPersonalTagFor(cwd, home, extraEnv = {}) {
    const script = `
      import { getPersonalTag } from ${JSON.stringify(tagsModule)};
      console.log(getPersonalTag(process.argv.at(-1)));
    `;
    const result = spawnSync("node", ["--input-type=module", "-e", script, cwd], {
      env: {
        ...process.env,
        HOME: home,
        SUPERMEMORY_CODEX_API_KEY: "sm_test",
        ...extraEnv,
      },
      encoding: "utf-8",
    });
    assert.equal(result.status, 0, `getPersonalTag failed: ${result.stderr}`);
    return result.stdout.trim();
  }

  test("canonical tag uses the shared git common directory for worktrees", (t) => {
    const tmpDir = makeTmpDir();
    t.after(() => rmSync(tmpDir, { recursive: true, force: true }));

    const repoDir = join(tmpDir, "repo");
    const worktreeDir = join(tmpDir, "worktree");
    const homeDir = join(tmpDir, "home");
    mkdirSync(repoDir, { recursive: true });
    mkdirSync(homeDir, { recursive: true });

    runGit(["init"], repoDir);
    runGit(["config", "user.email", "test@example.com"], repoDir);
    runGit(["config", "user.name", "Test User"], repoDir);
    writeFileSync(join(repoDir, "README.md"), "# test\n");
    runGit(["add", "README.md"], repoDir);
    runGit(["commit", "-m", "initial"], repoDir);
    runGit(["worktree", "add", "--detach", worktreeDir, "HEAD"], repoDir);
    assert.equal(
      getPersonalTagFor(worktreeDir, homeDir),
      getPersonalTagFor(repoDir, homeDir),
    );
  });

  test("canonical tag can still isolate individual worktrees when requested", (t) => {
    const tmpDir = makeTmpDir();
    t.after(() => rmSync(tmpDir, { recursive: true, force: true }));

    const repoDir = join(tmpDir, "repo");
    const worktreeDir = join(tmpDir, "worktree");
    const homeDir = join(tmpDir, "home");
    mkdirSync(repoDir, { recursive: true });
    mkdirSync(homeDir, { recursive: true });

    runGit(["init"], repoDir);
    runGit(["config", "user.email", "test@example.com"], repoDir);
    runGit(["config", "user.name", "Test User"], repoDir);
    writeFileSync(join(repoDir, "README.md"), "# test\n");
    runGit(["add", "README.md"], repoDir);
    runGit(["commit", "-m", "initial"], repoDir);
    runGit(["worktree", "add", "--detach", worktreeDir, "HEAD"], repoDir);
    assert.notEqual(
      getPersonalTagFor(worktreeDir, homeDir, { SUPERMEMORY_ISOLATE_WORKTREES: "true" }),
      getPersonalTagFor(repoDir, homeDir),
    );
  });

  test("uses unified tags and includes all agent legacy reads", (t) => {
    const tmpDir = makeTmpDir();
    t.after(() => rmSync(tmpDir, { recursive: true, force: true }));
    const repoDir = join(tmpDir, "Example Project");
    const homeDir = join(tmpDir, "home");
    mkdirSync(repoDir, { recursive: true });
    mkdirSync(homeDir, { recursive: true });
    runGit(["init"], repoDir);
    runGit(["config", "user.email", "test@example.com"], repoDir);
    runGit(["remote", "add", "origin", "git@github.com:acme/Example.Project.git"], repoDir);
    const root = runGit(["rev-parse", "--show-toplevel"], repoDir);
    const script = `
      import { getTags } from ${JSON.stringify(tagsModule)};
      console.log(JSON.stringify(getTags(process.argv.at(-1))));
    `;
    const result = spawnSync("node", ["--input-type=module", "-e", script, repoDir], {
      env: {
        ...process.env,
        HOME: homeDir,
        SUPERMEMORY_CODEX_API_KEY: "sm_test",
      },
      encoding: "utf-8",
    });
    assert.equal(result.status, 0, result.stderr);
    const tags = JSON.parse(result.stdout);
    const pathHash = hash16(root);
    const projectHash = hash16("github.com/acme/example.project");
    const canonicalTag = `repo_example_project__${projectHash}`;
    assert.equal(tags.user, canonicalTag);
    assert.equal(tags.project, canonicalTag);
    assert.equal(tags.canonical, canonicalTag);
    assert.equal(tags.projectId, projectHash);
    assert.equal(tags.projectName, "Example.Project");
    assert.deepEqual(tags.personalReads, [
      canonicalTag,
      `user_project_${pathHash}`,
      `claudecode_project_${pathHash}`,
      `codex_user_${hash16("test@example.com")}`,
      `opencode_user_${hash16("test@example.com")}`,
      `cursor_user_${hash16("test@example.com")}`,
    ]);
    assert.deepEqual(tags.projectReads, [
      canonicalTag,
      "repo_example_project",
      `codex_project_${pathHash}`,
      ...[...new Set([hash16(repoDir), pathHash])].map(
        (hash) => `opencode_project_${hash}`,
      ),
      `cursor_project_${pathHash}`,
    ]);
  });

  test("preserves explicit Codex container overrides for shared writes", (t) => {
    const tmpDir = makeTmpDir();
    t.after(() => rmSync(tmpDir, { recursive: true, force: true }));
    const repoDir = join(tmpDir, "repo");
    const homeDir = join(tmpDir, "home");
    const codexDir = join(homeDir, ".codex");
    mkdirSync(repoDir, { recursive: true });
    mkdirSync(codexDir, { recursive: true });
    writeFileSync(
      join(codexDir, "supermemory.json"),
      JSON.stringify({
        userContainerTag: "shared_personal",
        projectContainerTag: "shared_project",
      }),
    );
    runGit(["init"], repoDir);

    const script = `
      import { getTags } from ${JSON.stringify(tagsModule)};
      console.log(JSON.stringify(getTags(process.argv.at(-1))));
    `;
    const result = spawnSync("node", ["--input-type=module", "-e", script, repoDir], {
      env: {
        ...process.env,
        HOME: homeDir,
        USERPROFILE: homeDir,
        SUPERMEMORY_CODEX_API_KEY: "sm_test",
      },
      encoding: "utf-8",
    });
    assert.equal(result.status, 0, result.stderr);
    const tags = JSON.parse(result.stdout);
    assert.equal(tags.user, "shared_project");
    assert.equal(tags.project, "shared_project");
    assert.equal(tags.personalReads[0], "shared_project");
    assert.ok(tags.personalReads.includes("shared_personal"));
    assert.equal(tags.projectReads[0], "shared_project");
  });
});

describe("cross-container result merging", () => {
  const mergeModule = new URL("../dist/services/resultMerge.js", import.meta.url).href;

  test("globally ranks and deduplicates legacy results", () => {
    const script = `
      import { mergeSearchResponses } from ${JSON.stringify(mergeModule)};
      const merged = mergeSearchResponses([
        { success: true, results: [{ id: "old", memory: "A", similarity: 0.4 }] },
        { success: true, results: [
          { id: "best", memory: "B", similarity: 0.9 },
          { id: "new", memory: "A", similarity: 0.8 }
        ] }
      ], 10);
      console.log(JSON.stringify(merged.results.map((item) => item.id)));
    `;
    const result = spawnSync("node", ["--input-type=module", "-e", script], {
      encoding: "utf-8",
    });
    assert.equal(result.status, 0, result.stderr);
    assert.deepEqual(JSON.parse(result.stdout), ["best", "new"]);
  });
});

// ─── session ids ────────────────────────────────────────────────────────────

describe("session ids", () => {
  const sessionModule = new URL("../dist/services/session.js", import.meta.url).href;

  function getSessionIdFor(providedSessionId, scope, isoDate) {
    const script = `
      import { getSessionId } from ${JSON.stringify(sessionModule)};
      const provided = process.argv[1] === "__null__" ? null : process.argv[1];
      console.log(getSessionId(provided, process.argv[2], new Date(process.argv[3])));
    `;
    const result = spawnSync(
      "node",
      [
        "--input-type=module",
        "-e",
        script,
        providedSessionId ?? "__null__",
        scope,
        isoDate,
      ],
      { encoding: "utf-8" }
    );
    assert.equal(result.status, 0, `getSessionId failed: ${result.stderr}`);
    return result.stdout.trim();
  }

  test("uses Codex session_id when provided", () => {
    assert.equal(
      getSessionIdFor("s1", "codex_project_abc", "2026-05-17T05:59:00.000Z"),
      "s1"
    );
  });

  test("fallback session id is stable within the same 4-hour window", () => {
    const early = getSessionIdFor(null, "codex_project_abc", "2026-05-17T04:00:00.000Z");
    const late = getSessionIdFor(null, "codex_project_abc", "2026-05-17T07:59:59.999Z");

    assert.match(early, /^codex_[a-f0-9]{16}$/);
    assert.equal(early, late);
  });

  test("fallback session id changes at the next 4-hour window", () => {
    const current = getSessionIdFor(null, "codex_project_abc", "2026-05-17T07:59:59.999Z");
    const next = getSessionIdFor(null, "codex_project_abc", "2026-05-17T08:00:00.000Z");

    assert.notEqual(current, next);
  });

  test("fallback session id is scoped by project tag", () => {
    const first = getSessionIdFor(null, "codex_project_abc", "2026-05-17T04:00:00.000Z");
    const second = getSessionIdFor(null, "codex_project_def", "2026-05-17T04:00:00.000Z");

    assert.notEqual(first, second);
  });
});

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

describe("browser auth opener", () => {
  test("login bundle uses Windows-safe URL opener", () => {
    const content = readFileSync(new URL("../dist/skills/login.js", import.meta.url), "utf-8");
    assert.ok(content.includes("Refusing to open non-http URL"));
    assert.ok(content.includes("rundll32.exe"));
    assert.ok(content.includes("url.dll,FileProtocolHandler"));
    assert.ok(!content.includes("explorer.exe"));
  });
});

// ─── hooks.json format ──────────────────────────────────────────────────────

describe("entity context wiring", () => {
  test("client addMemory forwards entityContext into the API payload", () => {
    const content = readFileSync(new URL("../src/services/client.ts", import.meta.url), "utf-8");
    assert.ok(content.includes("USER_ENTITY_CONTEXT"));
    assert.ok(content.includes("PROJECT_ENTITY_CONTEXT"));
    assert.ok(content.includes("entityContext?: string"));
    assert.ok(content.includes("payload.entityContext = options.entityContext"));
  });

  test("automatic capture writes user entity context", () => {
    const content = readFileSync(new URL("../src/services/capture.ts", import.meta.url), "utf-8");
    assert.ok(content.includes("entityContext: USER_ENTITY_CONTEXT"));
    assert.ok(content.includes('sm_scope: "personal"'));
    assert.ok(content.includes("project: tags.projectName"));
  });

  test("manual save writes project entity context", () => {
    const content = readFileSync(new URL("../src/skills/save-memory.ts", import.meta.url), "utf-8");
    assert.ok(content.includes("PROJECT_ENTITY_CONTEXT"));
    assert.ok(content.includes("entityContext: getEntityContext(containerTag)"));
    assert.ok(content.includes('sm_scope: "project"'));
  });

  test("personal add writes the unified personal scope", () => {
    const content = readFileSync(new URL("../src/skills/add-memory.ts", import.meta.url), "utf-8");
    assert.ok(content.includes("getProjectTag"));
    assert.ok(content.includes('sm_scope: "personal"'));
    assert.ok(content.includes("entityContext: USER_ENTITY_CONTEXT"));
  });
});

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
    for (const skillName of ["supermemory-search", "supermemory-add", "supermemory-save", "supermemory-forget", "supermemory-status", "supermemory-login", "supermemory-logout"]) {
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
    for (const skillName of ["supermemory-search", "supermemory-add", "supermemory-save", "supermemory-forget", "supermemory-status", "supermemory-login", "supermemory-logout"]) {
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

  test("install aborts and preserves config.toml when TOML parsing fails", (t) => {
    const { tmpDir, configPath } = setupCodexHome(t);
    const invalidConfig = 'model = "gpt-5"\n[features\ncodex_hooks = true\n';
    writeFileSync(configPath, invalidConfig);

    const result = runCli(cliBin, "install", tmpDir);

    assert.notEqual(result.status, 0);
    assert.match(result.stderr, /Failed to parse/);
    assert.match(result.stderr, /config\.toml/);
    assert.match(result.stderr, /No changes were made/);
    assert.equal(readFileSync(configPath, "utf-8"), invalidConfig);
  });

  test("uninstall aborts and preserves config.toml when TOML parsing fails", (t) => {
    const { tmpDir, configPath } = setupCodexHome(t);
    const invalidConfig = 'model = "gpt-5"\n[features\ncodex_hooks = true\n';
    writeFileSync(configPath, invalidConfig);

    const result = runCli(cliBin, "uninstall", tmpDir);

    assert.notEqual(result.status, 0);
    assert.match(result.stderr, /Failed to parse/);
    assert.match(result.stderr, /config\.toml/);
    assert.match(result.stderr, /No changes were made/);
    assert.equal(readFileSync(configPath, "utf-8"), invalidConfig);
  });

  test("install aborts and preserves hooks.json when JSON parsing fails", (t) => {
    const { tmpDir, codexDir } = setupCodexHome(t);
    const hooksPath = join(codexDir, "hooks.json");
    const invalidHooks = '{ "hooks": { "Stop": [ }';
    writeFileSync(hooksPath, invalidHooks);

    const result = runCli(cliBin, "install", tmpDir);

    assert.notEqual(result.status, 0);
    assert.match(result.stderr, /Failed to parse/);
    assert.match(result.stderr, /hooks\.json/);
    assert.match(result.stderr, /No changes were made/);
    assert.equal(readFileSync(hooksPath, "utf-8"), invalidHooks);
  });

  test("uninstall aborts and preserves hooks.json when JSON parsing fails", (t) => {
    const { tmpDir, codexDir } = setupCodexHome(t);
    const hooksPath = join(codexDir, "hooks.json");
    const invalidHooks = '{ "hooks": { "Stop": [ }';
    writeFileSync(hooksPath, invalidHooks);

    const result = runCli(cliBin, "uninstall", tmpDir);

    assert.notEqual(result.status, 0);
    assert.match(result.stderr, /Failed to parse/);
    assert.match(result.stderr, /hooks\.json/);
    assert.match(result.stderr, /No changes were made/);
    assert.equal(readFileSync(hooksPath, "utf-8"), invalidHooks);
  });

  test("install aborts and preserves supermemory.json when JSON parsing fails", (t) => {
    const { tmpDir, codexDir } = setupCodexHome(t);
    const supermemoryPath = join(codexDir, "supermemory.json");
    const invalidConfig = '{ "apiKey": "sm_test", ';
    writeFileSync(supermemoryPath, invalidConfig);

    const result = runCli(cliBin, "install", tmpDir);

    assert.notEqual(result.status, 0);
    assert.match(result.stderr, /Failed to parse/);
    assert.match(result.stderr, /supermemory\.json/);
    assert.match(result.stderr, /No changes were made/);
    assert.equal(readFileSync(supermemoryPath, "utf-8"), invalidConfig);
  });

  test("install merges into existing valid config.toml", (t) => {
    const { tmpDir, configPath } = setupCodexHome(t);
    writeFileSync(configPath, 'model = "gpt-5"\n\n[features]\nweb_search = true\n');

    const result = runCli(cliBin, "install", tmpDir);

    assert.equal(result.status, 0, `install should exit 0: ${result.stderr}`);
    const config = readToml(configPath);
    assert.equal(config.model, "gpt-5");
    assert.equal(config.features.web_search, true);
    assert.equal(config.features.codex_hooks, true);
  });
});


// ─── recall hook output envelope ────────────────────────────────────────────

describe("recall hook output envelope", () => {
  const recallBin = fileURLToPath(new URL("../dist/hooks/recall.js", import.meta.url));

  // Helper: run recall hook with an isolated HOME. Pre-create the auth marker
  // so the unit test exercises the hook envelope without launching a browser.
  function runRecallUnconfigured(t, input) {
    const tmpDir = makeTmpDir();
    const supermemoryDir = join(tmpDir, ".codex", "supermemory");
    mkdirSync(supermemoryDir, { recursive: true });
    writeFileSync(join(supermemoryDir, ".auth-attempted"), new Date().toISOString());
    t.after(() => rmSync(tmpDir, { recursive: true, force: true }));
    return spawnSync("node", [recallBin], {
      input,
      env: { ...process.env, HOME: tmpDir, USERPROFILE: tmpDir, SUPERMEMORY_CODEX_API_KEY: "" },
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

  test("exits silently after explicit logout marker", (t) => {
    const tmpDir = makeTmpDir();
    const supermemoryDir = join(tmpDir, ".codex", "supermemory");
    mkdirSync(supermemoryDir, { recursive: true });
    writeFileSync(join(supermemoryDir, ".logged-out"), new Date().toISOString());
    t.after(() => rmSync(tmpDir, { recursive: true, force: true }));

    const result = spawnSync("node", [recallBin], {
      input: JSON.stringify({ session_id: "s1", prompt: "$supermemory-status" }),
      env: { ...process.env, HOME: tmpDir, USERPROFILE: tmpDir, SUPERMEMORY_CODEX_API_KEY: "" },
      encoding: "utf-8",
      timeout: 5_000,
    });

    assert.equal(result.status, 0);
    assert.equal(result.stdout, "");
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
      env: { ...process.env, HOME: tmpDir, USERPROFILE: tmpDir, SUPERMEMORY_CODEX_API_KEY: "" },
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
      env: { ...process.env, HOME: tmpDir, USERPROFILE: tmpDir, SUPERMEMORY_CODEX_API_KEY: "" },
      encoding: "utf-8",
    });
    assert.equal(result.status, 0);
  });
});

// ─── session-start hook logout behavior ──────────────────────────────────────

describe("session-start hook logout behavior", () => {
  const sessionStartBin = fileURLToPath(new URL("../dist/hooks/session-start.js", import.meta.url));

  test("exits silently after explicit logout marker", (t) => {
    const tmpDir = makeTmpDir();
    const supermemoryDir = join(tmpDir, ".codex", "supermemory");
    mkdirSync(supermemoryDir, { recursive: true });
    writeFileSync(join(supermemoryDir, ".logged-out"), new Date().toISOString());
    t.after(() => rmSync(tmpDir, { recursive: true, force: true }));

    const result = spawnSync("node", [sessionStartBin], {
      input: JSON.stringify({ session_id: "s1" }),
      env: { ...process.env, HOME: tmpDir, USERPROFILE: tmpDir, SUPERMEMORY_CODEX_API_KEY: "" },
      encoding: "utf-8",
      timeout: 5_000,
    });

    assert.equal(result.status, 0);
    assert.equal(result.stdout, "");
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

// ─── skill scripts (search/save/forget/status/logout) ───────────────────────
//
// These scripts (dist/skills/*.js) are entry-points invoked by Codex skills.
// They reuse SupermemoryClient + tags, so we only smoke-test the CLI shape:
// argument parsing, the unconfigured-fallback message, and clean exit codes.

describe("skill scripts: search/add/save/forget/status/logout", () => {
  const searchBin = fileURLToPath(new URL("../dist/skills/search-memory.js", import.meta.url));
  const addBin = fileURLToPath(new URL("../dist/skills/add-memory.js", import.meta.url));
  const saveBin = fileURLToPath(new URL("../dist/skills/save-memory.js", import.meta.url));
  const forgetBin = fileURLToPath(new URL("../dist/skills/forget-memory.js", import.meta.url));
  const statusBin = fileURLToPath(new URL("../dist/skills/status.js", import.meta.url));
  const logoutBin = fileURLToPath(new URL("../dist/skills/logout.js", import.meta.url));

  // Run a script with a fresh empty $HOME (no config file) and an empty
  // SUPERMEMORY_CODEX_API_KEY so isConfigured() is false. Returns the spawn result.
  function runSkillUnconfigured(t, bin, args) {
    const tmpDir = makeTmpDir();
    mkdirSync(join(tmpDir, ".codex"), { recursive: true });
    t.after(() => rmSync(tmpDir, { recursive: true, force: true }));
    return spawnSync("node", [bin, ...args], {
      env: { PATH: process.env.PATH, HOME: tmpDir, USERPROFILE: tmpDir, SUPERMEMORY_CODEX_API_KEY: "" },
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
      env: { PATH: process.env.PATH, HOME: tmpDir, USERPROFILE: tmpDir, SUPERMEMORY_CODEX_API_KEY: "sm_test" },
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

  test("add-memory prints not-configured message and exits 1 when no API key", (t) => {
    const result = runSkillUnconfigured(t, addBin, ["some content"]);
    assert.equal(result.status, 1);
    assert.match(result.stderr, /Supermemory is not authenticated/);
  });

  test("forget-memory prints not-configured message and exits 1 when no API key", (t) => {
    const result = runSkillUnconfigured(t, forgetBin, ["some content"]);
    assert.equal(result.status, 1);
    assert.match(result.stderr, /Supermemory is not authenticated/);
  });

  test("status prints disconnected state and exits 0 when no API key", (t) => {
    const result = runSkillUnconfigured(t, statusBin, []);
    assert.equal(result.status, 0);
    assert.match(result.stdout, /Connected: no/);
    assert.match(result.stdout, /supermemory-login/);
  });

  test("logout removes saved credentials and config apiKey", (t) => {
    const tmpDir = makeTmpDir();
    const codexDir = join(tmpDir, ".codex");
    const supermemoryDir = join(codexDir, "supermemory");
    mkdirSync(supermemoryDir, { recursive: true });
    writeFileSync(join(supermemoryDir, "credentials.json"), JSON.stringify({ apiKey: "sm_test" }));
    writeFileSync(join(supermemoryDir, ".auth-attempted"), new Date().toISOString());
    writeFileSync(join(codexDir, "supermemory.json"), JSON.stringify({ apiKey: "sm_config", maxMemories: 3 }));
    t.after(() => rmSync(tmpDir, { recursive: true, force: true }));

    const result = spawnSync("node", [logoutBin], {
      env: { PATH: process.env.PATH, HOME: tmpDir, USERPROFILE: tmpDir, SUPERMEMORY_CODEX_API_KEY: "" },
      encoding: "utf-8",
    });

    assert.equal(result.status, 0, result.stderr);
    assert.match(result.stdout, /Logged out/);
    assert.ok(!existsSync(join(supermemoryDir, "credentials.json")), "credentials should be removed");
    assert.ok(!existsSync(join(supermemoryDir, ".auth-attempted")), "auth marker should be removed");
    assert.ok(existsSync(join(supermemoryDir, ".logged-out")), "logged-out marker should be created");
    assert.deepEqual(JSON.parse(readFileSync(join(codexDir, "supermemory.json"), "utf-8")), { maxMemories: 3 });
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

  test("add-memory prints usage and exits 0 when no content is given", (t) => {
    const result = runSkillNoArgs(t, addBin);
    assert.equal(result.status, 0);
    assert.match(result.stdout, /No content provided/);
    assert.match(result.stdout, /node add-memory\.js/);
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

// ─── memory deduplication across canonical and legacy containers ─────────────

describe("memory deduplication", () => {
  function dedupKey(id, text) {
    const normalized = text.toLowerCase().trim();
    if (normalized) return `content:${normalized}`;
    return id ? `id:${id}` : "";
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

    assert.equal(result.length, 2, "should deduplicate identical content");
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

  test("deduplicates legacy copies when ids differ but content matches", () => {
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

    assert.equal(result.length, 1, "should keep one logical memory");
  });
});
