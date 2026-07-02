# SkillLens Claude Code Command

This directory contains a Claude Code command template for SkillLens capture and browser launch.

Copy or symlink:

```text
integrations/claude-code/.claude/commands/skilllens-capture.md
```

into a project-level `.claude/commands/` directory, then use it to produce:

```text
skilllens.capture.json
```

The wrapper script calls the shared capture CLI:

```bash
integrations/claude-code/scripts/capture-claude-code.sh \
  --trace <claude-session.jsonl> \
  --skill <path-to-SKILL.md> \
  --out skilllens.capture.json
```

Then:

```bash
npm run analyze -- --bundle skilllens.capture.json --out skilllens-report
```

The browser UI reads `.skilllens/registry.json` and auto-loads the latest captured session. Set `SKILLLENS_NO_OPEN=1` to skip launching the browser.

The command should pass explicit `--skill` paths for files known to be loaded
or intentionally used in the session. Directory scanning is available, but it is
weaker provenance.
