import * as esbuild from "esbuild";
import { mkdirSync, writeFileSync, chmodSync, copyFileSync, rmSync } from "node:fs";

const sharedConfig = {
  bundle: true,
  platform: "node",
  format: "cjs",
  target: "node18",
  minify: false,
  sourcemap: false,
};

const executableEntries = [
  { in: "src/cli.ts", out: "dist/cli.js" },
  ...["recall", "flush", "session-start"].map((n) => ({
    in: `src/hooks/${n}.ts`,
    out: `dist/hooks/${n}.js`,
  })),
  ...["search-memory", "save-memory", "forget-memory", "profile-memory", "status", "login", "logout"].map((n) => ({
    in: `src/skills/${n}.ts`,
    out: `dist/skills/${n}.js`,
  })),
];

rmSync("dist", { recursive: true, force: true });

const libraryEntries = [
  { in: "src/services/session.ts", out: "dist/services/session.js" },
  { in: "src/services/tags.ts", out: "dist/services/tags.js" },
];

await Promise.all(
  [
    ...executableEntries.map((e) =>
      esbuild.build({
        ...sharedConfig,
        entryPoints: [e.in],
        outfile: e.out,
        banner: { js: "#!/usr/bin/env node" },
      })
    ),
    ...libraryEntries.map((e) =>
      esbuild.build({
        ...sharedConfig,
        entryPoints: [e.in],
        outfile: e.out,
      })
    ),
  ]
);

// Copy SKILL.md files to dist
for (const skillName of ["supermemory-search", "supermemory-save", "supermemory-forget", "supermemory-profile", "supermemory-status", "supermemory-login", "supermemory-logout"]) {
  mkdirSync(`dist/skills/${skillName}`, { recursive: true });
  copyFileSync(
    `src/skills/${skillName}/SKILL.md`,
    `dist/skills/${skillName}/SKILL.md`
  );
}

// The root package.json declares `"type": "module"`, but esbuild emits CommonJS.
// Drop a CJS marker into dist/ so Node loads the bundles correctly.
mkdirSync("dist", { recursive: true });
writeFileSync("dist/package.json", JSON.stringify({ type: "commonjs" }, null, 2));

// Make the executables actually executable.
for (const e of executableEntries) {
  try {
    chmodSync(e.out, 0o755);
  } catch {
    // ignore
  }
}

console.log("Build complete!");
