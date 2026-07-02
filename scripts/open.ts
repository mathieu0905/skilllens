import { spawn } from "node:child_process";
import process from "node:process";

interface OpenOptions {
  port: number;
  capture?: string;
}

async function main() {
  const options = parseArgs(process.argv.slice(2));
  const baseUrl = `http://127.0.0.1:${options.port}`;
  const url = options.capture ? `${baseUrl}/?capture=${encodeURIComponent(options.capture)}` : baseUrl;

  if (!(await isUp(baseUrl))) {
    const child = spawn("npm", ["run", "dev", "--", "--port", String(options.port)], {
      cwd: process.cwd(),
      detached: true,
      stdio: "ignore"
    });
    child.unref();
    await waitForServer(baseUrl);
  }

  await openBrowser(url);
  console.log(`Opened ${url}`);
}

function parseArgs(args: string[]): OpenOptions {
  const options: OpenOptions = { port: 5173 };
  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index];
    const next = args[index + 1];
    if (arg === "--port") {
      options.port = Number.parseInt(next, 10) || options.port;
      index += 1;
    } else if (arg === "--capture") {
      options.capture = next;
      index += 1;
    }
  }
  return options;
}

async function waitForServer(baseUrl: string) {
  const started = Date.now();
  while (Date.now() - started < 15_000) {
    if (await isUp(baseUrl)) {
      return;
    }
    await new Promise((resolve) => setTimeout(resolve, 300));
  }
  throw new Error(`Timed out waiting for ${baseUrl}`);
}

async function isUp(baseUrl: string): Promise<boolean> {
  try {
    const response = await fetch(baseUrl, { method: "GET" });
    return response.ok;
  } catch {
    return false;
  }
}

async function openBrowser(url: string) {
  const command =
    process.platform === "darwin"
      ? "open"
      : process.platform === "win32"
        ? "cmd"
        : "xdg-open";
  const args = process.platform === "win32" ? ["/c", "start", "", url] : [url];
  const child = spawn(command, args, {
    detached: true,
    stdio: "ignore"
  });
  child.unref();
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
