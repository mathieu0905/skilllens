# SkillLens Codex Plugin

This local Codex plugin captures Codex skill provenance for SkillLens and opens the browser viewer.

The user-facing entry is a Codex slash prompt:

```bash
npm run install:codex-prompt
```

Then type this inside Codex:

```text
/skilllens
```

The installed prompt runs:

```bash
npm --prefix <SkillLens repo> run codex -- --project-cwd "$(pwd)"
```

That launcher discovers the active Codex rollout JSONL under `~/.codex/sessions`,
captures loaded or trace-proven skill files, writes `skilllens.capture.json`, runs
the shared analyzer, and opens the browser UI. The browser reads
`.skilllens/registry.json` and auto-loads the latest captured session.

If automatic trace discovery is ambiguous, invoke the prompt with a precise path:

```text
/skilllens --trace ~/.codex/sessions/2026/07/01/rollout-....jsonl
```

Set `SKILLLENS_NO_OPEN=1` or pass `--no-open` to capture without launching the browser.

The important bit is provenance: pass explicit `--skill` paths for the files
that were loaded or intentionally used in the Codex run. Directory discovery is
available, but those files cannot be treated as confirmed loaded.

`integrations/skilllens-codex/scripts/capture-codex.sh` remains only as a
compatibility wrapper around `npm run codex`; it is not the recommended UX.
