import * as esbuild from "esbuild";
import { mkdirSync, writeFileSync, chmodSync, copyFileSync, readFileSync, rmSync } from "node:fs";
import { deflateSync } from "node:zlib";

const packageJson = JSON.parse(
  readFileSync(new URL("./package.json", import.meta.url), "utf-8")
);
if (typeof packageJson.version !== "string" || !packageJson.version) {
  throw new Error("package.json must contain a version");
}

const sharedConfig = {
  bundle: true,
  platform: "node",
  format: "cjs",
  target: "node18",
  minify: false,
  sourcemap: false,
  // Embed the package version because installed hook bundles are copied out of
  // the package directory and cannot read package.json at runtime.
  define: {
    __CODEX_SUPERMEMORY_VERSION__: JSON.stringify(packageJson.version),
  },
};

const executableEntries = [
  { in: "src/cli.ts", out: "dist/cli.js" },
  ...["recall", "recall-approve", "mcp-proxy", "flush", "session-start"].map((n) => ({
    in: `src/hooks/${n}.ts`,
    out: `dist/hooks/${n}.js`,
  })),
  ...["status"].map((n) => ({
    in: `src/skills/${n}.ts`,
    out: `dist/skills/${n}.js`,
  })),
];

rmSync("dist", { recursive: true, force: true });

