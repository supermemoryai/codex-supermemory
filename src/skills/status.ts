import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { homedir } from "node:os";
import { CONFIG, getApiBaseUrl, getApiKeyValue, isConfigured } from "../config.js";
import { CREDENTIALS_FILE, loadCredentials } from "../services/auth.js";
import { SupermemoryClient } from "../services/client.js";
import { getTags } from "../services/tags.js";

const API_URL =
  getApiBaseUrl();
const CONFIG_FILE = join(homedir(), ".codex", "supermemory.json");

function maskKey(key: string | undefined): string {
  if (!key) return "not set";
  if (key.length <= 12) return `${key.slice(0, 4)}...`;
  return `${key.slice(0, 6)}...${key.slice(-4)}`;
}

function getConfiguredApiKeyFromFile(): string | undefined {
  try {
    if (!existsSync(CONFIG_FILE)) return undefined;
    const parsed = JSON.parse(readFileSync(CONFIG_FILE, "utf-8")) as { apiKey?: string };
    return parsed.apiKey;
  } catch {
    return undefined;
  }
}

function getKeySource(): string {
  if (process.env.SUPERMEMORY_CODEX_API_KEY) return "SUPERMEMORY_CODEX_API_KEY env var";
  if (getConfiguredApiKeyFromFile()) return "~/.codex/supermemory.json";
  if (loadCredentials()) return "~/.codex/supermemory/credentials.json";
  return "not configured";
}

function getDevTlsHint(): string | null {
  if (!API_URL.includes(".dev.supermemory.ai")) return null;
  if (process.env.NODE_EXTRA_CA_CERTS) return null;
  return "Dev API TLS: set NODE_EXTRA_CA_CERTS to your Portless CA before starting Codex.";
}

async function fetchJson(path: string): Promise<unknown | null> {
  const apiKey = getApiKeyValue();
  if (!apiKey) return null;

  try {
    const response = await fetch(`${API_URL}${path}`, {
      headers: {
        Authorization: `Bearer ${apiKey}`,
        "x-sm-source": "codex",
      },
    });
    if (!response.ok) return null;
    return await response.json();
  } catch {
    return null;
  }
}

function findAccountInfo(value: unknown): { email?: string; name?: string; userId?: string; orgName?: string } {
  const seen = new Set<unknown>();
  const stack = [value];
  const result: { email?: string; name?: string; userId?: string; orgName?: string } = {};

  while (stack.length > 0) {
    const item = stack.pop();
    if (!item || typeof item !== "object" || seen.has(item)) continue;
    seen.add(item);

    const record = item as Record<string, unknown>;
    for (const [key, raw] of Object.entries(record)) {
      const lower = key.toLowerCase();
      if (!result.email && lower === "email" && typeof raw === "string") result.email = raw;
      if (!result.name && lower === "name" && typeof raw === "string") result.name = raw;
      if (!result.userId && (lower === "userid" || lower === "user_id") && typeof raw === "string") result.userId = raw;
      if (!result.orgName && (lower === "organizationname" || lower === "orgname") && typeof raw === "string") result.orgName = raw;

      if (raw && typeof raw === "object") stack.push(raw);
    }
  }

  return result;
}

async function getAccountInfo(): Promise<{ email?: string; name?: string; userId?: string; orgName?: string }> {
  for (const path of ["/v3/auth/account/memberships", "/v3/account/memberships", "/v3/me"]) {
    const data = await fetchJson(path);
    const info = findAccountInfo(data);
    if (info.email || info.name || info.userId || info.orgName) return info;
  }
  return {};
}

async function main(): Promise<void> {
  const cwd = process.cwd();
  const tags = getTags(cwd);
  const apiKey = getApiKeyValue();
  const lines: string[] = [];

  lines.push("supermemory status");
  lines.push("");
  lines.push(`Connected: ${isConfigured() ? "checking..." : "no"}`);
  lines.push(`API key: ${maskKey(apiKey)} (${getKeySource()})`);
  lines.push(`API URL: ${API_URL}`);
  lines.push(`Memory scope: current project + user profile`);
  lines.push(`Recall mode: auto-recall on every prompt`);
  lines.push(`Capture cadence: ${CONFIG.autoSaveEveryTurns > 0 ? `every ${CONFIG.autoSaveEveryTurns} turn${CONFIG.autoSaveEveryTurns === 1 ? "" : "s"} + session end` : "session end only"}`);
  lines.push(`Project tag: ${tags.project}`);
  lines.push(`User tag: ${tags.user}`);

  if (!isConfigured()) {
    lines[2] = "Connected: no";
    lines.push("");
    lines.push("Run /supermemory-login to connect, or set SUPERMEMORY_CODEX_API_KEY.");
    console.log(lines.join("\n"));
    process.exit(0);
  }

  const client = new SupermemoryClient();
  const [profileResult, accountInfo] = await Promise.all([
    client.getProfile(tags.user),
    getAccountInfo(),
  ]);

  lines[2] = profileResult.success ? "Connected: yes" : "Connected: no";

  if (accountInfo.email || accountInfo.name || accountInfo.userId || accountInfo.orgName) {
    lines.push("");
    lines.push("Account:");
    if (accountInfo.email) lines.push(`Email: ${accountInfo.email}`);
    if (accountInfo.name) lines.push(`Name: ${accountInfo.name}`);
    if (accountInfo.userId) lines.push(`User ID: ${accountInfo.userId}`);
    if (accountInfo.orgName) lines.push(`Organization: ${accountInfo.orgName}`);
  } else {
    lines.push("");
    lines.push("Account: authenticated API key (account details unavailable from API key)");
  }

  if (!profileResult.success) {
    lines.push("");
    lines.push(`Connection check failed: ${profileResult.error}`);
    const devTlsHint = getDevTlsHint();
    if (devTlsHint) lines.push(devTlsHint);
  }

  console.log(lines.join("\n"));
}

main().catch((error) => {
  console.error(`Failed to get Supermemory status: ${error instanceof Error ? error.message : String(error)}`);
  process.exit(1);
});
