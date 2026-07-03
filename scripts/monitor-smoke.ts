import { spawn, type ChildProcess } from "node:child_process";
import { randomBytes } from "node:crypto";
import { chmod, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import http from "node:http";
import net from "node:net";
import path from "node:path";

interface AgentProcessEvent {
  id: string;
  command: string;
  args: string[];
  pid?: number;
  pgid?: number;
  agentRootPid?: number;
  agentRootLabel?: string;
  artifactPaths?: Array<{ label: string; path: string; size?: number; mtime?: string }>;
  dockerContainers?: string[];
  canStop?: boolean;
}

interface MonitorPayload {
  processes: AgentProcessEvent[];
  updatedAt: string;
}

const root = process.cwd();
const baseUrl = process.env.SKILLSCOPE_URL ?? "http://127.0.0.1:5173";
const runId = new Date().toISOString().replace(/[:.]/g, "-");
const workDir = path.join(root, ".skilllens", "monitor-smoke", runId);
const artifactPath = path.join(workDir, "fake-codex-output.log");
const screenshotDir = path.join(root, ".skilllens", "monitor-smoke-screenshots");
const runScreenshotDir = path.join(screenshotDir, runId);

async function main() {
  await assertServer();
  await mkdir(path.join(workDir, "bin"), { recursive: true });
  await mkdir(runScreenshotDir, { recursive: true });

  const fakeCodexPath = await writeFakeCodex();
  const child = spawn(fakeCodexPath, [artifactPath], {
    cwd: root,
    detached: process.platform !== "win32",
    stdio: "ignore"
  });
  child.unref();

  try {
    const processEvent = await waitForProcess((item) => hasArtifact(item, artifactPath), 25000);
    assert(processEvent.agentRootPid, "process should be linked to a Codex agent root");
    assert(processEvent.artifactPaths?.some((item) => item.path === artifactPath), "artifact path should be detected");

    await waitForArtifactText("fake-codex-smoke-step-2", 25000);

    const browser = await BrowserSession.launch(`${baseUrl}/?view=monitor`);
    try {
      await browser.screenshot(path.join(runScreenshotDir, "01-monitor-page-loaded.png"));
      await browser.waitForText("fake-codex-output.log", 30000);
      await browser.evaluate(`
        (() => {
          const group = [...document.querySelectorAll('.agent-process-group')]
            .find((node) => (node.textContent || '').includes('fake-codex-output.log'));
          if (!group) return 'missing group';
          group.scrollIntoView({ block: 'center' });
          group.querySelectorAll('details').forEach((item) => { item.open = true; });
          group.style.outline = '3px solid #1967d2';
          return 'ok';
        })()
      `);
      await browser.screenshot(path.join(runScreenshotDir, "02-agent-process-detected.png"));

      await browser.evaluate(`
        (() => {
          const group = [...document.querySelectorAll('.agent-process-group')]
            .find((node) => (node.textContent || '').includes('fake-codex-output.log'));
          const button = group?.querySelector('.process-row button.danger');
          if (button instanceof HTMLElement) {
            button.scrollIntoView({ block: 'center' });
            button.style.outline = '3px solid #b42318';
          }
          return Boolean(button);
        })()
      `);
      await browser.screenshot(path.join(runScreenshotDir, "03-agent-stop-button-before-click.png"));

      const clicked = await browser.evaluate(`
        (() => {
          const group = [...document.querySelectorAll('.agent-process-group')]
            .find((node) => (node.textContent || '').includes('fake-codex-output.log'));
          const groupButton = group?.querySelector('.agent-process-group-head button.danger');
          if (groupButton) return 'unsafe-group-button';
          const button = group?.querySelector('.process-row button.danger');
          button?.click();
          return button ? 'clicked-child' : 'missing-child-button';
        })()
      `);
      assert(clicked.result?.value === "clicked-child", `expected only child stop button, got ${clicked.result?.value}`);
      await sleep(1500);
      await browser.screenshot(path.join(runScreenshotDir, "04-agent-after-stop-click.png"));
      await browser.waitForMissingText("fake-codex-output.log", 15000);
      await browser.screenshot(path.join(runScreenshotDir, "05-agent-process-removed.png"));
    } finally {
      await browser.close();
    }

    await waitForProcessExit(processEvent.agentRootPid ?? processEvent.pid, 15000);
    const afterKill = await listProcesses();
    assert(!afterKill.processes.some((item) => hasArtifact(item, artifactPath)), "agent process group should be stopped from the frontend");

    await maybeRunDockerCase();

    console.log("monitor smoke passed");
    console.log(`artifact: ${artifactPath}`);
    console.log(`screenshots: ${runScreenshotDir}`);
  } finally {
    killProcessGroup(child.pid);
  }
}

async function writeFakeCodex(): Promise<string> {
  const scriptPath = path.join(workDir, "bin", "codex");
  await writeFile(
    scriptPath,
    `#!/usr/bin/env bash
set -euo pipefail
artifact="$1"
mkdir -p "$(dirname "$artifact")"
echo "fake-codex-root $$" >> "$artifact"
setsid bash -lc 'artifact="$1"; for i in $(seq 1 24); do echo "fake-codex-smoke-step-$i" >> "$artifact"; sleep 2; done' bash "$artifact" &
child=$!
wait "$child"
`,
    "utf8"
  );
  await chmod(scriptPath, 0o755);
  return scriptPath;
}

async function maybeRunDockerCase() {
  if (!process.argv.includes("--docker")) {
    return;
  }
  const docker = await commandExists("docker");
  if (!docker) {
    console.log("docker smoke skipped: docker command not found");
    return;
  }
  await commandOutput("docker", ["info"]).catch((error) => {
    throw new Error(`docker smoke skipped: docker daemon is not reachable (${error instanceof Error ? error.message : error})`);
  });
  const name = `skillscope-monitor-smoke-${runId.toLowerCase().replace(/[^a-z0-9]/g, "-")}`;
  const dockerArtifact = path.join(workDir, "fake-codex-docker.log");
  const dockerBinDir = path.join(workDir, "docker-bin");
  await mkdir(dockerBinDir, { recursive: true });
  const fakeCodexPath = path.join(dockerBinDir, "codex");
await writeFile(
    fakeCodexPath,
    `#!/usr/bin/env bash
set -euo pipefail
artifact="$1"
echo "docker-case-start $$" >> "$artifact"
setsid bash -lc 'artifact="$1"; docker rm -f ${name} >/dev/null 2>&1 || true; docker run -d --name ${name} alpine sh -c "while true; do echo docker-smoke-step; sleep 2; done" >> "$artifact" 2>&1; echo "docker-detached-container ${name}" >> "$artifact"; while true; do echo "docker-child-alive ${name}" >> "$artifact"; sleep 2; done' bash "$artifact" &
child=$!
wait "$child"
`,
    "utf8"
  );
  await chmod(fakeCodexPath, 0o755);
  const child = spawn(fakeCodexPath, [dockerArtifact], { cwd: root, detached: process.platform !== "win32", stdio: "ignore" });
  child.unref();
  try {
    const dockerProcess = await waitForProcess((item) => Boolean(item.canStop) && hasArtifact(item, dockerArtifact) && JSON.stringify(item).includes(name), 45000);
    assert(dockerProcess.dockerContainers?.includes(name), "docker container name should be associated with the monitored child process");
    await waitForArtifactTextAt(dockerArtifact, "docker-detached-container", 45000);
    const browser = await BrowserSession.launch(`${baseUrl}/?view=monitor`);
    try {
      await browser.screenshot(path.join(runScreenshotDir, "06-docker-monitor-page-loaded.png"));
      await browser.waitForText("fake-codex-docker.log", 30000);
      await browser.evaluate(`
        (() => {
          const group = [...document.querySelectorAll('.agent-process-group')]
            .find((node) => (node.textContent || '').includes('fake-codex-docker.log') || (node.textContent || '').includes(${JSON.stringify(name)}));
          if (!group) return false;
          group.scrollIntoView({ block: 'center' });
          group.querySelectorAll('details').forEach((item) => { item.open = true; });
          group.style.outline = '3px solid #b42318';
          return true;
        })()
      `);
      await browser.screenshot(path.join(runScreenshotDir, "07-docker-process-and-artifact-detected.png"));
      await browser.evaluate(`
        (() => {
          const group = [...document.querySelectorAll('.agent-process-group')]
            .find((node) => (node.textContent || '').includes('fake-codex-docker.log') || (node.textContent || '').includes(${JSON.stringify(name)}));
          const button = group?.querySelector('.process-row button.danger');
          if (button instanceof HTMLElement) {
            button.scrollIntoView({ block: 'center' });
            button.style.outline = '3px solid #b42318';
          }
          return Boolean(button);
        })()
      `);
      await browser.screenshot(path.join(runScreenshotDir, "08-docker-stop-button-before-click.png"));
      const clicked = await browser.evaluate(`
        (() => {
          const group = [...document.querySelectorAll('.agent-process-group')]
            .find((node) => (node.textContent || '').includes('fake-codex-docker.log') || (node.textContent || '').includes(${JSON.stringify(name)}));
          const groupButton = group?.querySelector('.agent-process-group-head button.danger');
          if (groupButton) return 'unsafe-group-button';
          const button = group?.querySelector('.process-row button.danger');
          button?.click();
          return button ? 'clicked-child' : 'missing-child-button';
        })()
      `);
      assert(clicked.result?.value === "clicked-child", `frontend should expose only a child stop button for docker agent group, got ${clicked.result?.value}`);
      await sleep(3500);
      await browser.screenshot(path.join(runScreenshotDir, "09-docker-after-stop-click.png"));
    } finally {
      await browser.close();
    }
    const running = await commandOutput("docker", ["ps", "-q", "--filter", `name=${name}`]);
    if (running.trim()) {
      await commandOutput("docker", ["rm", "-f", name]);
      throw new Error("docker container survived frontend stop; monitor needs docker-aware cleanup for detached containers");
    }
    const verificationBrowser = await BrowserSession.launch(`${baseUrl}/?view=monitor`);
    try {
      await verificationBrowser.waitForMissingText("fake-codex-docker.log", 15000);
      await verificationBrowser.screenshot(path.join(runScreenshotDir, "10-docker-process-removed-container-stopped.png"));
    } finally {
      await verificationBrowser.close();
    }
    console.log("docker smoke passed");
  } finally {
    killProcessGroup(child.pid);
    await commandOutput("docker", ["rm", "-f", name]).catch(() => "");
  }
}

async function assertServer() {
  const response = await fetch(`${baseUrl}/api/agent-processes`).catch(() => null);
  assert(response?.ok, `SkillScope dev server is not reachable at ${baseUrl}`);
}

async function listProcesses(): Promise<MonitorPayload> {
  const response = await fetch(`${baseUrl}/api/agent-processes`);
  if (!response.ok) {
    throw new Error(`failed to list processes: HTTP ${response.status} ${await response.text()}`);
  }
  return (await response.json()) as MonitorPayload;
}

async function postJson(pathname: string, body: unknown) {
  const response = await fetch(`${baseUrl}${pathname}`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body)
  });
  assert(response.ok, `POST ${pathname} failed: HTTP ${response.status} ${await response.text()}`);
  return response.json();
}

