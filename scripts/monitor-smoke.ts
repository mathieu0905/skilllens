import { spawn, type ChildProcess } from "node:child_process";
import { randomBytes } from "node:crypto";
import { chmod, mkdir, readFile, rm, stat, writeFile } from "node:fs/promises";
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

interface AgentJob {
  id: string;
  title: string;
  status: "active" | "recent" | "stale" | "stopped" | "failed";
  processes: AgentProcessEvent[];
  containers: Array<{ name: string }>;
  artifacts: Array<{ label: string; path: string; size?: number; mtime?: string }>;
  canStop: boolean;
  stopPlan?: unknown;
  lastStopResult?: unknown;
}

interface JobPayload {
  jobs: AgentJob[];
  updatedAt: string;
}

interface ScreenshotEvidence {
  feature: string;
  assertion: string;
  screenshot: string;
  capturedAt: string;
}

const root = process.cwd();
const baseUrl = process.env.SKILLSCOPE_URL ?? "http://127.0.0.1:5173";
const runId = new Date().toISOString().replace(/[:.]/g, "-");
const workDir = path.join(root, ".skilllens", "monitor-smoke", runId);
const artifactPath = path.join(workDir, "fake-codex-output.log");
const screenshotDir = path.join(root, ".skilllens", "monitor-smoke-screenshots");
const runScreenshotDir = path.join(screenshotDir, runId);
const evidencePath = path.join(runScreenshotDir, "evidence.json");
const evidenceMarkdownPath = path.join(runScreenshotDir, "evidence.md");
const screenshotEvidence: ScreenshotEvidence[] = [];
const includeDockerEvidence = process.argv.includes("--docker");
const baseEvidenceFeatures = [
  "job-room-shell",
  "job-room-task-language",
  "job-list-summary",
  "active-job-card",
  "primary-stop-action",
  "job-source-context",
  "job-source-command-clamp",
  "job-card-latest-clamp",
  "job-runtime-display",
  "artifact-copy-actions",
  "artifact-output-copy",
  "job-search",
  "job-search-clear",
  "empty-state-navigation",
  "job-sort",
  "live-refresh-toggle",
  "job-progress-and-artifact-tail",
  "safe-stop-preview",
  "safe-stop-result",
  "stop-result-copy",
  "stopped-job-focused",
  "artifact-readable-label",
  "recent-history",
  "issues-filter",
  "attention-sort",
  "stale-job-filter"
];
const dockerEvidenceFeatures = [
  "docker-job-filter",
  "docker-artifact-container-detail",
  "docker-stop-preview",
  "docker-stop-result",
  "docker-codex-exec-job-filter",
  "docker-codex-exec-detail",
  "docker-codex-exec-stop-preview",
  "docker-codex-exec-stop-result"
];

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
    await waitForJob((item) => hasArtifact(item, artifactPath) && item.status === "active", 25000);

    const browser = await BrowserSession.launch(`${baseUrl}/?view=monitor`);
    try {
      await captureEvidence(browser, "01-monitor-page-loaded.png", "job-room-shell", "metrics, filters, search, sort, refresh, and live toggle are visible");
      await browser.waitForText("任务控制室", 15000);
      await browser.waitForText("长任务", 15000);
      await captureEvidence(browser, "01aa-job-room-task-language.png", "job-room-task-language", "the monitor entry and header describe jobs, artifacts, containers, and safe-stop results instead of raw processes");
      await browser.waitForText("fake-codex-output.log", 30000);
      await browser.waitForText("Showing", 15000);
      await captureEvidence(browser, "01a-job-list-summary-visible.png", "job-list-summary", "job list summary explains the current filter, result count, sort order, and refresh state");
      await browser.evaluate(`
        (() => {
          const group = [...document.querySelectorAll('.agent-process-group')]
            .find((node) => (node.textContent || '').includes('fake-codex-output.log'));
          if (!group) return 'missing group';
          group.scrollIntoView({ block: 'center' });
          if (group instanceof HTMLElement) group.click();
          group.querySelectorAll('details').forEach((item) => { item.open = true; });
          group.style.outline = '3px solid #1967d2';
          return 'ok';
        })()
      `);
      await captureEvidence(browser, "02-active-job-card-appears.png", "active-job-card", "active job card shows title, status, process/artifact/container counts, and selected detail");
      const primaryStopVisible = await browser.evaluate(`
        (() => {
          const button = [...document.querySelectorAll('button')]
            .find((item) => (item.textContent || '').includes('Preview stop safely'));
          if (!button) return false;
          const rect = button.getBoundingClientRect();
          return rect.top >= 0 && rect.bottom <= window.innerHeight && rect.left >= 0 && rect.right <= window.innerWidth;
        })()
      `);
      assert(primaryStopVisible.result?.value === true, "primary safe stop action should be visible without scrolling the detail panel");
      await captureEvidence(browser, "02aa-primary-stop-action-visible.png", "primary-stop-action", "safe stop preview is available from the top next-action panel without scrolling");
      await browser.waitForText("WORKING DIRECTORY", 15000);
      await browser.waitForText("COMMAND", 15000);
      await browser.waitForText("Copy cwd", 15000);
      await browser.waitForText("Copy command", 15000);
      await captureEvidence(browser, "02ab-job-source-context-visible.png", "job-source-context", "job detail shows the working directory and command before the technical process tree");
      const commandPreview = await browser.evaluate(`
        (() => {
          const commandBlock = [...document.querySelectorAll('.job-path-action')]
            .find((node) => (node.querySelector('span')?.textContent || '').trim().toLowerCase() === 'command');
          const code = commandBlock?.querySelector('code');
          const copyButton = commandBlock?.querySelector('button');
          if (!code || !copyButton) return { ok: false, reason: 'missing command block' };
          const style = window.getComputedStyle(code);
          const lineHeight = Number.parseFloat(style.lineHeight || '0') || 16;
          return {
            ok: code.clientHeight <= (lineHeight * 4.8) && (copyButton.textContent || '').includes('Copy command'),
            height: code.clientHeight,
            lineHeight,
            text: code.textContent,
            button: copyButton.textContent
          };
        })()
      `);
      assert(commandPreview.result?.value?.ok === true, `command source preview should stay compact and copyable: ${JSON.stringify(commandPreview.result?.value)}`);
      await captureEvidence(browser, "02aba-job-source-command-clamped.png", "job-source-command-clamp", "long source commands are clamped in the detail while the full command remains copyable");
      await browser.waitForText("readable trace update", 15000);
      const latestPreview = await browser.evaluate(`
        (() => {
          const card = [...document.querySelectorAll('.job-card')]
            .find((node) => (node.textContent || '').includes('fake-codex-output.log'));
          const latest = card?.querySelector('.job-card-latest p');
          if (!latest) return { ok: false, reason: 'missing latest preview' };
          const style = window.getComputedStyle(latest);
          const lineHeight = Number.parseFloat(style.lineHeight || '0') || 16;
          return {
            ok: latest.clientHeight <= (lineHeight * 2.6) && (latest.getAttribute('title') || '').includes('readable trace update'),
            height: latest.clientHeight,
            lineHeight,
            text: latest.textContent,
            title: latest.getAttribute('title')
          };
        })()
      `);
      assert(latestPreview.result?.value?.ok === true, `latest output preview should stay scannable: ${JSON.stringify(latestPreview.result?.value)}`);
      await captureEvidence(browser, "02ac-job-card-latest-clamped.png", "job-card-latest-clamp", "long structured latest output is summarized and clamped in job cards while remaining available in the detail");
      await browser.waitForText("runtime", 15000);
      await captureEvidence(browser, "02a-runtime-display-visible.png", "job-runtime-display", "active and stale jobs show wall-clock runtime instead of last-update age");
      await verifySearchSortAndLiveControls(browser);
      await browser.waitForText("fake-codex-smoke-step", 30000);
      await captureEvidence(browser, "03-job-progress-live.png", "job-progress-and-artifact-tail", "progress and artifact tail update from the live job log");

      const previewed = await browser.evaluate(`
        (() => {
          const buttons = [...document.querySelectorAll('button')];
          const button = buttons.find((item) => (item.textContent || '').includes('Preview stop'));
          button?.scrollIntoView({ block: 'center' });
          button?.click();
          return Boolean(button);
        })()
      `);
      assert(previewed.result?.value === true, "stop preview button should be visible");
      await browser.waitForText("Stop preview", 15000);
      const stopPreviewVisible = await browser.evaluate(`
        (() => {
          const plan = [...document.querySelectorAll('.stop-plan')]
            .find((node) => (node.textContent || '').includes('Stop preview'));
          if (!plan) return false;
          const rect = plan.getBoundingClientRect();
          const text = plan.textContent || '';
          return rect.top >= 0 && rect.bottom <= window.innerHeight && text.includes('Will stop') && text.includes('Will not touch');
        })()
      `);
      assert(stopPreviewVisible.result?.value === true, "stop preview target list should be visible in the screenshot viewport");
      await captureEvidence(browser, "04-stop-preview-visible.png", "safe-stop-preview", "preview lists protected root, process targets, and container targets before execution");

      await clickEnabledButton(browser, "Execute stop", 15000);
      await browser.waitForText("Stop result", 45000);
      await captureEvidence(browser, "05-stop-result-visible.png", "safe-stop-result", "stop result shows killed processes, removed containers, residual checks, and cleanup errors");
      const copiedResult = await browser.evaluate(`
        (() => {
          const button = [...document.querySelectorAll('button')]
            .find((item) => (item.textContent || '').includes('Copy result'));
          button?.scrollIntoView({ block: 'center' });
          button?.click();
          return Boolean(button);
        })()
      `);
      assert(copiedResult.result?.value === true, "copy result button should be visible");
      await browser.waitForText("Copied result", 15000);
      await captureEvidence(browser, "05a-stop-result-copy.png", "stop-result-copy", "stop result summary can be copied for reports or follow-up prompts");
      const stoppedFocus = await browser.evaluate(`
        (() => {
          const input = document.querySelector('input[aria-label="Search jobs"]');
          const summary = document.querySelector('.job-list-summary');
          const selected = document.querySelector('.job-card.selected');
          return {
            ok: input instanceof HTMLInputElement &&
              input.value.includes('fake-codex-output.log') &&
              (summary?.textContent || '').includes('Showing 1 matching job') &&
              (selected?.textContent || '').includes('Stop'),
            query: input instanceof HTMLInputElement ? input.value : '',
            summary: summary?.textContent || '',
            selected: selected?.textContent || ''
          };
        })()
      `);
      assert(stoppedFocus.result?.value?.ok === true, `stopped job should be focused in recent history: ${JSON.stringify(stoppedFocus.result?.value)}`);
      await captureEvidence(browser, "05aa-stopped-job-focused.png", "stopped-job-focused", "after a stop, Recent history is filtered to the stopped job instead of a long history list");
      const copiedPath = await browser.evaluate(`
        (() => {
          const button = [...document.querySelectorAll('button')]
            .find((item) => (item.textContent || '').includes('Copy path'));
          button?.scrollIntoView({ block: 'center' });
          button?.click();
          return Boolean(button);
        })()
      `);
      assert(copiedPath.result?.value === true, "copy path button should be visible");
      await browser.waitForText("Copied", 15000);
      await captureEvidence(browser, "05a-artifact-copy-action.png", "artifact-copy-actions", "artifact and history paths can be copied from the job detail");
      const copiedOutput = await browser.evaluate(`
        (() => {
          const button = [...document.querySelectorAll('button')]
            .find((item) => (item.textContent || '').includes('Copy output'));
          button?.scrollIntoView({ block: 'center' });
          button?.click();
          return Boolean(button);
        })()
      `);
      assert(copiedOutput.result?.value === true, "copy output button should be visible");
      await captureEvidence(browser, "05ab-artifact-output-copy.png", "artifact-output-copy", "artifact output can be copied directly from the latest output panel");
      await browser.waitForText(path.basename(artifactPath), 15000);
      await captureEvidence(browser, "05aa-artifact-readable-label.png", "artifact-readable-label", "artifact output headers use readable file names while full paths remain copyable");
    } finally {
      await browser.close();
    }

    await waitForProcessExit(processEvent.agentRootPid ?? processEvent.pid, 15000);
    const afterKill = await listProcesses();
    assert(!afterKill.processes.some((item) => hasArtifact(item, artifactPath)), "agent process group should be stopped from the frontend");
    const stoppedJob = await waitForJob((item) => hasArtifact(item, artifactPath) && ["stopped", "failed"].includes(item.status), 15000);
    assert(Boolean(stoppedJob.lastStopResult), "stopped job should keep the stop result in recent history");
    await captureRecentHistoryEvidence(artifactPath, "05b-recent-history-visible.png");

    await runStaleJobCase();
    await maybeRunDockerCase();
    await maybeRunDockerCodexExecCase();
    await writeEvidenceManifest();

    console.log("monitor smoke passed");
    console.log(`artifact: ${artifactPath}`);
    console.log(`screenshots: ${runScreenshotDir}`);
    console.log(`evidence: ${evidencePath}`);
    console.log(`evidence report: ${evidenceMarkdownPath}`);
  } finally {
    killProcessGroup(child.pid);
  }
}

