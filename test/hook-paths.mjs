import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, mkdirSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const cliBin = fileURLToPath(new URL("../dist/cli.js", import.meta.url));
const scripts = {
  SessionStart: "session-start.js",
  UserPromptSubmit: "recall.js",
  PreToolUse: "recall-approve.js",
  Stop: "flush.js",
};

function fixture(t, name, platform = process.platform) {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "csm-hook-path-")));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const home = join(root, name);
  const codexDir = join(home, ".codex");
  mkdirSync(codexDir, { recursive: true });
  const preload = join(root, "boundary.cjs");
  writeFileSync(preload, `
    require('node:os').homedir = () => process.env.TEST_CODEX_HOME;
    Object.defineProperty(process, 'platform', { value: ${JSON.stringify(platform)} });
    global.fetch = async () => { throw Error('Network disabled in hook path tests'); };
    for (const name of ['node:http', 'node:https', 'node:net']) {
      const module = require(name);
      for (const key of ['request', 'get', 'connect', 'createConnection']) {
        if (typeof module[key] === 'function') module[key] = () => { throw Error('Network disabled'); };
      }
    }
    const Module = require('node:module');
    const load = Module._extensions['.js'];
    Module._extensions['.js'] = (module, filename) => {
      if (require('node:path').dirname(filename) === require('node:path').join(process.env.TEST_CODEX_HOME, '.codex', 'supermemory')) {
        process.stderr.write('HOOK_STARTED:' + require('node:path').basename(filename) + '\\n');
      }
      return load(module, filename);
    };
  `);
  const env = {
    ...process.env,
    HOME: home,
    USERPROFILE: home,
    TEST_CODEX_HOME: home,
    SUPERMEMORY_CODEX_API_KEY: "sm_DUMMY_PATH_TEST",
    NODE_OPTIONS: `--require=${JSON.stringify(preload)}`,
  };
  const hooksPath = join(codexDir, "hooks.json");
  return {
    home, codexDir, hooksPath, env,
    cli(command) {
      const result = spawnSync(process.execPath, [cliBin, command], { env, encoding: "utf8", timeout: 10000 });
      assert.equal(result.status, 0, result.stderr);
      return result.stdout;
    },
    hooks() {
      return JSON.parse(readFileSync(hooksPath, "utf8")).hooks;
    },
  };
}

function invoke(command, env, shell, input = {}) {
  const windows = process.platform === "win32";
  return spawnSync(shell, windows ? ["/d", "/s", "/c", `"${command}"`] : ["-lc", command], {
    env,
    windowsVerbatimArguments: windows,
    encoding: "utf8",
    input: JSON.stringify(input),
    timeout: 10000,
  });
}

const shells = process.platform === "win32"
  ? [process.env.COMSPEC || "cmd.exe"]
  : ["/bin/sh", "/bin/bash", "/bin/zsh"].filter(existsSync);
const names = process.platform === "win32"
  ? ["plain", "home with spaces", "home's quotes", "home %PATH% !quoted! & (nested)", "mémoire 日本語"]
  : ["plain", "home with spaces", "nested home/with spaces", "home's quotes", 'home "double" quotes', "home $PATH `echo nope` ; & (nested)", "home\nnewline", "mémoire 日本語"];

for (const name of names) {
  test(`installed hook commands execute from ${JSON.stringify(name)}`, (t) => {
    const f = fixture(t, name);
    f.cli("install");
    const hooks = f.hooks();
    for (const [event, script] of Object.entries(scripts)) {
      const command = hooks[event][0].hooks[0].command;
      for (const shell of shells) {
        const result = invoke(command, f.env, shell);
        assert.equal(result.status, 0, `${shell}: ${result.stderr}`);
        assert.ok(result.stderr.includes(`HOOK_STARTED:${script}`), result.stderr);
      }
    }
    const approval = invoke(hooks.PreToolUse[0].hooks[0].command, f.env, shells[0], {
      tool_name: "mcp__supermemory__search_memory",
      tool_input: { query: "path test" },
    });
    assert.equal(approval.status, 0, approval.stderr);
    assert.equal(JSON.parse(approval.stdout).hookSpecificOutput.permissionDecision, "allow");
    f.cli("install");
    assert.deepEqual(f.hooks(), hooks);
    assert.match(f.cli("status"), /hooks\.json:\s+✓ registered/);
  });
}