async function waitForProcess(predicate: (item: AgentProcessEvent) => boolean, timeoutMs: number): Promise<AgentProcessEvent> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const payload = await listProcesses();
    const found = payload.processes.find(predicate);
    if (found) {
      return found;
    }
    await sleep(700);
  }
  throw new Error("timed out waiting for monitor process");
}

async function waitForArtifactText(expected: string, timeoutMs: number) {
  return waitForArtifactTextAt(artifactPath, expected, timeoutMs);
}

async function waitForArtifactTextAt(filePath: string, expected: string, timeoutMs: number) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const text = existsSync(filePath) ? await readFile(filePath, "utf8") : "";
    if (text.includes(expected)) {
      return;
    }
    await sleep(500);
  }
  throw new Error(`timed out waiting for artifact text: ${expected}`);
}

async function waitForProcessExit(pid: number | undefined, timeoutMs: number) {
  if (!pid) {
    return;
  }
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const payload = await listProcesses();
    if (!payload.processes.some((item) => item.pid === pid || item.agentRootPid === pid)) {
      return;
    }
    await sleep(700);
  }
  throw new Error(`process group still visible after stop: ${pid}`);
}

function hasArtifact(item: AgentProcessEvent, filePath: string): boolean {
  return JSON.stringify(item).includes(filePath);
}