async function runStaleJobCase() {
  const staleArtifact = path.join(workDir, "stale-codex-output.log");
  const fakeCodexPath = await writeFakeStaleCodex(staleArtifact);
  const child = spawn(fakeCodexPath, [staleArtifact], {
    cwd: root,
    detached: process.platform !== "win32",
    stdio: "ignore"
  });
  child.unref();
  try {
    await waitForArtifactTextAt(staleArtifact, "stale-codex-start", 20000);
    await waitForJob((item) => hasArtifact(item, staleArtifact) && item.status === "active", 20000);
    const staleJob = await waitForJob((item) => hasArtifact(item, staleArtifact) && item.status === "stale", 45000);
    const browser = await BrowserSession.launch(`${baseUrl}/?view=monitor`);
    try {
      const emptySearch = await browser.evaluate(`
        (() => {
          const activeButton = [...document.querySelectorAll('button')].find((item) => (item.textContent || '').trim().startsWith('Active'));
          activeButton?.click();
          const input = document.querySelector('input[aria-label="Search jobs"]');
          if (!(input instanceof HTMLInputElement)) return 'missing-search';
          const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')?.set;
          setter?.call(input, 'no-such-monitor-job-for-empty-state');
          input.dispatchEvent(new Event('input', { bubbles: true }));
          return 'ok';
        })()
      `);
      assert(emptySearch.result?.value === "ok", `empty-state search setup failed: ${emptySearch.result?.value}`);
      await browser.waitForText("No matching jobs", 15000);
      await browser.waitForText("Show issues", 15000);
      await captureEvidence(browser, "06-empty-state-navigation.png", "empty-state-navigation", "empty search states can route directly to jobs needing attention");
      const clearedEmptySearch = await browser.evaluate(`
        (() => {
          const button = document.querySelector('button[aria-label="Clear search"]') || [...document.querySelectorAll('button')].find((item) => (item.textContent || '').includes('Clear search'));
          if (!(button instanceof HTMLButtonElement)) return 'missing-clear';
          button.click();
          return 'ok';
        })()
      `);
      assert(clearedEmptySearch.result?.value === "ok", `empty-state search clear failed: ${clearedEmptySearch.result?.value}`);
      await waitForSearchValue(browser, "", 5000);

      const issuesClicked = await browser.evaluate(`
        (() => {
          const button = [...document.querySelectorAll('button')].find((item) => (item.textContent || '').trim().startsWith('Issues'));
          button?.click();
          return Boolean(button);
        })()
      `);
      assert(issuesClicked.result?.value === true, "Issues filter should be visible");
      await setMonitorSearch(browser, path.basename(staleArtifact));
      await browser.waitForText("stale-codex-output.log", 15000);
      await captureEvidence(browser, "06-issues-filter-visible.png", "issues-filter", "issues filter groups stale jobs and cleanup failures that need attention");
      const attentionSorted = await browser.evaluate(`
        (() => {
          const select = document.querySelector('select[aria-label="Sort jobs"]');
          if (!(select instanceof HTMLSelectElement)) return 'missing-sort';
          select.value = 'attention';
          select.dispatchEvent(new Event('change', { bubbles: true }));
          return select.value;
        })()
      `);
      assert(attentionSorted.result?.value === "attention", `attention sort should be selectable, got ${attentionSorted.result?.value}`);
      await browser.waitForText("attention priority", 15000);
      await captureEvidence(browser, "06a-attention-sort-visible.png", "attention-sort", "needs-attention sort prioritizes cleanup failures and stale jobs");

      const staleClicked = await browser.evaluate(`
        (() => {
          const button = [...document.querySelectorAll('button')].find((item) => (item.textContent || '').trim().startsWith('Stale'));
          button?.click();
          return Boolean(button);
        })()
      `);
      assert(staleClicked.result?.value === true, "Stale filter should be visible");
      await waitForSearchValue(browser, path.basename(staleArtifact), 5000);
      await browser.waitForText("stale-codex-output.log", 15000);
      await captureEvidence(browser, "06b-stale-job-visible.png", "stale-job-filter", "stale filter exposes jobs with no artifact/log updates for more than 30 seconds");
    } finally {
      await browser.close();
    }
    await postJson(`/api/agent-jobs/${encodeURIComponent(staleJob.id)}/stop/preview`, {});
    await postJson(`/api/agent-jobs/${encodeURIComponent(staleJob.id)}/stop`, { signal: "SIGTERM" });
  } finally {
    killProcessGroup(child.pid);
  }
}

