import { execFile } from "node:child_process";

function run(command: string, args: string[]): Promise<void> {
  return new Promise((resolve, reject) => {
    execFile(command, args, { windowsHide: true }, (error) => {
      if (error) reject(error);
      else resolve();
    });
  });
}

export async function openUrl(url: string | URL): Promise<void> {
  const href = url.toString();
  if (!/^https?:\/\//i.test(href)) {
    throw new Error("Refusing to open non-http URL");
  }

  if (process.platform === "win32") {
    try {
      await run("rundll32.exe", ["url.dll,FileProtocolHandler", href]);
      return;
    } catch {}

    await run("cmd.exe", ["/c", "start", '""', href]);
    return;
  }

  if (process.platform === "darwin") {
    await run("open", [href]);
    return;
  }

  await run("xdg-open", [href]);
}
