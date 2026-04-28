import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { existsSync, readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { homedir } from "node:os";
import { execFile } from "node:child_process";
import { randomBytes } from "node:crypto";

const SUPERMEMORY_DIR = join(homedir(), ".codex", "supermemory");
const CREDENTIALS_FILE = join(SUPERMEMORY_DIR, "credentials.json");

const AUTH_BASE_URL =
  process.env.SUPERMEMORY_AUTH_URL || "https://app.supermemory.ai/auth/connect";
const AUTH_PORT = 19877; // different from claude plugin's 19876
const AUTH_TIMEOUT = 25_000;

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

export function loadCredentials(): string | undefined {
  try {
    if (existsSync(CREDENTIALS_FILE)) {
      const data = JSON.parse(readFileSync(CREDENTIALS_FILE, "utf-8")) as {
        apiKey?: string;
      };
      if (data.apiKey) return data.apiKey;
    }
  } catch {}
  return undefined;
}

function saveCredentials(apiKey: string): void {
  mkdirSync(SUPERMEMORY_DIR, { recursive: true, mode: 0o700 });
  writeFileSync(
    CREDENTIALS_FILE,
    JSON.stringify({ apiKey, savedAt: new Date().toISOString() }, null, 2),
    { mode: 0o600 }
  );
}

function openBrowser(url: string): void {
  const onError = () => {};
  if (process.platform === "win32") {
    execFile("explorer.exe", [url], onError);
  } else if (process.platform === "darwin") {
    execFile("open", [url], onError);
  } else {
    execFile("xdg-open", [url], onError);
  }
}

export function startAuthFlow(): Promise<string> {
  return new Promise((resolve, reject) => {
    let resolved = false;
    const stateToken = randomBytes(16).toString("hex");

    const server = createServer((req: IncomingMessage, res: ServerResponse) => {
      const url = new URL(req.url || "/", `http://localhost:${AUTH_PORT}`);

      if (url.pathname === "/callback") {
        const callbackState = url.searchParams.get("state");
        if (callbackState !== stateToken) {
          res.writeHead(403, { "Content-Type": "text/html" });
          res.end(AUTH_ERROR_HTML);
          return;
        }

        const apiKey =
          url.searchParams.get("apikey") || url.searchParams.get("api_key");

        if (apiKey?.startsWith("sm_")) {
          saveCredentials(apiKey);
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

    server.listen(AUTH_PORT, "127.0.0.1", () => {
      const callbackUrl = `http://localhost:${AUTH_PORT}/callback`;
      const authUrl = `${AUTH_BASE_URL}?callback=${encodeURIComponent(callbackUrl)}&client=codex&state=${stateToken}`;
      openBrowser(authUrl);
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