async function verifySearchSortAndLiveControls(browser: BrowserSession) {
  const searched = await browser.evaluate(`
    (() => {
      const input = document.querySelector('input[aria-label="Search jobs"]');
      if (!(input instanceof HTMLInputElement)) return 'missing-search';
      input.focus();
      const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')?.set;
      setter?.call(input, 'fake-codex-output.log');
      input.dispatchEvent(new Event('input', { bubbles: true }));
      return document.body.innerText.includes('fake-codex-output.log') ? 'ok' : 'search-no-match';
    })()
  `);
  assert(searched.result?.value === "ok", `search control should filter to the active job, got ${searched.result?.value}`);
  await captureEvidence(browser, "02b-search-filter-visible.png", "job-search", "search filters jobs by title, artifact path, container, command, or cwd");
  const cleared = await browser.evaluate(`
    (() => {
      const button = document.querySelector('button[aria-label="Clear search"]');
      if (!(button instanceof HTMLButtonElement)) return 'missing-clear';
      button.click();
      return 'clicked';
    })()
  `);
  assert(cleared.result?.value === "clicked", `clear search should be clickable, got ${cleared.result?.value}`);
  await waitForSearchValue(browser, "", 5000);
  await browser.waitForText("Showing", 15000);
  await captureEvidence(browser, "02ba-search-clear-visible.png", "job-search-clear", "clear search resets the query without manual text deletion");

  const sorted = await browser.evaluate(`
    (() => {
      const select = document.querySelector('select[aria-label="Sort jobs"]');
      if (!(select instanceof HTMLSelectElement)) return 'missing-sort';
      select.value = 'runtime';
      select.dispatchEvent(new Event('change', { bubbles: true }));
      return select.value;
    })()
  `);
  assert(sorted.result?.value === "runtime", `sort control should switch to runtime, got ${sorted.result?.value}`);
  await captureEvidence(browser, "02c-sort-control-visible.png", "job-sort", "sort control can switch the job list to longest runtime");

  const paused = await browser.evaluate(`
    (() => {
      const checkbox = document.querySelector('.job-live-toggle input');
      if (!(checkbox instanceof HTMLInputElement)) return 'missing-live-toggle';
      if (checkbox.checked) checkbox.click();
      return document.body.innerText.includes('Paused') ? 'ok' : 'pause-label-missing';
    })()
  `);
  assert(paused.result?.value === "ok", `live toggle should switch to Paused, got ${paused.result?.value}`);
  await captureEvidence(browser, "02d-live-paused-visible.png", "live-refresh-toggle", "auto refresh can be paused while inspecting a job");

  const restored = await browser.evaluate(`
    (() => {
      const checkbox = document.querySelector('.job-live-toggle input');
      const input = document.querySelector('input[aria-label="Search jobs"]');
      if (checkbox instanceof HTMLInputElement && !checkbox.checked) checkbox.click();
      if (input instanceof HTMLInputElement) {
        const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')?.set;
        setter?.call(input, '');
        input.dispatchEvent(new Event('input', { bubbles: true }));
      }
      return document.body.innerText.includes('Live') ? 'ok' : 'live-label-missing';
    })()
  `);
  assert(restored.result?.value === "ok", `live toggle should switch back to Live, got ${restored.result?.value}`);
}