test("Windows encoded-path commands load the installed bundles", { skip: process.platform === "win32" }, (t) => {
  const f = fixture(t, "home %PATH% !quoted! & ' \" 日本語", "win32");
  f.cli("install");
  for (const [event, script] of Object.entries(scripts)) {
    const command = f.hooks()[event][0].hooks[0].command;
    assert.match(command, /^node -e "require\(Buffer\.from\('[A-Za-z0-9+/=]+','base64'\)\.toString\('utf-8'\)\)"$/);
    const result = invoke(command, f.env, "/bin/sh");
    assert.equal(result.status, 0, result.stderr);
    assert.ok(result.stderr.includes(`HOOK_STARTED:${script}`), result.stderr);
  }
});

for (const uninstallFormat of ["legacy", "current", "mixed"]) {
  test(`status and uninstall recognize ${uninstallFormat} commands and preserve unrelated hooks`, (t) => {
    const f = fixture(t, "home's memory path");
    f.cli("install");
    const hooks = f.hooks();
    const unrelated = { type: "command", command: "echo unrelated", timeout: 7 };
    for (const [index, [event, script]] of Object.entries(scripts).entries()) {
      if (uninstallFormat === "legacy" || (uninstallFormat === "mixed" && index % 2 === 0)) {
        hooks[event][0].hooks[0].command = `node ${join(f.codexDir, "supermemory", script)}`;
      }
      hooks[event][0].hooks.push(unrelated);
      hooks[event].push({ matcher: "unrelated", hooks: [unrelated] });
    }
    hooks.CustomEvent = [{ matcher: "keep", hooks: [unrelated] }];
    const addRetired = (event, script) => {
      hooks[event][0].hooks.push({ type: "command", command: `node ${join(f.codexDir, "supermemory", script)}` });
    };
    addRetired("Stop", "capture.js");
    addRetired("UserPromptSubmit", "capture-turn.js");
    writeFileSync(f.hooksPath, JSON.stringify({ hooks }));
    assert.match(f.cli("status"), /hooks\.json:\s+✓ registered/);
    f.cli("uninstall");
    const remaining = f.hooks();
    for (const event of Object.keys(scripts)) {
      assert.deepEqual(remaining[event], [
        { ...hooks[event][0], hooks: [unrelated] },
        { matcher: "unrelated", hooks: [unrelated] },
      ]);
    }
    assert.deepEqual(remaining.CustomEvent, hooks.CustomEvent);
    assert.match(f.cli("status"), /hooks\.json:\s+✗ not registered/);
  });
}

test("reinstall migrates legacy commands in place without duplicates or unrelated changes", (t) => {
  const f = fixture(t, "home's memory path");
  const unrelated = { type: "command", command: "echo unrelated", timeout: 7 };
  const hooks = Object.fromEntries(Object.entries(scripts).map(([event, script]) => [event, [{
    matcher: event === "PreToolUse" ? "^mcp__supermemory__" : "",
    hooks: [{
      type: "command", command: `node ${join(f.codexDir, "supermemory", script)}`,
      timeout: 1, async: true, customField: "preserved",
    }, unrelated],
    customGroupField: "preserved",
  }]]));
  hooks.Stop[0].hooks.push({ type: "command", command: `node ${join(f.codexDir, "supermemory", "capture.js")}` });
  hooks.UserPromptSubmit[0].hooks.push({ type: "command", command: `node ${join(f.codexDir, "supermemory", "capture-turn.js")}` });
  writeFileSync(f.hooksPath, JSON.stringify({ hooks }));
  f.cli("install");
  const migrated = f.hooks();
  for (const [event, script] of Object.entries(scripts)) {
    assert.equal(migrated[event].length, 1);
    assert.equal(migrated[event][0].matcher, hooks[event][0].matcher);
    assert.equal(migrated[event][0].customGroupField, "preserved");
    assert.equal(migrated[event][0].hooks.length, 2);
    assert.equal(migrated[event][0].hooks[0].customField, "preserved");
    assert.equal(migrated[event][0].hooks[0].async, event === "Stop" ? true : undefined);
    assert.deepEqual(migrated[event][0].hooks[1], unrelated);
    const result = invoke(migrated[event][0].hooks[0].command, f.env, shells[0]);
    assert.equal(result.status, 0, result.stderr);
    assert.ok(result.stderr.includes(`HOOK_STARTED:${script}`), result.stderr);
  }
  assert.match(f.cli("status"), /hooks\.json:\s+✓ registered/);
  f.cli("install");
  assert.deepEqual(f.hooks(), migrated);
});