function killProcessGroup(pid: number | undefined) {
  if (!pid || process.platform === "win32") {
    return;
  }
  try {
    process.kill(-pid, "SIGTERM");
  } catch {
    // Best-effort cleanup.
  }
}

async function commandExists(command: string): Promise<boolean> {
  const checker = process.platform === "win32" ? "where" : "which";
  return commandOutput(checker, [command]).then(() => true, () => false);
}

function commandOutput(command: string, args: string[]): Promise<string> {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, { stdio: ["ignore", "pipe", "pipe"] });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (chunk) => {
      stdout += String(chunk);
    });
    child.stderr.on("data", (chunk) => {
      stderr += String(chunk);
    });
    child.on("error", reject);
    child.on("close", (code) => {
      code === 0 ? resolve(stdout) : reject(new Error(stderr || stdout || `${command} failed with ${code}`));
    });
  });
}

function sleep(ms: number) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function assert(condition: unknown, message: string): asserts condition {
  if (!condition) {
    throw new Error(message);
  }
}

class BrowserSession {
  private constructor(
    private readonly chrome: ChildProcess,
    private readonly client: DevtoolsClient
  ) {}

  static async launch(url: string): Promise<BrowserSession> {
    const chromium = (await commandOutput("which", ["chromium-browser"]).catch(() => "")).trim() ||
      (await commandOutput("which", ["chromium"]).catch(() => "")).trim() ||
      (await commandOutput("which", ["google-chrome"]).catch(() => "")).trim();
    assert(chromium, "chromium-browser/chromium/google-chrome is required for frontend smoke");
    const port = 9300 + Math.floor(Math.random() * 500);
    const chrome = spawn(chromium, [
      "--headless",
      "--no-sandbox",
      "--disable-gpu",
      `--remote-debugging-port=${port}`,
      "--window-size=1440,1100",
      "about:blank"
    ], { stdio: "ignore" });
    const endpoint = `http://127.0.0.1:${port}`;
    const tabUrl = await waitForDevtools(endpoint, url);
    const client = await DevtoolsClient.connect(tabUrl);
    await client.send("Page.enable");
    await client.send("Runtime.enable");
    await client.send("Emulation.setDeviceMetricsOverride", {
      width: 1440,
      height: 1100,
      deviceScaleFactor: 1,
      mobile: false
    });
    await client.send("Page.navigate", { url });
    await sleep(3500);
    return new BrowserSession(chrome, client);
  }

