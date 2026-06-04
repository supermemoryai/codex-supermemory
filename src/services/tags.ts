import { createHash } from "node:crypto";
import { execSync } from "node:child_process";
import { hostname } from "node:os";
import { basename, dirname, resolve, sep } from "node:path";
import { CONFIG } from "../config.js";

function sha256(input: string): string {
  return createHash("sha256").update(input).digest("hex").slice(0, 16);
}

function getGitEmail(): string | null {
  try {
    const email = execSync("git config user.email", {
      encoding: "utf-8",
      stdio: ["pipe", "pipe", "pipe"],
    }).trim();
    return email || null;
  } catch {
    return null;
  }
}

function getGitRoot(directory: string): string | null {
  const isolateWorktrees = process.env.SUPERMEMORY_ISOLATE_WORKTREES === "true";

  try {
    if (isolateWorktrees) {
      const gitRoot = execSync("git rev-parse --show-toplevel", {
        cwd: directory,
        encoding: "utf-8",
        stdio: ["pipe", "pipe", "pipe"],
      }).trim();
      return gitRoot || null;
    }

    const gitCommonDir = execSync("git rev-parse --git-common-dir", {
      cwd: directory,
      encoding: "utf-8",
      stdio: ["pipe", "pipe", "pipe"],
    }).trim();

    if (gitCommonDir === ".git") {
      const gitRoot = execSync("git rev-parse --show-toplevel", {
        cwd: directory,
        encoding: "utf-8",
        stdio: ["pipe", "pipe", "pipe"],
      }).trim();
      return gitRoot || null;
    }

    const resolved = resolve(directory, gitCommonDir);

    if (
      basename(resolved) === ".git" &&
      !resolved.includes(`${sep}.git${sep}`)
    ) {
      return dirname(resolved);
    }

    const gitRoot = execSync("git rev-parse --show-toplevel", {
      cwd: directory,
      encoding: "utf-8",
      stdio: ["pipe", "pipe", "pipe"],
    }).trim();
    return gitRoot || null;
  } catch {
    return null;
  }
}

function getGitRepoName(directory: string): string | null {
  try {
    const remoteUrl = execSync("git remote get-url origin", {
      cwd: directory,
      encoding: "utf-8",
      stdio: ["pipe", "pipe", "pipe"],
    }).trim();
    const match = remoteUrl.match(/[/:]([^/]+?)(?:\.git)?$/);
    return match ? match[1] : null;
  } catch {
    return null;
  }
}

export function getUserTag(): string {
  if (CONFIG.userContainerTag) return CONFIG.userContainerTag;
  const email = getGitEmail();
  if (email) return `${CONFIG.containerTagPrefix}_user_${sha256(email)}`;
  const fallback = process.env.USER || process.env.USERNAME || hostname();
  return `${CONFIG.containerTagPrefix}_user_${sha256(fallback)}`;
}

export function getProjectTag(directory: string): string {
  if (CONFIG.projectContainerTag) return CONFIG.projectContainerTag;
  const basePath = getGitRoot(directory) || directory;
  return `${CONFIG.containerTagPrefix}_project_${sha256(basePath)}`;
}

export function getProjectName(directory: string): string {
  const gitRoot = getGitRoot(directory);
  const basePath = gitRoot || directory;
  return getGitRepoName(basePath) || basename(basePath) || "unknown";
}

export function getTags(directory: string): { user: string; project: string } {
  return {
    user: getUserTag(),
    project: getProjectTag(directory),
  };
}
