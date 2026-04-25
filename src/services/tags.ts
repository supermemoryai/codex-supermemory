import { createHash } from "node:crypto";
import { execSync } from "node:child_process";
import { hostname } from "node:os";
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

export function getUserTag(): string {
  if (CONFIG.userContainerTag) return CONFIG.userContainerTag;
  const email = getGitEmail();
  if (email) return `${CONFIG.containerTagPrefix}_user_${sha256(email)}`;
  const fallback = process.env.USER || process.env.USERNAME || hostname();
  return `${CONFIG.containerTagPrefix}_user_${sha256(fallback)}`;
}

export function getProjectTag(directory: string): string {
  if (CONFIG.projectContainerTag) return CONFIG.projectContainerTag;
  return `${CONFIG.containerTagPrefix}_project_${sha256(directory)}`;
}

export function getTags(directory: string): { user: string; project: string } {
  return {
    user: getUserTag(),
    project: getProjectTag(directory),
  };
}
