# Graph-Guided Skill Analysis

SkillLens analyzes skills with a program-analysis mindset.

The core idea is:

```text
skill source -> constraint IR -> skill graph
trace events -> trace facts -> observed path
skill graph x trace facts -> covered / violated / missed / not_applicable / unknown
```

The skill graph is not just a UI diagram. It is the plan that guides trace
inspection.

## Skill Front-End

`SKILL.md` is parsed into instruction units and finer constraints:

- mandatory actions
- prohibitions
- ordering rules
- conditions and branch predicates
- numeric bounds
- command/tool contracts
- file/path requirements
- evidence requirements
- final-output contracts

Each constraint keeps a source span so the UI can highlight exact text instead
of whole paragraphs.

## Skill Graph

The graph models structure that flat highlighting cannot represent:

- headings as sections
- conditions as branch nodes
- obligations dominated by those conditions
- ordering edges such as before/after
- output contracts near terminal nodes
- skipped branches when task context does not trigger them

This is why `not_applicable` is separate from `missed`: if the branch did not
execute, its dominated obligations should not look like failures.

## Trace Facts

The trace is compiled into facts before judgment:

- commands executed
- tools called
- files read or edited
- search results seen
- candidate artifacts discovered
- final answer shape and fields
- event ordering
- human intervention/session boundaries
- inspected ranges where absence was checked

Facts are more reliable than keyword matches because they preserve structure and
event IDs.

## Coverage

Coverage is path-sensitive:

- `covered`: a reachable constraint has satisfying evidence.
- `violated`: the trace contains a positive counterexample.
- `missed`: a reachable obligation is absent before the window ends.
- `not_applicable`: the branch was not taken.
- `unknown`: reachability or evidence is insufficient.

The same model works for Codex, Claude Code, ACP/SkillsBench-style JSONL, and
manual capture bundles because all traces are normalized before fact extraction.

