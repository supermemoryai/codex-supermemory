/**
 * Unit tests for codex-supermemory using Node's built-in test runner.
 * Run with: node --test test/unit.mjs
 */
import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { writeFileSync, mkdirSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

// ─── helpers ────────────────────────────────────────────────────────────────

function makeTmpDir() {
  const dir = join(tmpdir(), `csm-test-${Date.now()}-${Math.random().toString(36).slice(2)}`);
  mkdirSync(dir, { recursive: true });
  return dir;
}

// Inline privacy logic (mirrors src/services/privacy.ts exactly)
function stripPrivateContent(s) {
  return s.replace(/<private>[\s\S]*?<\/private>/gi, "[REDACTED]");
}

function cleanContent(s) {
  return s
    .replace(/<system-reminder>[\s\S]*?<\/system-reminder>/gi, "")
    .replace(/<supermemory-context>[\s\S]*?<\/supermemory-context>/gi, "")
    .trim();
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

  test("reads transcript_path JSONL file when it exists (exits 0 without API key)", () => {
    const tmpDir = makeTmpDir();
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

    rmSync(tmpDir, { recursive: true, force: true });
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

  test("incremental capture: same session same transcript does not re-ingest", () => {
    const tmpDir = makeTmpDir();
    const transcriptFile = join(tmpDir, "transcript.jsonl");
    const sessionTrackerFile = join(tmpDir, "sessions.json");
    writeFileSync(
      transcriptFile,
      [
        JSON.stringify({ role: "user", content: "hello" }),
        JSON.stringify({ role: "assistant", content: "hi" }),
      ].join("\n")
    );

    // First call — processes 2 lines, no API key so exits 0 without sending
    const r1 = spawnSync("node", [captureBin], {
      input: JSON.stringify({ session_id: "incr-test", transcript_path: transcriptFile }),
      env: {
        ...process.env,
        SUPERMEMORY_CODEX_API_KEY: "",
        SUPERMEMORY_SESSION_TRACKER: sessionTrackerFile,
      },
      encoding: "utf-8",
    });
    assert.equal(r1.status, 0);

    // Second call with identical transcript — no new lines, should also exit 0
    const r2 = spawnSync("node", [captureBin], {
      input: JSON.stringify({ session_id: "incr-test", transcript_path: transcriptFile }),
      env: {
        ...process.env,
        SUPERMEMORY_CODEX_API_KEY: "",
        SUPERMEMORY_SESSION_TRACKER: sessionTrackerFile,
      },
      encoding: "utf-8",
    });
    assert.equal(r2.status, 0);

    rmSync(tmpDir, { recursive: true, force: true });
  });

  test("incremental capture: new lines are picked up on second call", () => {
    const tmpDir = makeTmpDir();
    const transcriptFile = join(tmpDir, "transcript.jsonl");
    const sessionTrackerFile = join(tmpDir, "sessions.json");

    writeFileSync(transcriptFile, JSON.stringify({ role: "user", content: "first" }) + "\n");

    const r1 = spawnSync("node", [captureBin], {
      input: JSON.stringify({ session_id: "incr-test2", transcript_path: transcriptFile }),
      env: {
        ...process.env,
        SUPERMEMORY_CODEX_API_KEY: "",
        SUPERMEMORY_SESSION_TRACKER: sessionTrackerFile,
      },
      encoding: "utf-8",
    });
    assert.equal(r1.status, 0);

    // Append a new exchange
    writeFileSync(
      transcriptFile,
      [
        JSON.stringify({ role: "user", content: "first" }),
        JSON.stringify({ role: "assistant", content: "response" }),
        JSON.stringify({ role: "user", content: "second" }),
      ].join("\n")
    );

    const r2 = spawnSync("node", [captureBin], {
      input: JSON.stringify({ session_id: "incr-test2", transcript_path: transcriptFile }),
      env: {
        ...process.env,
        SUPERMEMORY_CODEX_API_KEY: "",
        SUPERMEMORY_SESSION_TRACKER: sessionTrackerFile,
      },
      encoding: "utf-8",
    });
    assert.equal(r2.status, 0);

    rmSync(tmpDir, { recursive: true, force: true });
  });
});

// ─── cleanContent ────────────────────────────────────────────────────────────

describe("cleanContent", () => {
  test("leaves plain text unchanged", () => {
    assert.equal(cleanContent("hello world"), "hello world");
  });

  test("strips system-reminder block", () => {
    assert.equal(
      cleanContent("before <system-reminder>injected</system-reminder> after"),
      "before  after"
    );
  });

  test("strips supermemory-context block", () => {
    assert.equal(
      cleanContent("text <supermemory-context>ctx</supermemory-context> end"),
      "text  end"
    );
  });

  test("strips both tag types in one pass", () => {
    const input =
      "<system-reminder>r</system-reminder> mid <supermemory-context>c</supermemory-context>";
    assert.equal(cleanContent(input), "mid");
  });

  test("strips multiline blocks", () => {
    assert.equal(
      cleanContent("<system-reminder>\nline1\nline2\n</system-reminder>payload"),
      "payload"
    );
  });

  test("is case-insensitive", () => {
    assert.equal(
      cleanContent("<SYSTEM-REMINDER>secret</SYSTEM-REMINDER>"),
      ""
    );
  });

  test("trims surrounding whitespace", () => {
    assert.equal(cleanContent("  hello  "), "hello");
  });
});

// ─── MCP server ──────────────────────────────────────────────────────────────

describe("MCP server", () => {
  const mcpBin = new URL("../dist/mcp.js", import.meta.url).pathname;

  function mcpCall(input) {
    return spawnSync("node", [mcpBin], {
      input,
      env: { ...process.env, SUPERMEMORY_CODEX_API_KEY: "" },
      encoding: "utf-8",
      timeout: 5000,
    });
  }

  function firstLine(stdout) {
    return JSON.parse(stdout.trim().split("\n")[0]);
  }

  test("initialize returns protocolVersion and serverInfo", () => {
    const r = mcpCall(
      JSON.stringify({ jsonrpc: "2.0", id: 1, method: "initialize", params: {} }) + "\n"
    );
    const msg = firstLine(r.stdout);
    assert.equal(msg.result.protocolVersion, "2024-11-05");
    assert.equal(msg.result.serverInfo.name, "supermemory");
  });

  test("tools/list returns exactly 3 tools", () => {
    const r = mcpCall(
      JSON.stringify({ jsonrpc: "2.0", id: 2, method: "tools/list" }) + "\n"
    );
    const msg = firstLine(r.stdout);
    assert.equal(msg.result.tools.length, 3);
    const names = msg.result.tools.map((t) => t.name).sort();
    assert.deepEqual(names, ["listProjects", "memory", "recall"]);
  });

  test("ping returns empty result", () => {
    const r = mcpCall(
      JSON.stringify({ jsonrpc: "2.0", id: 3, method: "ping" }) + "\n"
    );
    const msg = firstLine(r.stdout);
    assert.deepEqual(msg.result, {});
  });

  test("unknown method returns -32601 error", () => {
    const r = mcpCall(
      JSON.stringify({ jsonrpc: "2.0", id: 4, method: "unknown/method" }) + "\n"
    );
    const msg = firstLine(r.stdout);
    assert.equal(msg.error.code, -32601);
  });

  test("tools/call memory with no API key returns not-configured error JSON", () => {
    const r = mcpCall(
      JSON.stringify({
        jsonrpc: "2.0",
        id: 5,
        method: "tools/call",
        params: { name: "memory", arguments: { mode: "add", content: "test" } },
      }) + "\n"
    );
    const msg = firstLine(r.stdout);
    const text = JSON.parse(msg.result.content[0].text);
    assert.equal(text.success, false);
    assert.ok(text.error.includes("SUPERMEMORY_CODEX_API_KEY"));
  });

  test("notifications (no id) produce no output line", () => {
    const r = mcpCall(
      JSON.stringify({ jsonrpc: "2.0", method: "notifications/initialized" }) + "\n"
    );
    // Notifications must not produce any response line
    assert.equal(r.stdout.trim(), "");
  });
});
