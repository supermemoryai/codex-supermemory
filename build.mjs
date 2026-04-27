import * as esbuild from "esbuild";
import { mkdirSync, writeFileSync, chmodSync, copyFileSync } from "node:fs";

const sharedConfig = {
  bundle: true,
  platform: "node",
  format: "cjs",
  target: "node18",
  minify: false,
  sourcemap: false,
};

const entries = [
  { in: "src/cli.ts", out: "dist/cli.js" },
  ...["recall", "capture"].map((n) => ({
    in: `src/hooks/${n}.ts`,
    out: `dist/hooks/${n}.js`,
  })),
  ...["search-memory", "save-memory", "forget-memory"].map((n) => ({
    in: `src/skills/${n}.ts`,
    out: `dist/skills/${n}.js`,
  })),
];

await Promise.all(
  entries.map((e) =>
    esbuild.build({
      ...sharedConfig,
      entryPoints: [e.in],
      outfile: e.out,
      banner: { js: "#!/usr/bin/env node" },
    })
  )
);

// Copy SKILL.md files to dist
for (const skillName of ["super-search", "super-save", "forget"]) {
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
for (const e of entries) {
  try {
    chmodSync(e.out, 0o755);
  } catch {
    // ignore
  }
}

console.log("Build complete!");
