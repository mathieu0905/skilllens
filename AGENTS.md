# Agent Collaboration Rules

## Version Management

- Use git commits to version SkillScope code, analyzer logic, optimizer prompts, and workflow rules.
- Do not manage logic history by creating endless `v1`, `v2`, `v3`, `v8` directories or constants. That makes rollback and comparison noisy.
- Use git revert, branches, tags, and commit hashes for rollback or comparison.
- Keep experiment artifacts under semantic names that describe intent, such as `fresh-from-original`, `native-target-split`, or `cia-batch-smoke`.
- Every experiment artifact should record the code commit, analyzer version or schema version, source skill path, trace path, and native verifier result.
- Only bump explicit schema/analyzer version strings when cache compatibility or persisted data format genuinely changes.
- Temporary numbered directories are allowed only for short-lived scratch work. Promote useful results into a semantic run name or a database record, then clean up redundant copies.

## Principle

Experiment outputs are data. Git history is the version manager.
