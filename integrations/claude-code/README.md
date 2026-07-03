# SkillScope Claude Code Command

This directory contains a Claude Code command template for SkillScope capture and browser launch.

Copy or symlink:

```text
integrations/claude-code/.claude/commands/skillscope.md
```

into a project-level `.claude/commands/` directory, then run:

```text
/skillscope
```

The command calls the shared capture CLI:

```bash
npm run capture -- \
  --agent claude_code \
  --trace <claude-session.jsonl> \
  --skill <path-to-SKILL.md> \
  --out skillscope.capture.json
```

Then:

```bash
npm run analyze -- --bundle skillscope.capture.json --out skillscope-report
npm run open
```

The browser UI reads `.skilllens/registry.json` and auto-loads the latest captured session. Set `SKILLSCOPE_NO_OPEN=1` to skip launching the browser.

The command should pass explicit `--skill` paths for files known to be loaded
or intentionally used in the session. Directory scanning is available, but it is
weaker provenance.