async function waitForSearchValue(browser: BrowserSession, value: string, timeoutMs: number) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const result = await browser.evaluate(`
      (() => {
        const input = document.querySelector('input[aria-label="Search jobs"]');
        return input instanceof HTMLInputElement ? input.value : 'missing-search';
      })()
    `);
    if (result.result?.value === value) {
      return;
    }
    await sleep(250);
  }
  throw new Error(`timed out waiting for search value: ${value}`);
}

async function setMonitorSearch(browser: BrowserSession, value: string) {
  const result = await browser.evaluate(`
    (() => {
      const input = document.querySelector('input[aria-label="Search jobs"]');
      if (!(input instanceof HTMLInputElement)) return 'missing-search';
      const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')?.set;
      setter?.call(input, ${JSON.stringify(value)});
      input.dispatchEvent(new Event('input', { bubbles: true }));
      return input.value;
    })()
  `);
  assert(result.result?.value === value, `search value should be set to ${value}, got ${result.result?.value}`);
}

async function captureRecentHistoryEvidence(filePath: string, screenshotName: string) {
  const browser = await BrowserSession.launch(`${baseUrl}/?view=monitor`);
  try {
    const clicked = await browser.evaluate(`
      (() => {
        const button = [...document.querySelectorAll('button')].find((item) => (item.textContent || '').trim().startsWith('Recent'));
        button?.click();
        return Boolean(button);
      })()
    `);
    assert(clicked.result?.value === true, "Recent filter should be visible");
    await browser.waitForText(path.basename(filePath), 15000);
    await captureEvidence(browser, screenshotName, "recent-history", "stopped jobs remain visible in Recent history with stop result context");
  } finally {
    await browser.close();
  }
}

