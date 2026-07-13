import { createHash } from "node:crypto";
import { execSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { hostname } from "node:os";
import { basename, dirname, join, resolve, sep } from "node:path";
import { CONFIG } from "../config.js";

function sha256(input: string): string {
  return createHash("sha256").update(input).digest("hex").slice(0, 16);
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
    if (basename(resolved) === ".git" && !resolved.includes(`${sep}.git${sep}`)) {
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

function getProjectBasePath(directory: string): string {
  return getGitRoot(directory) || resolve(directory);
}

function getGitEmail(directory: string): string | null {
  try {
    const email = execSync("git config user.email", {
      cwd: getProjectBasePath(directory),
      encoding: "utf-8",
      stdio: ["pipe", "pipe", "pipe"],
    }).trim();
    return email || null;
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
    const normalized = remoteUrl.replace(/\/+$/, "").replace(/\.git$/i, "");
    const separator = Math.max(normalized.lastIndexOf("/"), normalized.lastIndexOf(":"));
    return normalized.slice(separator + 1) || null;
  } catch {
    return null;
  }
}

function loadClaudeProjectConfig(directory: string): {
  personalContainerTag?: string;
  repoContainerTag?: string;
} | null {
  try {
    const configPath = join(
      getProjectBasePath(directory),
      ".claude",
      ".supermemory-claude",
      "config.json",
    );
    if (!existsSync(configPath)) return null;
    return JSON.parse(readFileSync(configPath, "utf-8")) as {
      personalContainerTag?: string;
      repoContainerTag?: string;
    };
  } catch {
    return null;
  }
}

export function sanitizeRepoName(name: string): string {
  const sanitized = name
    .toLowerCase()
    .replace(/[^a-z0-9]/g, "_")
    .replace(/_+/g, "_")
    .replace(/^_|_$/g, "");
  return sanitized.slice(0, 95).replace(/_+$/g, "") || "unknown";
}

export function getGeneratedPersonalTag(directory: string): string {
  return `user_project_${sha256(getProjectBasePath(directory))}`;
}

export function getPersonalTag(directory: string): string {
  return (
    loadClaudeProjectConfig(directory)?.personalContainerTag ||
    CONFIG.userContainerTag ||
    getGeneratedPersonalTag(directory)
  );
}

/** Backwards-compatible alias retained for callers that still say "user". */
export function getUserTag(directory = process.cwd()): string {
  return getPersonalTag(directory);
}

export function getGeneratedProjectTag(directory: string): string {
  const basePath = getProjectBasePath(directory);
  const repoName = getGitRepoName(basePath) || basename(basePath) || "unknown";
  return `repo_${sanitizeRepoName(repoName)}`;
}

export function getProjectTag(directory: string): string {
  return (
    loadClaudeProjectConfig(directory)?.repoContainerTag ||
    CONFIG.projectContainerTag ||
    getGeneratedProjectTag(directory)
  );
}

export function getProjectName(directory: string): string {
  const basePath = getProjectBasePath(directory);
  return getGitRepoName(basePath) || basename(basePath) || "unknown";
}

function getLegacyCodexUserTags(directory: string): string[] {
  const identity = getGitEmail(directory) || process.env.USER || process.env.USERNAME || hostname();
  return [
    CONFIG.userContainerTag,
    `${CONFIG.containerTagPrefix}_user_${sha256(identity)}`,
    `codex_user_${sha256(identity)}`,
  ].filter((tag): tag is string => !!tag);
}

function getLegacyCodexProjectTags(directory: string): string[] {
  const projectHash = sha256(getProjectBasePath(directory));
  return [
    CONFIG.projectContainerTag,
    `${CONFIG.containerTagPrefix}_project_${projectHash}`,
    `codex_project_${projectHash}`,
  ].filter((tag): tag is string => !!tag);
}

function uniqueTags(tags: string[]): string[] {
  return [...new Set(tags.filter((tag) => tag.trim().length > 0))];
}

export function getPersonalReadTags(directory: string): string[] {
  const projectHash = sha256(getProjectBasePath(directory));
  return uniqueTags([
    getPersonalTag(directory),
    getGeneratedPersonalTag(directory),
    `claudecode_project_${projectHash}`,
    ...getLegacyCodexUserTags(directory),
  ]);
}

export function getProjectReadTags(directory: string): string[] {
  return uniqueTags([
    getProjectTag(directory),
    getGeneratedProjectTag(directory),
    ...getLegacyCodexProjectTags(directory),
  ]);
}

export interface ResolvedTags {
  user: string;
  project: string;
  projectName: string;
  personalReads: string[];
  projectReads: string[];
}

export function getTags(directory: string): ResolvedTags {
  return {
    user: getPersonalTag(directory),
    project: getProjectTag(directory),
    projectName: getProjectName(directory),
    personalReads: getPersonalReadTags(directory),
    projectReads: getProjectReadTags(directory),
  };
}
