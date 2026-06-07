import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { existsSync, readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { homedir, hostname, platform, arch } from "node:os";
import { randomBytes } from "node:crypto";
import type { AddressInfo } from "node:net";
import { openUrl } from "./openUrl.js";

const SUPERMEMORY_DIR = join(homedir(), ".codex", "supermemory");
const CREDENTIALS_FILE = join(SUPERMEMORY_DIR, "credentials.json");
export interface Credentials {
  apiKey?: string;
  apiBaseUrl?: string;
  savedAt?: string;
}

const AUTH_BASE_URL =
  process.env.SUPERMEMORY_AUTH_URL || "https://app.supermemory.ai/auth/agent-connect";
const AUTH_TIMEOUT = Number(process.env.SUPERMEMORY_AUTH_TIMEOUT) || 5 * 60_000;

const AUTH_SUCCESS_HTML = `<!DOCTYPE html>
<html><head><title>Connected - Supermemory</title><style>
*{margin:0;padding:0;box-sizing:border-box}
body{font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,sans-serif;display:flex;flex-direction:column;justify-content:center;align-items:center;min-height:100vh;background:#faf9f6}
.dot{width:10px;height:10px;background:#22c55e;border-radius:50%;display:inline-block;margin-right:8px}
h1{font-size:32px;font-weight:500;color:#1a1a1a;margin:16px 0}
p{color:#666;font-size:16px}
</style></head><body>
<div><span class="dot"></span><span style="color:#22c55e;font-size:14px">Connected</span></div>
<h1>Supermemory is ready</h1>
<p>You can close this tab and return to Codex.</p>
</body></html>`;

const AUTH_ERROR_HTML = `<!DOCTYPE html>
<html><head><title>Error - Supermemory</title><style>
*{margin:0;padding:0;box-sizing:border-box}
body{font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,sans-serif;display:flex;flex-direction:column;justify-content:center;align-items:center;min-height:100vh;background:#faf9f6}
.dot{width:10px;height:10px;background:#ef4444;border-radius:50%;display:inline-block;margin-right:8px}
h1{font-size:32px;font-weight:500;color:#1a1a1a;margin:16px 0}
p{color:#666;font-size:16px}
</style></head><body>
<div><span class="dot"></span><span style="color:#ef4444;font-size:14px">Error</span></div>
<h1>Connection Failed</h1>
<p>Invalid API key received. Please try again.</p>
</body></html>`;

export function loadCredentialData(): Credentials | null {
  try {
    if (existsSync(CREDENTIALS_FILE)) {
      return JSON.parse(readFileSync(CREDENTIALS_FILE, "utf-8")) as Credentials;
    }
  } catch {}
  return null;
}

export function loadCredentials(): string | undefined {
  const data = loadCredentialData();
  if (data?.apiKey) return data.apiKey;
  return undefined;
}

function normalizeApiBaseUrl(apiBaseUrl: string | null | undefined): string | undefined {
  if (!apiBaseUrl) return undefined;
  try {
    const url = new URL(apiBaseUrl);
    if (url.protocol !== "https:" && url.protocol !== "http:") return undefined;
    url.pathname = url.pathname.replace(/\/+$/, "");
    url.search = "";
    url.hash = "";
    return url.toString().replace(/\/$/, "");
  } catch {
    return undefined;
  }
}

function saveCredentials(apiKey: string, apiBaseUrl?: string): void {
  mkdirSync(SUPERMEMORY_DIR, { recursive: true, mode: 0o700 });
  const credentials: Credentials = { apiKey, savedAt: new Date().toISOString() };
  const normalizedApiBaseUrl = normalizeApiBaseUrl(apiBaseUrl);
  if (normalizedApiBaseUrl) credentials.apiBaseUrl = normalizedApiBaseUrl;
  writeFileSync(
    CREDENTIALS_FILE,
    JSON.stringify(credentials, null, 2),
    { mode: 0o600 }
  );
}

export function startAuthFlow(): Promise<string> {
  return new Promise((resolve, reject) => {
    let resolved = false;
    const stateToken = randomBytes(16).toString("hex");

    const server = createServer((req: IncomingMessage, res: ServerResponse) => {
      const url = new URL(req.url || "/", "http://localhost");

      if (url.pathname === "/callback") {
        const callbackState = url.searchParams.get("state");
        if (callbackState !== stateToken) {
          res.writeHead(403, { "Content-Type": "text/html" });
          res.end(AUTH_ERROR_HTML);
          return;
        }

        const apiKey =
          url.searchParams.get("apikey") || url.searchParams.get("api_key");
        const apiBaseUrl =
          url.searchParams.get("api_url") || url.searchParams.get("api_base_url");

        if (apiKey?.startsWith("sm_")) {
          saveCredentials(apiKey, apiBaseUrl ?? undefined);
          res.writeHead(200, { "Content-Type": "text/html" });
          res.end(AUTH_SUCCESS_HTML);
          resolved = true;
          clearTimeout(timer);
          server.close();
          resolve(apiKey);
        } else {
          res.writeHead(400, { "Content-Type": "text/html" });
          res.end(AUTH_ERROR_HTML);
        }
      } else {
        res.writeHead(404);
        res.end("Not found");
      }
    });

    // Listen on an ephemeral port to avoid conflicts; embed the state token in
    // the callback URL so the console redirects it back through the redirect.
    server.listen(0, "127.0.0.1", () => {
      const { port } = server.address() as AddressInfo;
      const callbackUrl = `http://127.0.0.1:${port}/callback?state=${stateToken}`;
      const params = new URLSearchParams({
        callback: callbackUrl,
        client: "codex",
        hostname: `codex - ${hostname()}`,
        os: `${platform()}-${arch()}`,
        cwd: process.cwd(),
        cli_version: "1.0.0",
      });
      const authUrl = `${AUTH_BASE_URL}?${params.toString()}`;
      openUrl(authUrl).catch((error) => {
        if (!resolved) {
          clearTimeout(timer);
          server.close();
          reject(new Error(`Failed to open browser: ${error.message}`));
        }
      });
    });

    server.on("error", (err) => {
      if (!resolved) {
        clearTimeout(timer);
        reject(new Error(`Failed to start auth server: ${err.message}`));
      }
    });

    const timer = setTimeout(() => {
      if (!resolved) {
        server.close();
        reject(new Error("AUTH_TIMEOUT"));
      }
    }, AUTH_TIMEOUT);
  });
}

export { AUTH_BASE_URL, CREDENTIALS_FILE };
