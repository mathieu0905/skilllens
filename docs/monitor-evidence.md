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
adds Docker detached-container and Docker codex-exec evidence.

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

Current screenshot-backed features:

- Job room shell: metrics, filters, search, sort, refresh, live toggle.
- Active job card: title, status, process/artifact/container counts.
- Search: filters by job title, artifact, container, command, or cwd.
- Sort: switches to longest-runtime ordering.
- Live toggle: pauses and resumes auto refresh.
- Progress and artifact tail: live log updates appear in the detail panel.
- Safe stop preview: protected root, process targets, and containers are visible before execution.
- Safe stop result: killed processes, removed containers, residual checks, and cleanup errors are visible.
- Recent history: stopped jobs remain visible after leaving Active.
- Stale jobs: no-update jobs appear in the Stale filter.
- Docker detached cleanup: container appears in preview and is removed by stop.
- Docker codex-exec cleanup: host process, artifact, container, preview, and result are captured.
