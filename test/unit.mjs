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
import { inflateSync } from "node:zlib";
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

function readGeneratedPetPng(path) {
  const png = readFileSync(path);
  let offset = 8;
  let width = 0;
  let height = 0;
  const idat = [];

  while (offset < png.length) {
    const length = png.readUInt32BE(offset);
    const type = png.toString("ascii", offset + 4, offset + 8);
    const data = png.subarray(offset + 8, offset + 8 + length);
    if (type === "IHDR") {
      width = data.readUInt32BE(0);
      height = data.readUInt32BE(4);
    } else if (type === "IDAT") {
      idat.push(data);
    }
    offset += 12 + length;
  }

  const scanlines = inflateSync(Buffer.concat(idat));
  const stride = width * 4 + 1;
  return {
    width,
    height,
    pixel(x, y) {
      assert.equal(scanlines[y * stride], 0, "generated pet PNG must use filter 0");
      return [...scanlines.subarray(y * stride + 1 + x * 4, y * stride + 1 + x * 4 + 4)];
    },
  };
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

  test("adds configured recall containers only when automatic recall is enabled", (t) => {
    const tmpDir = makeTmpDir();
    t.after(() => rmSync(tmpDir, { recursive: true, force: true }));
    const repoDir = join(tmpDir, "repo");
    mkdirSync(repoDir, { recursive: true });
    runGit(["init"], repoDir);

    const readTags = (name, config) => {
      const homeDir = join(tmpDir, name);
      mkdirSync(join(homeDir, ".codex"), { recursive: true });
      writeFileSync(join(homeDir, ".codex", "supermemory.json"), JSON.stringify(config));
      const script = `
        import { getAllReadTags } from ${JSON.stringify(tagsModule)};
        console.log(JSON.stringify(getAllReadTags(process.argv.at(-1))));
      `;
      const result = spawnSync("node", ["--input-type=module", "-e", script, repoDir], {
        env: { ...process.env, HOME: homeDir, USERPROFILE: homeDir, SUPERMEMORY_CODEX_API_KEY: "sm_test" },
        encoding: "utf-8",
      });
      assert.equal(result.status, 0, result.stderr);
      return JSON.parse(result.stdout);
    };

    const customContainers = [
      { tag: " coding_personal ", description: "Personal coding context" },
      { tag: "coding_personal", description: "Duplicate" },
      { tag: "copla_company", description: "Company context" },
    ];
    const baseline = readTags("baseline", {});
    const disabled = readTags("disabled", { autoRecallContainers: false, customContainers });
    const enabled = readTags("enabled", { autoRecallContainers: true, customContainers });

    assert.deepEqual(disabled, baseline);
    assert.equal(enabled.filter((tag) => tag === "coding_personal").length, 1);
    assert.equal(enabled.filter((tag) => tag === "copla_company").length, 1);
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

  test("normalizes high-quality profile recall hits", () => {
    const script = `
      import { mergeProfileResults } from ${JSON.stringify(mergeModule)};
      const long = "x".repeat(360);
      const merged = mergeProfileResults([{
        success: true,
        profile: { static: [], dynamic: [] },
        searchResults: { results: [
          { id: "memory", memory: "memory value", similarity: 0.99, metadata: { title: "Decision", filePath: "src/a.ts" } },
          { id: "chunk", memory: {}, chunk: "chunk value", similarity: 0.95 },
          { id: "content", content: "content value", similarity: 0.9 },
          { id: "text", text: "text value", similarity: 0.85 },
          { id: "context", context: "context value", similarity: 0.8 },
          { id: "sixth", memory: long, similarity: 0.75 },
          { id: "low", memory: "too weak", similarity: 0.54 },
          { id: "object", context: { value: "never stringify" }, similarity: 1 }
        ], total: 8 }
      }], 20);
      console.log(JSON.stringify(merged.searchResults.results));
    `;
    const result = spawnSync("node", ["--input-type=module", "-e", script], {
      encoding: "utf-8",
    });
    assert.equal(result.status, 0, result.stderr);
    const results = JSON.parse(result.stdout);
    assert.equal(results.length, 6);
    assert.deepEqual(results.slice(0, 5).map((item) => item.memory), [
      "memory value", "chunk value", "content value", "text value", "context value",
    ]);
    assert.equal(results[5].memory.length, 360);
    assert.equal(results[0].title, "Decision");
    assert.equal(results[0].filepath, "src/a.ts");
  });

  test("keeps full recall identities and accepts score-only hits", () => {
    const script = `
      import { mergeProfileResults } from ${JSON.stringify(mergeModule)};
      const prefix = "x".repeat(300);
      const first = prefix + " first ending";
      const second = prefix + " second ending";
      const merged = mergeProfileResults([{
        success: true,
        profile: { static: [], dynamic: [] },
        searchResults: { results: [
          { memory: "score only", score: 0.95 },
          { memory: first, similarity: 0.9 },
          { memory: second, similarity: 0.8 },
          { memory: "missing similarity" },
          { memory: "weak score only", score: 0.2 },
          { memory: "too weak", similarity: 0.54 }
        ], total: 6 }
      }], 5);
      console.log(JSON.stringify(merged.searchResults.results));
    `;
    const result = spawnSync("node", ["--input-type=module", "-e", script], {
      encoding: "utf-8",
    });
    assert.equal(result.status, 0, result.stderr);
    const results = JSON.parse(result.stdout);
    assert.deepEqual(results.map((item) => item.memory.slice(-13)), [
      "score only",
      " first ending",
      "second ending",
      "ng similarity",
    ]);
    assert.equal(results[0].score, 0.95);
    assert.ok(results[1].memory.length > 300);
    assert.notEqual(results[1].memory, results[2].memory);
    assert.ok(!results.some((item) => item.memory === "weak score only"));
  });

  test("keeps the default five-result limit when configured with five", () => {
    const script = `
      import { mergeProfileResults } from ${JSON.stringify(mergeModule)};
      const results = Array.from({ length: 10 }, (_, index) => ({
        id: String(index), memory: \`memory \${index}\`, similarity: 1 - index / 100,
      }));
      const merged = mergeProfileResults([{
        success: true,
        profile: { static: [], dynamic: [] },
        searchResults: { results, total: results.length },
      }], 5);
      console.log(merged.searchResults.results.length);
    `;
    const result = spawnSync("node", ["--input-type=module", "-e", script], { encoding: "utf-8" });
    assert.equal(result.status, 0, result.stderr);
    assert.equal(Number(result.stdout), 5);
  });

  test("globally ranks, deduplicates, and returns fifteen results when configured", () => {
    const script = `
      import { mergeProfileResults } from ${JSON.stringify(mergeModule)};
      const results = Array.from({ length: 20 }, (_, index) => ({
        id: String(index), memory: \`memory \${index}\`, similarity: 1 - index / 100,
      }));
      const merged = mergeProfileResults([
        { success: true, profile: { static: [], dynamic: [] }, searchResults: { results: results.slice(0, 10), total: 10 } },
        { success: true, profile: { static: [], dynamic: [] }, searchResults: { results: [{ ...results[0], id: "duplicate" }, ...results.slice(10)], total: 11 } },
      ], 15);
      console.log(JSON.stringify(merged.searchResults.results));
    `;
    const result = spawnSync("node", ["--input-type=module", "-e", script], { encoding: "utf-8" });
    assert.equal(result.status, 0, result.stderr);
    const results = JSON.parse(result.stdout);
    assert.equal(results.length, 15);
    assert.deepEqual(results.map((item) => item.memory), Array.from({ length: 15 }, (_, i) => `memory ${i}`));
  });
});

describe("capture tracker", () => {
  const trackerModule = new URL("../dist/services/tracker.js", import.meta.url).href;
  const captureModule = new URL("../dist/services/capture.js", import.meta.url).href;

  test("reports a successful capture for the Stop hook notice", (t) => {
    const homeDir = makeTmpDir();
    t.after(() => rmSync(homeDir, { recursive: true, force: true }));
    const transcriptFile = join(homeDir, "transcript.jsonl");
    writeFileSync(
      transcriptFile,
      [
        JSON.stringify({ type: "response_item", payload: { type: "message", role: "user", content: [
          { type: "input_text", text: "Remember that " },
          { type: "input_text", text: "we use PostgreSQL." },
        ] } }),
        JSON.stringify({ type: "event_msg", payload: { type: "user_message", message: "Remember that we use PostgreSQL." } }),
        JSON.stringify({ type: "response_item", payload: { type: "message", role: "assistant", content: [
          { type: "output_text", text: "Understood." },
        ] } }),
      ].join("\n"),
    );
    const script = `
      import { captureEntries } from ${JSON.stringify(captureModule)};
      let capturedContent = "";
      const client = { addMemory: async (content) => {
        capturedContent = content;
        return { success: true };
      } };
      const result = await captureEntries(
        "flush",
        client,
        "notice-session",
        ${JSON.stringify(transcriptFile)},
        {
          canonical: "repo_test__1234567890abcdef",
          project: "repo_test__1234567890abcdef",
          user: "repo_test__1234567890abcdef",
          projectName: "test",
          projectId: "1234567890abcdef",
        },
      );
      console.log(JSON.stringify({ result, capturedContent }));
    `;
    const result = spawnSync("node", ["--input-type=module", "-e", script], {
      env: {
        ...process.env,
        HOME: homeDir,
        USERPROFILE: homeDir,
        SUPERMEMORY_CODEX_API_KEY: "sm_test",
      },
      encoding: "utf-8",
    });
    assert.equal(result.status, 0, result.stderr);
    const captured = JSON.parse(result.stdout);
    assert.deepEqual(captured.result, { status: "captured", entryCount: 2 });
    assert.match(captured.capturedContent, /1\. \[user\] Remember that we use PostgreSQL\./);
    assert.match(captured.capturedContent, /2\. \[assistant\] Understood\./);
    assert.equal(captured.capturedContent.match(/Remember that we use PostgreSQL\./g)?.length, 1);
  });

  test("serializes overlapping capture transactions and keeps the cursor monotonic", (t) => {
    const homeDir = makeTmpDir();
    t.after(() => rmSync(homeDir, { recursive: true, force: true }));
    const script = `
      import { mkdirSync, utimesSync, writeFileSync } from "node:fs";
      import { homedir } from "node:os";
      import { join } from "node:path";
      import {
        getLastCapturedIndex,
        setLastCapturedIndex,
        withSessionCaptureLock,
      } from ${JSON.stringify(trackerModule)};
      const order = [];
      const first = withSessionCaptureLock("session", async () => {
        order.push("first-start");
        await new Promise((resolve) => setTimeout(resolve, 40));
        setLastCapturedIndex("session", 20);
        order.push("first-end");
      });
      await new Promise((resolve) => setTimeout(resolve, 5));
      const second = withSessionCaptureLock("session", async () => {
        order.push("second");
        setLastCapturedIndex("session", 10);
      });
      const acquired = await Promise.all([first, second]);

      const trackerDir = join(homedir(), ".codex-supermemory", "trackers");
      mkdirSync(trackerDir, { recursive: true });
      const staleLock = join(trackerDir, "stale.capture.lock");
      writeFileSync(staleLock, process.pid + ":0:reused-pid");
      const staleTime = new Date(Date.now() - 40_000);
      utimesSync(staleLock, staleTime, staleTime);
      const reclaimed = await withSessionCaptureLock("stale", async () => {}, 250);

      console.log(JSON.stringify({ acquired, order, index: getLastCapturedIndex("session"), reclaimed }));
    `;
    const result = spawnSync("node", ["--input-type=module", "-e", script], {
      env: { ...process.env, HOME: homeDir, USERPROFILE: homeDir },
      encoding: "utf-8",
    });
    assert.equal(result.status, 0, result.stderr);
    assert.deepEqual(JSON.parse(result.stdout), {
      acquired: [true, true],
      order: ["first-start", "first-end", "second"],
      index: 20,
      reclaimed: true,
    });
  });
});

describe("hook SDK request bounds", () => {
  const clientModule = new URL("../dist/services/client.js", import.meta.url).href;

  test("aborts the SDK fetch without retries", () => {
    const script = `
      import { SupermemoryClient } from ${JSON.stringify(clientModule)};
      let calls = 0;
      let aborted = false;
      globalThis.fetch = (_url, { signal }) => new Promise((_resolve, reject) => {
        calls += 1;
        signal.addEventListener("abort", () => {
          aborted = true;
          reject(new Error("aborted"));
        }, { once: true });
      });
      const started = Date.now();
      const result = await new SupermemoryClient().getProfileMany(
        ["repo_test"], undefined, { timeoutMs: 20 },
      );
      console.log(JSON.stringify({ success: result.success, calls, aborted, elapsed: Date.now() - started }));
    `;
    const result = spawnSync("node", ["--input-type=module", "-e", script], {
      env: { ...process.env, SUPERMEMORY_CODEX_API_KEY: "sm_test" },
      encoding: "utf-8",
      timeout: 1_000,
    });
    assert.equal(result.status, 0, result.stderr);
    const output = JSON.parse(result.stdout);
    assert.equal(output.success, false);
    assert.equal(output.calls, 1);
    assert.equal(output.aborted, true);
    assert.ok(output.elapsed < 500, `bounded request took ${output.elapsed}ms`);
  });
});

describe("combined recall formatting", () => {
  const contextModule = new URL("../dist/services/context.js", import.meta.url).href;

  test("keeps full memory text while budgeting profile sections independently", () => {
    const script = `
      import { formatCombinedContext } from ${JSON.stringify(contextModule)};
      const long = "z".repeat(320) + " durable ending";
      const result = formatCombinedContext({
        success: true,
        profile: { static: ["s1", "s2", "s3"], dynamic: ["d1", "d2", "d3"] },
        searchResults: { results: [{ memory: long, similarity: 0.9 }], total: 1 },
      }, 5, 2);
      console.log(JSON.stringify(result));
    `;
    const result = spawnSync("node", ["--input-type=module", "-e", script], {
      encoding: "utf-8",
    });
    assert.equal(result.status, 0, result.stderr);
    const output = JSON.parse(result.stdout);
    assert.match(output.text, /1\. ◪ s1/);
    assert.match(output.text, /3\. ◪ d1/);
    assert.doesNotMatch(output.text, /s3|d3/);
    assert.match(output.text, /durable ending/);
    assert.match(output.text, /from supermemory/);
    assert.equal(output.newFacts.at(-1).endsWith("durable ending"), true);
  });

  test("bounds complete prompt context and returns only emitted memories", () => {
    const script = `
      import { formatRecallContext } from ${JSON.stringify(contextModule)};
      import { factKey } from ${JSON.stringify(new URL("../dist/services/factCache.js", import.meta.url).href)};
      const matches = Array.from({ length: 20 }, (_, index) => ({
        memory: \`memory-\${index}-\${"x".repeat(1000)}\`,
        similarity: 1 - index / 100,
      }));
      const options = {
        containerTag: "repo_test",
        maxMemories: 15,
        maxTokens: 2000,
        customContainers: [
          { tag: "coding_personal", description: "Personal coding context" },
          { tag: "copla_company", description: "Company context" },
        ],
      };
      const result = formatRecallContext(matches, options);
      const repeated = formatRecallContext([matches[0]], {
        ...options,
        seenFacts: new Set(result.newFacts.map(factKey)),
      });
      console.log(JSON.stringify({ result, repeated, excluded: matches.at(-1).memory }));
    `;
    const result = spawnSync("node", ["--input-type=module", "-e", script], { encoding: "utf-8" });
    assert.equal(result.status, 0, result.stderr);
    const output = JSON.parse(result.stdout);
    assert.ok(output.result.text.length <= 8_000);
    assert.match(output.result.text, /^<supermemory-recall>/);
    assert.match(output.result.text, /<\/supermemory-recall>$/);
    assert.match(output.result.text, /coding_personal/);
    assert.ok(output.result.newFacts.length <= 15);
    assert.ok(!output.result.newFacts.includes(output.excluded));
    assert.deepEqual(output.repeated, { text: "", newFacts: [] });
  });

  test("returns up to fifteen static and fifteen dynamic facts within session budget", () => {
    const script = `
      import { formatSessionContext } from ${JSON.stringify(contextModule)};
      const result = formatSessionContext({
        success: true,
        profile: {
          static: Array.from({ length: 20 }, (_, index) => \`static \${index}\`),
          dynamic: Array.from({ length: 20 }, (_, index) => \`dynamic \${index}\`),
        },
      }, {
        maxProfileItems: 15,
        maxTokens: 5000,
        projectName: "project",
        containerTag: "repo_project",
      });
      console.log(JSON.stringify(result));
    `;
    const result = spawnSync("node", ["--input-type=module", "-e", script], { encoding: "utf-8" });
    assert.equal(result.status, 0, result.stderr);
    const output = JSON.parse(result.stdout);
    assert.equal(output.newFacts.length, 30);
    assert.ok(output.text.length <= 20_000);
    assert.match(output.text, /^<supermemory-context>/);
    assert.match(output.text, /<\/supermemory-context>$/);
    assert.ok(!output.newFacts.includes("static 15"));
    assert.ok(!output.newFacts.includes("dynamic 15"));
  });

  test("truncates only the final session item and keeps closing markup", () => {
    const script = `
      import { formatSessionContext } from ${JSON.stringify(contextModule)};
      import { factKey } from ${JSON.stringify(new URL("../dist/services/factCache.js", import.meta.url).href)};
      const longFact = "x".repeat(30_000);
      const profile = {
        success: true,
        profile: {
          static: [longFact],
          dynamic: [],
        },
      };
      const options = {
        maxProfileItems: 15,
        maxTokens: 5000,
        projectName: "project",
        containerTag: "repo_project",
      };
      const result = formatSessionContext(profile, options);
      const repeated = formatSessionContext(profile, {
        ...options,
        seenFacts: new Set(result.newFacts.map(factKey)),
      });
      console.log(JSON.stringify({ result, repeated, longFact }));
    `;
    const result = spawnSync("node", ["--input-type=module", "-e", script], { encoding: "utf-8" });
    assert.equal(result.status, 0, result.stderr);
    const output = JSON.parse(result.stdout);
    assert.ok(output.result.text.length <= 20_000);
    assert.match(output.result.text, /…\n<\/supermemory-context>$/);
    assert.deepEqual(output.result.newFacts, [output.longFact]);
    assert.deepEqual(output.repeated, { text: "", newFacts: [] });
  });

  test("rejects invalid token limits with the configured field name", () => {
    const script = `
      import { formatRecallContext, formatSessionContext } from ${JSON.stringify(contextModule)};
      const messages = [];
      try {
        formatRecallContext([{ memory: "memory" }], {
          containerTag: "repo", maxMemories: 1, maxTokens: 0,
        });
      } catch (error) { messages.push(error.message); }
      try {
        formatSessionContext({ success: true, profile: { static: ["fact"], dynamic: [] } }, {
          maxProfileItems: 1, maxTokens: Number.NaN, projectName: "project", containerTag: "repo",
        });
      } catch (error) { messages.push(error.message); }
      console.log(JSON.stringify(messages));
    `;
    const result = spawnSync("node", ["--input-type=module", "-e", script], { encoding: "utf-8" });
    assert.equal(result.status, 0, result.stderr);
    assert.deepEqual(JSON.parse(result.stdout), [
      "maxPromptRecallTokens must be a positive number",
      "maxRecallTokens must be a positive number",
    ]);
  });
});

describe("session recall deduplication", () => {
  const factCacheModule = new URL("../dist/services/factCache.js", import.meta.url).href;

  test("stores only a bounded set of hashed fact identities", (t) => {
    const homeDir = makeTmpDir();
    t.after(() => rmSync(homeDir, { recursive: true, force: true }));
    const script = `
      import { addSeenFacts, getSeenFacts } from ${JSON.stringify(factCacheModule)};
      addSeenFacts("session", Array.from({ length: 550 }, (_, i) => \`fact \${i}\`));
      console.log(JSON.stringify([...getSeenFacts("session")]));
    `;
    const result = spawnSync("node", ["--input-type=module", "-e", script], {
      env: { ...process.env, HOME: homeDir, USERPROFILE: homeDir },
      encoding: "utf-8",
    });
    assert.equal(result.status, 0, result.stderr);
    const facts = JSON.parse(result.stdout);
    assert.equal(facts.length, 500);
    assert.ok(facts.every((fact) => /^sha256:[0-9a-f]{64}$/.test(fact)));
    assert.ok(!facts.some((fact) => fact.includes("fact")));
  });
});

describe("direct recall policy", () => {
  const policyModule = new URL("../dist/services/recallPolicy.js", import.meta.url).href;
  const hookClientModule = new URL("../dist/services/hookRecallClient.js", import.meta.url).href;

  test("skips control and tiny prompts while capping substantive queries", () => {
    const script = `
      import { shouldRecallPrompt, prepareRecallQuery } from ${JSON.stringify(policyModule)};
      console.log(JSON.stringify({
        decisions: ["short", "/supermemory", "!shell command", "# heading text", "explain the cache design"].map(shouldRecallPrompt),
        queryLength: prepareRecallQuery("x".repeat(600)).length,
      }));
    `;
    const result = spawnSync("node", ["--input-type=module", "-e", script], { encoding: "utf-8" });
    assert.equal(result.status, 0, result.stderr);
    assert.deepEqual(JSON.parse(result.stdout), {
      decisions: [false, false, false, false, true],
      queryLength: 500,
    });
  });

  test("aborts hook-only profile fetches and fails open", () => {
    const script = `
      import { getHookProfileWithSearchMany } from ${JSON.stringify(hookClientModule)};
      const fetchImpl = (_url, { signal }) => new Promise((_resolve, reject) => {
        signal.addEventListener("abort", () => reject(new Error("aborted")), { once: true });
      });
      const started = Date.now();
      const result = await getHookProfileWithSearchMany(["repo_test"], "substantive recall query", {
        timeoutMs: 20,
        fetchImpl,
      });
      console.log(JSON.stringify({ success: result.success, elapsed: Date.now() - started }));
    `;
    const result = spawnSync("node", ["--input-type=module", "-e", script], {
      env: { ...process.env, SUPERMEMORY_CODEX_API_KEY: "sm_test" },
      encoding: "utf-8",
      timeout: 1_000,
    });
    assert.equal(result.status, 0, result.stderr);
    const output = JSON.parse(result.stdout);
    assert.equal(output.success, false);
    assert.ok(output.elapsed < 500, `abort took ${output.elapsed}ms`);
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
  test("SessionStart owns browser authentication with a bounded window", () => {
    const authSource = readFileSync(new URL("../src/services/auth.ts", import.meta.url), "utf-8");
    const sessionStartSource = readFileSync(new URL("../src/hooks/session-start.ts", import.meta.url), "utf-8");
    assert.ok(authSource.includes("startAuthFlow(timeoutMs = AUTH_TIMEOUT)"));
    assert.ok(sessionStartSource.includes("startAuthFlow(getSessionStartAuthTimeoutMs())"));
    assert.ok(!existsSync(new URL("../src/skills/login.ts", import.meta.url)));
  });

  test("SessionStart keeps update notices out of model context", () => {
    const sessionStartSource = readFileSync(new URL("../src/hooks/session-start.ts", import.meta.url), "utf-8");
    const versionCheckSource = readFileSync(new URL("../src/services/version-check.ts", import.meta.url), "utf-8");
    assert.ok(sessionStartSource.includes("exitWithContext(text, combineContextParts(["));
    assert.ok(!sessionStartSource.includes("context,\n        updateNotice,"));
    assert.ok(!sessionStartSource.includes('exitWithContext(await updateCheck ?? ""'));
    assert.ok(!versionCheckSource.includes("[SUPERMEMORY UPDATE]"));
    assert.ok(versionCheckSource.includes("Run in your terminal:"));
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
    assert.match(content, /human teammate would remember/);
    assert.match(content, /Transient Git state/);
  });

  test("automatic capture writes user entity context", () => {
    const content = readFileSync(new URL("../src/services/capture.ts", import.meta.url), "utf-8");
    assert.ok(content.includes("entityContext: USER_ENTITY_CONTEXT"));
    assert.ok(content.includes('sm_scope: "personal"'));
    assert.ok(content.includes("project: tags.projectName"));
  });

});

describe("hooks.json format", () => {
  test("wrapped hooks.json shape is valid JSON", () => {
    const recallScript = "/home/user/.codex/supermemory/recall.js";
    const flushScript = "/home/user/.codex/supermemory/flush.js";

    const hooksJson = {
      hooks: {
        UserPromptSubmit: [{ hooks: [{ type: "command", command: `node ${recallScript}`, timeout: 5 }] }],
        Stop: [{ hooks: [{ type: "command", command: `node ${flushScript}`, timeout: 30, async: true }] }],
      },
    };
    const json = JSON.stringify(hooksJson, null, 2);
    const parsed = JSON.parse(json);

    assert.ok(parsed.hooks, "must have top-level hooks key");
    assert.ok(!parsed.UserPromptSubmit, "must NOT have UserPromptSubmit at top level");
    assert.ok(Array.isArray(parsed.hooks.UserPromptSubmit), "hooks.UserPromptSubmit must be an array");
    assert.equal(parsed.hooks.UserPromptSubmit[0].hooks[0].timeout, 5);
    assert.ok(Array.isArray(parsed.hooks.Stop), "hooks.Stop must be an array");
    assert.equal(parsed.hooks.Stop[0].hooks[0].type, "command");
    assert.equal(parsed.hooks.Stop[0].hooks[0].async, true);
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

  test("generated pet badge reflects Codex states", () => {
    const pet = readGeneratedPetPng(fileURLToPath(new URL("../dist/pet/spritesheet.png", import.meta.url)));
    assert.equal(pet.width, 1536);
    assert.equal(pet.height, 1872);

    const accentAtRow = (row) => pet.pixel(17, row * 208 + 178);
    const running = accentAtRow(7);
    const ready = accentAtRow(8);
    const blocked = accentAtRow(5);
    const waiting = accentAtRow(6);

    assert.ok(running[2] > running[0] && running[2] > running[1], "running accent should be blue");
    assert.ok(ready[1] > ready[0] && ready[1] > ready[2], "ready accent should be green");
    assert.ok(blocked[0] > blocked[1] && blocked[0] > blocked[2], "blocked accent should be red");
    assert.ok(waiting[0] > waiting[1] && waiting[1] > waiting[2], "needs-input accent should be amber");
    assert.equal(pet.pixel(7 * 192 + 17, 178)[3], 0, "unused idle frames should be transparent");
  });

  test("install keeps only status skill and registers hosted MCP", (t) => {
    const { tmpDir, codexDir } = setupCodexHome(t);

    for (const legacy of ["supermemory-search", "supermemory-login", "supermemory-logout"]) {
      mkdirSync(join(codexDir, "skills", legacy), { recursive: true });
      writeFileSync(join(codexDir, "skills", legacy, "SKILL.md"), "legacy");
    }

    const result = runCli(cliBin, "install", tmpDir);
    assert.equal(result.status, 0, `install should exit 0: ${result.stderr}`);

    const skillsDir = join(codexDir, "skills");
    assert.ok(existsSync(join(skillsDir, "supermemory-status", "SKILL.md")));
    for (const legacy of ["supermemory-search", "supermemory-login", "supermemory-logout"]) {
      assert.ok(!existsSync(join(skillsDir, legacy)), `${legacy} should be removed`);
    }

    const toml = readToml(join(codexDir, "config.toml"));
    assert.equal(toml.mcp_servers.supermemory.command, "node");
    assert.deepEqual(toml.mcp_servers.supermemory.args, [
      join(codexDir, "supermemory", "mcp-proxy.js"),
    ]);
    assert.equal(toml.tui.pet, "supermemory");
    assert.equal(toml.tui.pet_anchor, "screen-bottom");
    assert.ok(existsSync(join(codexDir, "pets", "supermemory", "pet.json")));
    assert.ok(existsSync(join(codexDir, "pets", "supermemory", "spritesheet.png")));
    const config = JSON.parse(readFileSync(join(codexDir, "supermemory.json"), "utf-8"));
    assert.equal(config.recallMode, "direct");
    assert.equal(config.captureEveryNTurns, 0);
  });

  test("install registers synchronous recall hooks and background capture", (t) => {
    const { tmpDir, codexDir } = setupCodexHome(t);
    const hooksPath = join(codexDir, "hooks.json");
    const flushCmd = `node ${join(codexDir, "supermemory", "flush.js")}`;
    writeFileSync(hooksPath, JSON.stringify({
      hooks: {
        Stop: [{ hooks: [{ type: "command", command: flushCmd, timeout: 60 }] }],
      },
    }));

    const result = runCli(cliBin, "install", tmpDir);
    assert.equal(result.status, 0, result.stderr);

    const hooks = JSON.parse(readFileSync(hooksPath, "utf-8")).hooks;
    const stop = hooks.Stop.flatMap((group) => group.hooks)
      .find((hook) => hook.command === flushCmd);
    const recall = hooks.UserPromptSubmit.flatMap((group) => group.hooks)
      .find((hook) => hook.command.endsWith("/recall.js"));
    const recallApprove = hooks.PreToolUse.flatMap((group) => group.hooks)
      .find((hook) => hook.command.endsWith("/recall-approve.js"));
    const recallApproveGroup = hooks.PreToolUse.find((group) =>
      group.hooks.includes(recallApprove)
    );
    const sessionStart = hooks.SessionStart.flatMap((group) => group.hooks)
      .find((hook) => hook.command.endsWith("/session-start.js"));

    assert.deepEqual(
      { async: stop.async, timeout: stop.timeout },
      { async: true, timeout: 30 },
    );
    assert.equal(recall.async, undefined);
    assert.equal(recall.timeout, 5);
    assert.equal(recall.additionalContextLimit, 0);
    assert.equal(recallApprove.async, undefined);
    assert.equal(recallApprove.timeout, 5);
    assert.equal(recallApprove.additionalContextLimit, undefined);
    assert.equal(recallApproveGroup.matcher, "^mcp__supermemory__");
    assert.ok(!existsSync(join(codexDir, "supermemory", "capture-turn.js")));
    assert.equal(sessionStart.async, undefined);
    assert.equal(sessionStart.timeout, 30);
    assert.equal(sessionStart.additionalContextLimit, 0);
    assert.equal(stop.additionalContextLimit, undefined);
  });

  test("uninstall removes skill directories", (t) => {
    const { tmpDir, codexDir } = setupCodexHome(t);

    const installResult = runCli(cliBin, "install", tmpDir);
    assert.equal(installResult.status, 0, `install should exit 0: ${installResult.stderr}`);
    const uninstallResult = runCli(cliBin, "uninstall", tmpDir);
    assert.equal(uninstallResult.status, 0, `uninstall should exit 0: ${uninstallResult.stderr}`);

    const skillsDir = join(codexDir, "skills");
    assert.ok(!existsSync(join(skillsDir, "supermemory-status")));
    assert.ok(!existsSync(join(codexDir, "pets", "supermemory")));
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
    writeFileSync(
      configPath,
      'model = "gpt-5"\n\n[features]\nweb_search = true\n\n[tui]\npet = "dewey"\npet_anchor = "composer"\n',
    );

    const result = runCli(cliBin, "install", tmpDir);

    assert.equal(result.status, 0, `install should exit 0: ${result.stderr}`);
    const config = readToml(configPath);
    assert.equal(config.model, "gpt-5");
    assert.equal(config.features.web_search, true);
    assert.equal(config.features.codex_hooks, undefined);
    assert.equal(config.mcp_servers.supermemory.command, "node");
    assert.equal(config.tui.pet, "dewey");
    assert.equal(config.tui.pet_anchor, "composer");
  });
});


// ─── recall hook output envelope ────────────────────────────────────────────

describe("recall hook output envelope", () => {
  const recallBin = fileURLToPath(new URL("../dist/hooks/recall.js", import.meta.url));

  // Recall must return login guidance without starting browser authentication.
  function runRecallUnconfigured(t, input) {
    const tmpDir = makeTmpDir();
    t.after(() => rmSync(tmpDir, { recursive: true, force: true }));
    const result = spawnSync("node", [recallBin], {
      input,
      env: { ...process.env, HOME: tmpDir, USERPROFILE: tmpDir, SUPERMEMORY_CODEX_API_KEY: "" },
      encoding: "utf-8",
      timeout: 5_000,
    });
    return { result, tmpDir };
  }

  test("outputs hookSpecificOutput envelope when not configured", (t) => {
    const { result, tmpDir } = runRecallUnconfigured(
      t,
      JSON.stringify({ session_id: "s1", prompt: "hello" }),
    );
    const parsed = JSON.parse(result.stdout);
    assert.ok("hookSpecificOutput" in parsed, "must have hookSpecificOutput key");
    assert.equal(parsed.hookSpecificOutput.hookEventName, "UserPromptSubmit");
    assert.equal(typeof parsed.hookSpecificOutput.additionalContext, "string");
    assert.equal(
      existsSync(join(tmpDir, ".codex", "supermemory", ".auth-attempted")),
      false,
    );
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
    const tmpDir = makeTmpDir();
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
    const tmpDir = makeTmpDir();
    t.after(() => rmSync(tmpDir, { recursive: true, force: true }));

    const result = spawnSync("node", [recallBin], {
      input: JSON.stringify({ prompt: "test" }),
      env: { ...process.env, HOME: tmpDir, USERPROFILE: tmpDir, SUPERMEMORY_CODEX_API_KEY: "" },
      encoding: "utf-8",
    });
    assert.equal(result.status, 0);
  });
});

describe("hosted MCP hooks", () => {
  const approveBin = fileURLToPath(new URL("../dist/hooks/recall-approve.js", import.meta.url));
  const proxyBin = fileURLToPath(new URL("../dist/hooks/mcp-proxy.js", import.meta.url));

  test("read-only searches show the query and are allowed", () => {
    const result = spawnSync("node", [approveBin], {
      input: JSON.stringify({
        tool_name: "mcp__supermemory__search_memory",
        tool_input: { query: "company employment full time" },
      }),
      encoding: "utf-8",
    });
    assert.equal(result.status, 0, result.stderr);
    const output = JSON.parse(result.stdout);
    assert.equal(output.systemMessage, "◪ supermemory · recalling: company employment full time");
    assert.equal(output.hookSpecificOutput.permissionDecision, "allow");
    assert.deepEqual(output.hookSpecificOutput.updatedInput, {
      query: "company employment full time",
    });
  });

  test("MCP proxy fails clearly when SessionStart has not authenticated", (t) => {
    const tmpDir = makeTmpDir();
    t.after(() => rmSync(tmpDir, { recursive: true, force: true }));
    const result = spawnSync("node", [proxyBin], {
      input: `${JSON.stringify({ jsonrpc: "2.0", id: 1, method: "initialize" })}\n`,
      env: { ...process.env, HOME: tmpDir, USERPROFILE: tmpDir, SUPERMEMORY_CODEX_API_KEY: "" },
      encoding: "utf-8",
    });
    assert.equal(result.status, 0, result.stderr);
    const output = JSON.parse(result.stdout);
    assert.equal(output.error.code, -32001);
    assert.match(output.error.message, /Start a new Codex task/);
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

// ─── status skill ───────────────────────────────────────────────────────────

describe("status skill", () => {
  const statusBin = fileURLToPath(new URL("../dist/skills/status.js", import.meta.url));

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

  function runStatusWithConfig(t, config) {
    const tmpDir = makeTmpDir();
    const codexDir = join(tmpDir, ".codex");
    mkdirSync(codexDir, { recursive: true });
    writeFileSync(join(codexDir, "supermemory.json"), JSON.stringify(config));
    t.after(() => rmSync(tmpDir, { recursive: true, force: true }));
    return spawnSync("node", [statusBin], {
      env: { PATH: process.env.PATH, HOME: tmpDir, USERPROFILE: tmpDir, SUPERMEMORY_CODEX_API_KEY: "" },
      encoding: "utf-8",
    });
  }

  test("status prints disconnected state and exits 0 when no API key", (t) => {
    const result = runSkillUnconfigured(t, statusBin, []);
    assert.equal(result.status, 0);
    assert.match(result.stdout, /Connected: no/);
    assert.match(result.stdout, /Start a new Codex task/);
  });

  test("status reports auto-recall off when auto recall is disabled", (t) => {
    const result = runStatusWithConfig(t, { autoRecallEveryPrompt: false, captureEveryNTurns: 0 });
    assert.equal(result.status, 0);
    assert.match(result.stdout, /Auto-recall: off/);
  });

  test("status maps legacy enabled auto-recall to direct mode", (t) => {
    const result = runStatusWithConfig(t, { autoRecallEveryPrompt: true, captureEveryNTurns: 0 });
    assert.equal(result.status, 0);
    assert.match(result.stdout, /Auto-recall: direct \(substantive prompts\)/);
  });

  test("status preserves advisory recall mode", (t) => {
    const result = runStatusWithConfig(t, { recallMode: "advisory", captureEveryNTurns: 0 });
    assert.equal(result.status, 0);
    assert.match(result.stdout, /Auto-recall: advisory/);
  });

  test("status reports turn-stop capture regardless of legacy cadence", (t) => {
    const result = runStatusWithConfig(t, { autoRecallEveryPrompt: false, captureEveryNTurns: 5, autoSaveEveryTurns: 3 });
    assert.equal(result.status, 0);
    assert.match(result.stdout, /Auto-capture: after completed turns/);
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