async function clickEnabledButton(browser: BrowserSession, label: string, timeoutMs: number) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const result = await browser.evaluate(`
      (() => {
        const scope = document.querySelector('.job-detail') || document;
        const button = [...scope.querySelectorAll('button')]
          .find((item) => (item.textContent || '').includes(${JSON.stringify(label)}));
        if (!(button instanceof HTMLButtonElement)) return 'missing';
        if (button.disabled) return 'disabled';
        button.scrollIntoView({ block: 'center' });
        button.focus();
        button.click();
        return 'clicked';
      })()
    `);
    if (result.result?.value === "clicked") {
      return;
    }
    await sleep(300);
  }
  throw new Error(`timed out waiting for enabled button: ${label}`);
}

async function captureEvidence(browser: BrowserSession, screenshotName: string, feature: string, assertion: string) {
  const screenshotPath = path.join(runScreenshotDir, screenshotName);
  await browser.screenshot(screenshotPath);
  screenshotEvidence.push({
    feature,
    assertion,
    screenshot: screenshotPath,
    capturedAt: new Date().toISOString()
  });
}

async function writeEvidenceManifest() {
  await assertEvidenceContract();
  const requiredFeatures = includeDockerEvidence ? [...baseEvidenceFeatures, ...dockerEvidenceFeatures] : baseEvidenceFeatures;
  await writeFile(
    evidencePath,
    JSON.stringify(
      {
        runId,
        baseUrl,
        workDir,
        artifactPath,
        screenshotDir: runScreenshotDir,
        requiredFeatures,
        evidenceCount: screenshotEvidence.length,
        evidence: screenshotEvidence
      },
      null,
      2
    ),
    "utf8"
  );
  await writeFile(evidenceMarkdownPath, renderEvidenceMarkdown(), "utf8");
}

