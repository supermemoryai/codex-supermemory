import * as esbuild from "esbuild";
import { mkdirSync, writeFileSync, chmodSync } from "node:fs";

const sharedConfig = {
  bundle: true,
  platform: "node",
  format: "cjs",
  target: "node18",
  minify: false,
  sourcemap: false,
};

await Promise.all([
  esbuild.build({
    ...sharedConfig,
    entryPoints: ["src/cli.ts"],
    outfile: "dist/cli.js",
    banner: { js: "#!/usr/bin/env node" },
  }),
  esbuild.build({
    ...sharedConfig,
    entryPoints: ["src/hooks/recall.ts"],
    outfile: "dist/hooks/recall.js",
    banner: { js: "#!/usr/bin/env node" },
  }),
  esbuild.build({
    ...sharedConfig,
    entryPoints: ["src/hooks/capture.ts"],
    outfile: "dist/hooks/capture.js",
    banner: { js: "#!/usr/bin/env node" },
  }),
]);

// The root package.json declares `"type": "module"`, but esbuild emits CommonJS.
// Drop a CJS marker into dist/ so Node loads the bundles correctly.
mkdirSync("dist", { recursive: true });
writeFileSync("dist/package.json", JSON.stringify({ type: "commonjs" }, null, 2));

// Make the executables actually executable.
for (const file of ["dist/cli.js", "dist/hooks/recall.js", "dist/hooks/capture.js"]) {
  try {
    chmodSync(file, 0o755);
  } catch {
    // ignore
  }
}

console.log("Build complete!");
