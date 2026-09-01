import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { homedir } from "node:os";
import { CONFIG, getApiBaseUrl, getApiKeyValue, isConfigured } from "../config.js";
import { loadCredentials } from "../services/auth.js";
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

function getAutoRecallStatus(): string {
  if (CONFIG.recallMode === "direct") return "direct (substantive prompts)";
  return CONFIG.recallMode;
}

async function fetchJson(path: string): Promise<unknown | null> {
  const apiKey = getApiKeyValue();
  if (!apiKey) return null;

  try {
    const response = await fetch(`${API_URL.replace(/\/+$/, "")}${path}`, {
      headers: {
        Authorization: `Bearer ${apiKey}`,
        "x-sm-source": "codex",
      },
      signal: AbortSignal.timeout(8_000),
    });
    if (!response.ok) return null;
    return await response.json();
  } catch {
    return null;
  }
}

async function getAccountInfo(): Promise<{ email?: string; name?: string; userId?: string; orgName?: string }> {
  const data = await fetchJson("/v3/session");
  if (!data || typeof data !== "object") return {};

  const session = data as {
    user?: { email?: unknown; name?: unknown; id?: unknown };
    org?: { name?: unknown };
  };
  return {
    email: typeof session.user?.email === "string" ? session.user.email : undefined,
    name: typeof session.user?.name === "string" ? session.user.name : undefined,
    userId: typeof session.user?.id === "string" ? session.user.id : undefined,
    orgName: typeof session.org?.name === "string" ? session.org.name : undefined,
  };
}

async function probeApi(containerTag: string): Promise<{
  ok: boolean;
  status?: number;
  detail: string;
}> {
  const apiKey = getApiKeyValue();
  if (!apiKey) return { ok: false, detail: "not checked (missing API key)" };

  try {
    const response = await fetch(`${API_URL.replace(/\/+$/, "")}/v4/profile`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${apiKey}`,
        "Content-Type": "application/json",
        "x-sm-source": "codex",
      },
      body: JSON.stringify({ containerTag, q: "connectivity probe" }),
      signal: AbortSignal.timeout(8_000),
    });
    if (response.status === 200) {
      return { ok: true, status: 200, detail: "reachable, key valid" };
    }
    if (response.status === 401 || response.status === 403) {
      return { ok: false, status: response.status, detail: "reachable, key invalid or revoked" };
    }
    return { ok: false, status: response.status, detail: "API returned an error" };
  } catch (error) {
    return {
      ok: false,
      detail: error instanceof Error ? error.message : String(error),
    };
  }
}

async function main(): Promise<void> {
  const cwd = process.cwd();
  const tags = getTags(cwd);
  const apiKey = getApiKeyValue();
  const lines: string[] = [];

  lines.push("supermemory status");
  lines.push("");
  lines.push(`Authenticated: ${isConfigured() ? "yes" : "no"}`);
  lines.push(`Connected: ${isConfigured() ? "checking..." : "no"}`);
  lines.push(`API key: ${maskKey(apiKey)} (${getKeySource()})`);
  lines.push(`API URL: ${API_URL}`);
  lines.push(`Memory scope: one project container with metadata scopes`);
  lines.push(`Auto-recall: ${getAutoRecallStatus()}`);
  lines.push("Auto-capture: after completed turns");
  lines.push(`Project container: ${tags.canonical}`);
  lines.push(`Reads (including legacy): ${tags.allReads.join(", ")}`);

  if (!isConfigured()) {
    lines[2] = "Connected: no";
    lines.push("");
    lines.push("Start a new Codex task to connect automatically, or set SUPERMEMORY_CODEX_API_KEY.");
    console.log(lines.join("\n"));
    process.exit(0);
  }

  const [probe, accountInfo] = await Promise.all([
    probeApi(tags.canonical),
    getAccountInfo(),
  ]);

  lines[3] = probe.ok ? "Connected: yes" : "Connected: no";
  lines.push(`API reachability: ${probe.status ? `${probe.status} — ` : ""}${probe.detail}`);

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

  if (!probe.ok) {
    lines.push("");
    lines.push(`Connection check failed: ${probe.detail}`);
    const devTlsHint = getDevTlsHint();
    if (devTlsHint) lines.push(devTlsHint);
  }

  console.log(lines.join("\n"));
}

main().catch((error) => {
  console.error(`Failed to get Supermemory status: ${error instanceof Error ? error.message : String(error)}`);
  process.exit(1);
});