async function assertEvidenceContract() {
  const required = includeDockerEvidence ? [...baseEvidenceFeatures, ...dockerEvidenceFeatures] : baseEvidenceFeatures;
  const captured = new Map(screenshotEvidence.map((item) => [item.feature, item]));
  const missing = required.filter((feature) => !captured.has(feature));
  assert(!missing.length, `missing screenshot evidence for features: ${missing.join(", ")}`);
  for (const item of screenshotEvidence) {
    const info = await stat(item.screenshot).catch(() => null);
    assert(info && info.size > 0, `screenshot evidence is missing or empty: ${item.screenshot}`);
  }
}

function renderEvidenceMarkdown(): string {
  const lines = [
    "# Agent Job Control Room Smoke Evidence",
    "",
    `- Run: \`${runId}\``,
    `- Base URL: \`${baseUrl}\``,
    `- Work dir: \`${workDir}\``,
    `- Artifact: \`${artifactPath}\``,
    `- Evidence count: ${screenshotEvidence.length}`,
    "",
    "| Feature | Assertion | Screenshot |",
    "| --- | --- | --- |"
  ];
  for (const item of screenshotEvidence) {
    lines.push(`| \`${item.feature}\` | ${escapeMarkdownTable(item.assertion)} | [${path.basename(item.screenshot)}](./${path.basename(item.screenshot)}) |`);
  }
  lines.push("");
  return lines.join("\n");
}