  async evaluate(expression: string) {
    return this.client.send("Runtime.evaluate", { expression, awaitPromise: true, returnByValue: true });
  }

  async waitForText(text: string, timeoutMs: number) {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      const result = await this.evaluate(`document.body.innerText.includes(${JSON.stringify(text)})`);
      if (result.result?.value === true) {
        return;
      }
      await sleep(700);
    }
    throw new Error(`timed out waiting for frontend text: ${text}`);
  }

  async waitForMissingText(text: string, timeoutMs: number) {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      const result = await this.evaluate(`document.body.innerText.includes(${JSON.stringify(text)})`);
      if (result.result?.value === false) {
        return;
      }
      await sleep(700);
    }
    throw new Error(`timed out waiting for frontend text to disappear: ${text}`);
  }

  async screenshot(filePath: string) {
    const result = await this.client.send("Page.captureScreenshot", { format: "png", captureBeyondViewport: false });
    await writeFile(filePath, Buffer.from(result.data, "base64"));
  }

  async close() {
    this.client.close();
    this.chrome.kill("SIGTERM");
  }
}

async function waitForDevtools(endpoint: string, url: string): Promise<string> {
  const deadline = Date.now() + 10000;
  while (Date.now() < deadline) {
    try {
      await httpText(`${endpoint}/json/new?${encodeURIComponent(url)}`, "PUT");
      const tabs = JSON.parse(await httpText(`${endpoint}/json/list`)) as Array<{ type: string; url: string; webSocketDebuggerUrl: string }>;
      const tab = tabs.find((item) => item.type === "page" && item.url.includes(baseUrl)) ?? tabs.find((item) => item.type === "page");
      if (tab?.webSocketDebuggerUrl) {
        return tab.webSocketDebuggerUrl;
      }
    } catch {
      // Chrome is still starting.
    }
    await sleep(300);
  }
  throw new Error("timed out waiting for Chrome DevTools");
}

