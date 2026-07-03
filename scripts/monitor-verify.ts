import { spawn, type ChildProcess } from "node:child_process";
import net from "node:net";
import path from "node:path";

const root = process.cwd();
const includeDocker = process.argv.includes("--docker");

async function main() {
  const port = await freePort();
  const baseUrl = `http://127.0.0.1:${port}`;
  const server = spawn(process.execPath, [path.join(root, "node_modules", "vite", "bin", "vite.js"), "--host", "127.0.0.1", "--port", String(port), "--strictPort"], {
    cwd: root,
    env: process.env,
    stdio: ["ignore", "pipe", "pipe"]
  });
  const serverLog: string[] = [];
  server.stdout?.on("data", (chunk) => serverLog.push(String(chunk)));
  server.stderr?.on("data", (chunk) => serverLog.push(String(chunk)));

  try {
    await waitForServer(baseUrl, server, serverLog);
    const smoke = await runCommand(
      "npm",
      ["run", includeDocker ? "monitor:smoke:docker" : "monitor:smoke"],
      { ...process.env, SKILLSCOPE_URL: baseUrl }
    );
    const evidencePath = parseEvidencePath(smoke.stdout);
    await runCommand(
      "npm",
      ["run", includeDocker ? "monitor:evidence:check:docker" : "monitor:evidence:check", "--", evidencePath],
      process.env
    );
    console.log(`monitor verify passed: ${includeDocker ? "docker" : "core"}`);
    console.log(`url: ${baseUrl}`);
    console.log(`evidence: ${evidencePath}`);
    console.log(`report: ${evidencePath.replace(/evidence\.json$/, "evidence.md")}`);
  } finally {
    await stopServer(server);
  }
}

function runCommand(command: string, args: string[], env: NodeJS.ProcessEnv): Promise<{ stdout: string; stderr: string }> {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, {
      cwd: root,
      env,
      stdio: ["ignore", "pipe", "pipe"],
      shell: process.platform === "win32"
    });
    let stdout = "";
    let stderr = "";
    child.stdout?.on("data", (chunk) => {
      const text = String(chunk);
      stdout += text;
      process.stdout.write(text);
    });
    child.stderr?.on("data", (chunk) => {
      const text = String(chunk);
      stderr += text;
      process.stderr.write(text);
    });
    child.on("error", reject);
    child.on("close", (code) => {
      code === 0 ? resolve({ stdout, stderr }) : reject(new Error(`${command} ${args.join(" ")} failed with ${code}`));
    });
  });
}

async function waitForServer(baseUrl: string, server: ChildProcess, serverLog: string[]) {
  const deadline = Date.now() + 20000;
  while (Date.now() < deadline) {
    if (server.exitCode !== null) {
      throw new Error(`Vite exited early with ${server.exitCode}\n${serverLog.join("")}`);
    }
    const response = await fetch(`${baseUrl}/api/agent-jobs`).catch(() => null);
    if (response?.ok) {
      return;
    }
    await sleep(300);
  }
  throw new Error(`timed out waiting for Vite at ${baseUrl}\n${serverLog.join("")}`);
}

function parseEvidencePath(stdout: string): string {
  const match = stdout.match(/^evidence:\s*(.+)$/m);
  if (!match) {
    throw new Error("monitor smoke did not print an evidence path");
  }
  return match[1].trim();
}

function freePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const server = net.createServer();
    server.on("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      const port = typeof address === "object" && address ? address.port : 0;
      server.close(() => resolve(port));
    });
  });
}

async function stopServer(server: ChildProcess) {
  if (server.exitCode !== null) {
    return;
  }
  server.kill("SIGTERM");
  const deadline = Date.now() + 5000;
  while (Date.now() < deadline && server.exitCode === null) {
    await sleep(100);
  }
  if (server.exitCode === null) {
    server.kill("SIGKILL");
  }
}

function sleep(ms: number) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : error);
  process.exit(1);
});