function escapeMarkdownTable(value: string): string {
  return value.replace(/\|/g, "\\|").replace(/\r?\n/g, " ");
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
setsid bash -lc 'artifact="$1"; for i in $(seq 1 60); do printf "{\\"type\\":\\"response_item\\",\\"payload\\":{\\"type\\":\\"message\\",\\"content\\":[{\\"type\\":\\"output_text\\",\\"text\\":\\"fake-codex-smoke-step-%s readable trace update with enough detail to prove long structured output stays scannable in the job card\\"}]}}\\n" "$i" >> "$artifact"; sleep 2; done' bash "$artifact" &
child=$!
wait "$child"
`,
    "utf8"
  );
  await chmod(scriptPath, 0o755);
  return scriptPath;
}

async function writeFakeStaleCodex(staleArtifact: string): Promise<string> {
  const staleBinDir = path.join(workDir, "stale-bin");
  await mkdir(staleBinDir, { recursive: true });
  const scriptPath = path.join(staleBinDir, "codex");
  await writeFile(
    scriptPath,
    `#!/usr/bin/env bash
set -euo pipefail
artifact="$1"
mkdir -p "$(dirname "$artifact")"
echo "stale-codex-start $$" >> "$artifact"
setsid bash -lc 'sleep 90' &
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
    await waitForJob((item) => hasArtifact(item, dockerArtifact) && JSON.stringify(item).includes(name), 45000);
    const browser = await BrowserSession.launch(`${baseUrl}/?view=monitor`);
    try {
      await captureEvidence(browser, "07-docker-monitor-page-loaded.png", "docker-job-filter", "docker job appears in the monitor with attached container summary");
      await browser.waitForText("fake-codex-docker.log", 30000);
      await browser.evaluate(`
        (() => {
          const group = [...document.querySelectorAll('.agent-process-group')]
            .find((node) => (node.textContent || '').includes('fake-codex-docker.log') || (node.textContent || '').includes(${JSON.stringify(name)}));
          if (!group) return false;
          group.scrollIntoView({ block: 'center' });
          if (group instanceof HTMLElement) group.click();
          group.querySelectorAll('details').forEach((item) => { item.open = true; });
          group.style.outline = '3px solid #b42318';
          return true;
        })()
      `);
      await captureEvidence(browser, "08-docker-process-and-artifact-detected.png", "docker-artifact-container-detail", "docker job detail shows artifact tail and detached container name");
      const previewed = await browser.evaluate(`
        (() => {
          const button = [...document.querySelectorAll('button')].find((item) => (item.textContent || '').includes('Preview stop'));
          button?.scrollIntoView({ block: 'center' });
          button?.click();
          return Boolean(button);
        })()
      `);
      assert(previewed.result?.value === true, "docker stop preview should be visible");
      await browser.waitForText("Stop preview", 15000);
      await browser.waitForText(name, 15000);
      await captureEvidence(browser, "09-docker-stop-preview-visible.png", "docker-stop-preview", "docker stop preview lists the detached container to remove");
      await clickEnabledButton(browser, "Execute stop", 15000);
      await browser.waitForText("Stop result", 45000);
      await captureEvidence(browser, "10-docker-stop-result-visible.png", "docker-stop-result", "docker stop result shows container removal and residual container check");
    } finally {
      await browser.close();
    }
    const running = await commandOutput("docker", ["ps", "-q", "--filter", `name=${name}`]);
    if (running.trim()) {
      await commandOutput("docker", ["rm", "-f", name]);
      throw new Error("docker container survived frontend stop; monitor needs docker-aware cleanup for detached containers");
    }
    await waitForJob((item) => hasArtifact(item, dockerArtifact) && ["stopped", "failed"].includes(item.status), 15000);
    console.log("docker smoke passed");
  } finally {
    killProcessGroup(child.pid);
    await commandOutput("docker", ["rm", "-f", name]).catch(() => "");
  }
}