function httpText(url: string, method = "GET"): Promise<string> {
  return new Promise((resolve, reject) => {
    const request = http.request(url, { method }, (response) => {
      let body = "";
      response.on("data", (chunk) => {
        body += String(chunk);
      });
      response.on("end", () => resolve(body));
    });
    request.on("error", reject);
    request.end();
  });
}

class DevtoolsClient {
  private buffer = Buffer.alloc(0);
  private nextId = 0;
  private pending = new Map<number, { resolve: (value: any) => void; reject: (error: Error) => void }>();

  private constructor(private readonly socket: net.Socket) {
    socket.on("data", (chunk) => this.onData(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk)));
  }

  static async connect(wsUrl: string): Promise<DevtoolsClient> {
    const parsed = new URL(wsUrl);
    const socket = await new Promise<net.Socket>((resolve, reject) => {
      const key = randomBytes(16).toString("base64");
      const candidate = net.connect(Number(parsed.port), parsed.hostname, () => {
        candidate.write(
          `GET ${parsed.pathname}${parsed.search} HTTP/1.1\r\n` +
            `Host: ${parsed.host}\r\n` +
            "Upgrade: websocket\r\n" +
            "Connection: Upgrade\r\n" +
            `Sec-WebSocket-Key: ${key}\r\n` +
            "Sec-WebSocket-Version: 13\r\n\r\n"
        );
      });
      let header = "";
      const onData = (chunk: Buffer) => {
        header += chunk.toString("binary");
        const index = header.indexOf("\r\n\r\n");
        if (index >= 0) {
          candidate.off("data", onData);
          const rest = Buffer.from(header.slice(index + 4), "binary");
          resolve(candidate);
          if (rest.length) {
            candidate.emit("data", rest);
          }
        }
      };
      candidate.on("data", onData);
      candidate.on("error", reject);
    });
    return new DevtoolsClient(socket);
  }

  send(method: string, params: Record<string, unknown> = {}): Promise<any> {
    const id = ++this.nextId;
    const payload = Buffer.from(JSON.stringify({ id, method, params }));
    const header = payload.length < 126 ? Buffer.alloc(6) : Buffer.alloc(8);
    header[0] = 0x81;
    if (payload.length < 126) {
      header[1] = 0x80 | payload.length;
      randomBytes(4).copy(header, 2);
    } else {
      header[1] = 0x80 | 126;
      header.writeUInt16BE(payload.length, 2);
      randomBytes(4).copy(header, 4);
    }
    const mask = header.subarray(header.length - 4);
    const masked = Buffer.alloc(payload.length);
    for (let index = 0; index < payload.length; index += 1) {
      masked[index] = payload[index] ^ mask[index % 4];
    }
    this.socket.write(Buffer.concat([header, masked]));
    return new Promise((resolve, reject) => {
      this.pending.set(id, { resolve, reject });
    });
  }

  close() {
    this.socket.end();
  }

  private onData(chunk: Buffer) {
    this.buffer = Buffer.concat([this.buffer, chunk]);
    for (;;) {
      if (this.buffer.length < 2) {
        return;
      }
      const first = this.buffer[0];
      const second = this.buffer[1];
      let length = second & 0x7f;
      let offset = 2;
      if (length === 126) {
        if (this.buffer.length < 4) {
          return;
        }
        length = this.buffer.readUInt16BE(2);
        offset = 4;
      } else if (length === 127) {
        if (this.buffer.length < 10) {
          return;
        }
        length = Number(this.buffer.readBigUInt64BE(2));
        offset = 10;
      }
      if (this.buffer.length < offset + length) {
        return;
      }
      const payload = this.buffer.subarray(offset, offset + length);
      this.buffer = this.buffer.subarray(offset + length);
      if ((first & 0x0f) !== 1) {
        continue;
      }
      const message = JSON.parse(payload.toString()) as { id?: number; result?: unknown; error?: unknown };
      if (message.id && this.pending.has(message.id)) {
        const pending = this.pending.get(message.id)!;
        this.pending.delete(message.id);
        message.error ? pending.reject(new Error(JSON.stringify(message.error))) : pending.resolve(message.result);
      }
    }
  }
}

main().catch(async (error) => {
  console.error(error instanceof Error ? error.message : error);
  await rm(workDir, { recursive: true, force: true }).catch(() => undefined);
  process.exitCode = 1;
});
