# Agent Job Control Room Evidence

Run the screenshot-backed monitor verification with:

```bash
npm run monitor:verify
npm run monitor:verify:docker
```

These commands start a temporary local Vite server, run the smoke flow, validate
the generated evidence manifest, print the screenshot report path, and then stop
the server.

For a server you already started yourself, run the lower-level commands directly:

```bash
npm run monitor:smoke
npm run monitor:smoke:docker
npm run monitor:evidence:check
npm run monitor:evidence:check:docker
```

If the dev server is not on `5173`, set `SKILLSCOPE_URL`, for example:

```bash
SKILLSCOPE_URL=http://127.0.0.1:5174 npm run monitor:smoke:docker
```

Each run writes screenshots and a machine-readable manifest:

```text
.skilllens/monitor-smoke-screenshots/<run-id>/
.skilllens/monitor-smoke-screenshots/<run-id>/evidence.json
.skilllens/monitor-smoke-screenshots/<run-id>/evidence.md
```

The manifest maps every verified feature to:

- `feature`: stable feature name.
- `assertion`: what the smoke test proved before the screenshot.
- `screenshot`: absolute PNG path.
- `capturedAt`: capture timestamp.

The smoke test treats the screenshot list as a contract. It fails if any required
feature is missing from the manifest or if any referenced PNG is missing or empty.
`npm run monitor:smoke` verifies the core feature set. `npm run monitor:smoke:docker`
adds Docker detached-container, Docker Compose project, and Docker codex-exec
evidence.

`evidence.md` is the human-readable report. It contains the same feature-to-screenshot
mapping with local links to each PNG.

`monitor:evidence:check` validates the latest `evidence.json` after the run. You can
also pass a specific manifest path:

```bash
npm run monitor:evidence:check -- .skilllens/monitor-smoke-screenshots/<run-id>/evidence.json
npm run monitor:evidence:check:docker -- .skilllens/monitor-smoke-screenshots/<run-id>/evidence.json
```

The checker fails when a required feature is absent, an evidence entry is incomplete,
`evidenceCount` is inconsistent, or any referenced screenshot is missing or empty.

Current core screenshot-backed features:

- `job-room-shell`: metrics, filters, search, sort, refresh, and live toggle.
- `job-room-task-language`: monitor language describes jobs, artifacts, containers, and stop results instead of raw processes.
- `top-metrics-state`: top metrics distinguish active jobs, stale jobs, containers, and recent failures.
- `job-list-summary`: current filter, result count, sort order, and refresh state are visible.
- `active-job-card`: title, status, process/artifact/container counts, and selected detail.
- `primary-stop-action`: safe-stop preview is available from the top next-action panel.
- `single-stop-action`: job detail exposes one safe-stop entry point, not duplicate controls.
- `job-source-context`: working directory and command are shown before the process tree.
- `job-source-command-clamp`: long source commands stay compact while remaining copyable.
- `process-tree-detail`: technical details expose the process tree with pid/pgid context and protected-root labeling.
- `job-card-latest-clamp`: long latest-output previews stay scannable in job cards.
- `job-runtime-display`: active and stale jobs show wall-clock runtime.
- `job-search`: filters by job title, artifact, container, command, or cwd.
- `job-search-clear`: clear-search control resets the query.
- `job-sort`: switches job ordering.
- `live-refresh-toggle`: pauses and resumes auto refresh.
- `job-progress-and-artifact-tail`: live progress and artifact tail update from logs.
- `safe-stop-preview`: protected root, process targets, and containers are visible before execution.
- `safe-stop-result`: killed processes, removed containers, residual checks, and cleanup errors are visible.
- `stop-result-copy`: stop result can be copied.
- `stopped-job-focused`: after stop, Recent focuses the stopped job instead of a long history list.
- `artifact-copy-actions`: artifact and history paths can be copied.
- `artifact-output-copy`: latest artifact output can be copied.
- `artifact-readable-label`: artifact headers use readable file names while keeping full paths copyable.
- `history-json-record`: stopped jobs expose persisted history JSON, and the smoke test verifies it contains `lastStopResult`.
- `recent-history`: stopped jobs remain visible after leaving Active.
- `empty-state-navigation`: empty search states route to useful filters.
- `issues-filter`: stale jobs and cleanup failures are grouped for review.
- `attention-sort`: needs-attention ordering prioritizes stale and cleanup-failure jobs.
- `stale-job-filter`: no-update jobs appear in the Stale filter after 30 seconds.
- `protected-root-no-stop`: external Codex/Claude root jobs show protected status and no stop button when no stoppable child task exists.

Additional Docker screenshot-backed features:

- `docker-job-filter`: detached-container jobs appear with container summaries.
- `docker-artifact-container-detail`: Docker job detail shows artifact tail and container name.
- `docker-stop-preview`: detached container appears in the preview before cleanup.
- `docker-stop-result`: detached container is removed and residual checks are shown.
- `docker-compose-project-detail`: Compose project containers are detected from Docker labels and shown in the job detail.
- `docker-compose-stop-preview`: Compose project containers found by label appear in stop preview.
- `docker-compose-stop-result`: Compose label-discovered containers are removed without running `docker compose down`.
- `docker-codex-exec-job-filter`: Docker-contained codex-exec jobs appear in the monitor.
- `docker-codex-exec-detail`: host process, artifact tail, and container are captured.
- `docker-codex-exec-stop-preview`: process and container cleanup targets are listed before stopping.
- `docker-codex-exec-stop-result`: cleanup result and residual checks are shown.

Expected feature counts:

- Core: 31 screenshots.
- Docker: 42 screenshots.