async function maybeRunDockerCodexExecCase() {
  if (!process.argv.includes("--docker")) {
    return;
  }
  const name = `skillscope-monitor-codex-exec-${runId.toLowerCase().replace(/[^a-z0-9]/g, "-")}`;
  const dockerArtifact = path.join(workDir, "fake-docker-codex-exec.log");
  const dockerBinDir = path.join(workDir, "docker-codex-bin");
  await mkdir(dockerBinDir, { recursive: true });
  const fakeCodexPath = path.join(dockerBinDir, "codex");
  await writeFile(
    fakeCodexPath,
    `#!/usr/bin/env bash
set -euo pipefail
artifact="$1"
echo "docker-codex-exec-case-start $$" >> "$artifact"
setsid bash -lc 'artifact="$1"; docker rm -f ${name} >/dev/null 2>&1 || true; docker run -d --name ${name} alpine sh -c "i=0; echo inside-docker-codex-exec-start; while true; do i=$((i+1)); echo codex-exec-step-$i; sleep 2; done" >> "$artifact" 2>&1; echo "docker-codex-exec-container ${name}" >> "$artifact"; while true; do echo "docker-codex-host-child-alive ${name}" >> "$artifact"; sleep 2; done' bash "$artifact" &
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
    assert(dockerProcess.dockerContainers?.includes(name), "docker codex-exec container name should be associated with the monitored child process");
    await waitForArtifactTextAt(dockerArtifact, "docker-codex-exec-container", 45000);
    await waitForDockerLogText(name, "inside-docker-codex-exec-start", 45000);
    await waitForJob((item) => hasArtifact(item, dockerArtifact) && JSON.stringify(item).includes(name), 45000);
    const browser = await BrowserSession.launch(`${baseUrl}/?view=monitor`);
    try {
      await captureEvidence(browser, "11-docker-codex-exec-page-loaded.png", "docker-codex-exec-job-filter", "docker codex-exec job appears in the monitor");
      await browser.waitForText("fake-docker-codex-exec.log", 30000);
      await browser.evaluate(`
        (() => {
          const group = [...document.querySelectorAll('.agent-process-group')]
            .find((node) => (node.textContent || '').includes('fake-docker-codex-exec.log') || (node.textContent || '').includes(${JSON.stringify(name)}));
          if (!group) return false;
          group.scrollIntoView({ block: 'center' });
          if (group instanceof HTMLElement) group.click();
          group.querySelectorAll('details').forEach((item) => { item.open = true; });
          group.style.outline = '3px solid #805ad5';
          return true;
        })()
      `);
      await captureEvidence(browser, "12-docker-codex-exec-detected.png", "docker-codex-exec-detail", "docker codex-exec detail shows host process, artifact tail, and container");
      const previewed = await browser.evaluate(`
        (() => {
          const button = [...document.querySelectorAll('button')].find((item) => (item.textContent || '').includes('Preview stop'));
          button?.scrollIntoView({ block: 'center' });
          button?.click();
          return Boolean(button);
        })()
      `);
      assert(previewed.result?.value === true, "docker codex-exec stop preview should be visible");
      await browser.waitForText("Stop preview", 15000);
      await browser.waitForText(name, 15000);
      await captureEvidence(browser, "13-docker-codex-exec-stop-preview.png", "docker-codex-exec-stop-preview", "docker codex-exec stop preview lists process and container cleanup targets");
      await clickEnabledButton(browser, "Execute stop", 15000);
      await browser.waitForText("Stop result", 45000);
      await captureEvidence(browser, "14-docker-codex-exec-stop-result.png", "docker-codex-exec-stop-result", "docker codex-exec stop result shows cleanup and residual checks");
    } finally {
      await browser.close();
    }
    const running = await commandOutput("docker", ["ps", "-q", "--filter", `name=${name}`]);
    if (running.trim()) {
      await commandOutput("docker", ["rm", "-f", name]);
      throw new Error("docker codex-exec container survived frontend stop");
    }
    await waitForJob((item) => hasArtifact(item, dockerArtifact) && ["stopped", "failed"].includes(item.status), 15000);
    console.log("docker codex exec smoke passed");
  } finally {
    killProcessGroup(child.pid);
    await commandOutput("docker", ["rm", "-f", name]).catch(() => "");
  }
}

async function assertServer() {
  const response = await fetch(`${baseUrl}/api/agent-jobs`).catch(() => null);
  assert(response?.ok, `SkillScope dev server is not reachable at ${baseUrl}`);
}

async function listProcesses(): Promise<MonitorPayload> {
  const response = await fetch(`${baseUrl}/api/agent-processes`);
  if (!response.ok) {
    throw new Error(`failed to list processes: HTTP ${response.status} ${await response.text()}`);
  }
  return (await response.json()) as MonitorPayload;
}

async function listJobs(): Promise<JobPayload> {
  const response = await fetch(`${baseUrl}/api/agent-jobs`);
  if (!response.ok) {
    throw new Error(`failed to list jobs: HTTP ${response.status} ${await response.text()}`);
  }
  return (await response.json()) as JobPayload;
}

async function postJson(pathname: string, body: unknown) {
  const response = await fetch(`${baseUrl}${pathname}`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body)
  });
  if (!response.ok) {
    throw new Error(`POST ${pathname} failed: HTTP ${response.status} ${await response.text()}`);
  }
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

async function waitForJob(predicate: (item: AgentJob) => boolean, timeoutMs: number): Promise<AgentJob> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const payload = await listJobs();
    const found = payload.jobs.find(predicate);
    if (found) {
      return found;
    }
    await sleep(700);
  }
  throw new Error("timed out waiting for monitor job");
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

async function waitForDockerLogText(container: string, expected: string, timeoutMs: number) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const text = await commandOutput("docker", ["logs", container]).catch(() => "");
    if (text.includes(expected)) {
      return;
    }
    await sleep(700);
  }
  throw new Error(`timed out waiting for docker log text: ${expected}`);
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

function hasArtifact(item: unknown, filePath: string): boolean {
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