const libraryEntries = [
  { in: "src/services/session.ts", out: "dist/services/session.js" },
  { in: "src/services/tags.ts", out: "dist/services/tags.js" },
  { in: "src/services/resultMerge.ts", out: "dist/services/resultMerge.js" },
  { in: "src/services/resultText.ts", out: "dist/services/resultText.js" },
  { in: "src/services/factCache.ts", out: "dist/services/factCache.js" },
  { in: "src/services/recallPolicy.ts", out: "dist/services/recallPolicy.js" },
  { in: "src/services/hookRecallClient.ts", out: "dist/services/hookRecallClient.js" },
  { in: "src/services/client.ts", out: "dist/services/client.js" },
  { in: "src/services/capture.ts", out: "dist/services/capture.js" },
  { in: "src/services/context.ts", out: "dist/services/context.js" },
  { in: "src/services/tracker.ts", out: "dist/services/tracker.js" },
  { in: "src/services/transcript.ts", out: "dist/services/transcript.js" },
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
for (const skillName of ["supermemory-status"]) {
  mkdirSync(`dist/skills/${skillName}`, { recursive: true });
  copyFileSync(
    `src/skills/${skillName}/SKILL.md`,
    `dist/skills/${skillName}/SKILL.md`
  );
}

// Codex custom TUI pets use a fixed 8x9 spritesheet. Keep Supermemory as a
// quiet badge, but use the standard animation rows to reflect Codex activity.
const PET_FRAME_WIDTH = 192;
const PET_FRAME_HEIGHT = 208;
const PET_COLUMNS = 8;
const PET_ROWS = 9;

const PET_ROW_STYLES = [
  { state: "ACTIVE", accent: [139, 124, 255, 255], frames: 6 },
  { state: "RUNNING", accent: [59, 130, 246, 255], frames: 8 },
  { state: "RUNNING", accent: [59, 130, 246, 255], frames: 8 },
  { state: "READY", accent: [34, 197, 94, 255], frames: 4 },
  { state: "READY", accent: [34, 197, 94, 255], frames: 5 },
  { state: "BLOCKED", accent: [239, 68, 68, 255], frames: 8 },
  { state: "NEEDS INPUT", accent: [245, 158, 11, 255], frames: 6 },
  { state: "RUNNING", accent: [59, 130, 246, 255], frames: 6 },
  { state: "READY", accent: [34, 197, 94, 255], frames: 6 },
];

const PET_PULSE = [0.72, 0.84, 1, 0.9, 0.78, 0.9, 1, 0.84];

const PET_FONT = {
  A: ["01110", "10001", "10001", "11111", "10001", "10001", "10001"],
  B: ["11110", "10001", "10001", "11110", "10001", "10001", "11110"],
  C: ["01111", "10000", "10000", "10000", "10000", "10000", "01111"],
  D: ["11110", "10001", "10001", "10001", "10001", "10001", "11110"],
  E: ["11111", "10000", "10000", "11110", "10000", "10000", "11111"],
  G: ["01111", "10000", "10000", "10111", "10001", "10001", "01111"],
  I: ["11111", "00100", "00100", "00100", "00100", "00100", "11111"],
  K: ["10001", "10010", "10100", "11000", "10100", "10010", "10001"],
  L: ["10000", "10000", "10000", "10000", "10000", "10000", "11111"],
  M: ["10001", "11011", "10101", "10101", "10001", "10001", "10001"],
  N: ["10001", "11001", "11001", "10101", "10011", "10011", "10001"],
  O: ["01110", "10001", "10001", "10001", "10001", "10001", "01110"],
  P: ["11110", "10001", "10001", "11110", "10000", "10000", "10000"],
  R: ["11110", "10001", "10001", "11110", "10100", "10010", "10001"],
  S: ["01111", "10000", "10000", "01110", "00001", "00001", "11110"],
  T: ["11111", "00100", "00100", "00100", "00100", "00100", "00100"],
  U: ["10001", "10001", "10001", "10001", "10001", "10001", "01110"],
  V: ["10001", "10001", "10001", "10001", "10001", "01010", "00100"],
  Y: ["10001", "10001", "01010", "00100", "00100", "00100", "00100"],
};

function crc32(buffer) {
  let crc = 0xffffffff;
  for (const byte of buffer) {
    crc ^= byte;
    for (let bit = 0; bit < 8; bit += 1) {
      crc = (crc >>> 1) ^ (crc & 1 ? 0xedb88320 : 0);
    }
  }
  return (crc ^ 0xffffffff) >>> 0;
}

function pngChunk(type, data) {
  const typeBuffer = Buffer.from(type, "ascii");
  const length = Buffer.alloc(4);
  length.writeUInt32BE(data.length);
  const checksum = Buffer.alloc(4);
  checksum.writeUInt32BE(crc32(Buffer.concat([typeBuffer, data])));
  return Buffer.concat([length, typeBuffer, data, checksum]);
}

function setPixel(pixels, width, x, y, color) {
  if (x < 0 || y < 0 || x >= width || y >= PET_FRAME_HEIGHT * PET_ROWS) return;
  const offset = (y * width + x) * 4;
  pixels[offset] = color[0];
  pixels[offset + 1] = color[1];
  pixels[offset + 2] = color[2];
  pixels[offset + 3] = color[3];
}

function fillRect(pixels, width, x, y, rectWidth, rectHeight, color) {
  for (let py = y; py < y + rectHeight; py += 1) {
    for (let px = x; px < x + rectWidth; px += 1) {
      setPixel(pixels, width, px, py, color);
    }
  }
}

function fillRoundedRect(pixels, width, x, y, rectWidth, rectHeight, radius, color) {
  const right = x + rectWidth - 1;
  const bottom = y + rectHeight - 1;
  for (let py = y; py <= bottom; py += 1) {
    for (let px = x; px <= right; px += 1) {
      const nearestX = Math.max(x + radius, Math.min(px, right - radius));
      const nearestY = Math.max(y + radius, Math.min(py, bottom - radius));
      const dx = px - nearestX;
      const dy = py - nearestY;
      if (dx * dx + dy * dy <= radius * radius) {
        setPixel(pixels, width, px, py, color);
      }
    }
  }
}

function drawText(pixels, width, text, x, y, scale, color) {
  let cursorX = x;
  for (const character of text) {
    if (character === " ") {
      cursorX += 4 * scale;
      continue;
    }
    const glyph = PET_FONT[character];
    if (!glyph) continue;
    glyph.forEach((row, rowIndex) => {
      [...row].forEach((value, columnIndex) => {
        if (value === "1") {
          fillRect(
            pixels,
            width,
            cursorX + columnIndex * scale,
            y + rowIndex * scale,
            scale,
            scale,
            color,
          );
        }
      });
    });
    cursorX += 6 * scale;
  }
}

function pulseColor(color, column) {
  const factor = PET_PULSE[column % PET_PULSE.length];
  return color.map((channel, index) => index === 3 ? channel : Math.round(channel * factor));
}

function drawPetFrame(pixels, sheetWidth, frameX, frameY, row, column) {
  const style = PET_ROW_STYLES[row];
  if (!style || column >= style.frames) return;

  const accent = pulseColor(style.accent, column);
  const badgeX = frameX + 6;
  const badgeY = frameY + 156;
  fillRoundedRect(pixels, sheetWidth, badgeX, badgeY, 180, 44, 10, [24, 24, 27, 235]);
  fillRoundedRect(pixels, sheetWidth, badgeX + 10, badgeY + 13, 18, 18, 3, accent);

  // A tiny diagonal cut inside the square echoes the mark used by hook notices.
  for (let row = 0; row < 12; row += 1) {
    for (let column = row; column < 12; column += 1) {
      setPixel(
        pixels,
        sheetWidth,
        badgeX + 13 + column,
        badgeY + 16 + row,
        [242, 240, 255, 255],
      );
    }
  }

  drawText(
    pixels,
    sheetWidth,
    "SUPERMEMORY",
    badgeX + 36,
    badgeY + 7,
    2,
    [226, 222, 255, 255],
  );

  drawText(
    pixels,
    sheetWidth,
    style.state,
    badgeX + 36,
    badgeY + 27,
    1,
    accent,
  );
}

function writePetSpritesheet(outputPath) {
  const width = PET_FRAME_WIDTH * PET_COLUMNS;
  const height = PET_FRAME_HEIGHT * PET_ROWS;
  const pixels = Buffer.alloc(width * height * 4);

  for (let row = 0; row < PET_ROWS; row += 1) {
    for (let column = 0; column < PET_COLUMNS; column += 1) {
      drawPetFrame(
        pixels,
        width,
        column * PET_FRAME_WIDTH,
        row * PET_FRAME_HEIGHT,
        row,
        column,
      );
    }
  }

  const scanlines = Buffer.alloc((width * 4 + 1) * height);
  for (let y = 0; y < height; y += 1) {
    const rowOffset = y * (width * 4 + 1);
    scanlines[rowOffset] = 0;
    pixels.copy(scanlines, rowOffset + 1, y * width * 4, (y + 1) * width * 4);
  }

  const header = Buffer.alloc(13);
  header.writeUInt32BE(width, 0);
  header.writeUInt32BE(height, 4);
  header[8] = 8;
  header[9] = 6;
  const png = Buffer.concat([
    Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]),
    pngChunk("IHDR", header),
    pngChunk("IDAT", deflateSync(scanlines, { level: 9 })),
    pngChunk("IEND", Buffer.alloc(0)),
  ]);
  writeFileSync(outputPath, png);
}

mkdirSync("dist/pet", { recursive: true });
copyFileSync("src/pet/pet.json", "dist/pet/pet.json");
writePetSpritesheet("dist/pet/spritesheet.png");

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
