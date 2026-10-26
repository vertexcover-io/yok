---
name: implement
description: >
  Build a requested change, an approved plan or one of its phases test-first,
  one phase at a time, commit each phase and push the branch. Runs as the
  pipeline's implement stage after planning; also use it directly to build any change.
summary: Say which phases were built and whether their tests pass.
mode: inline
allowed-tools: [Agent, AskUserQuestion, Bash, Read, Write, Edit, Grep, Glob, Skill]
tier: deep
consumes:
  - artifact: plan
    optional: true
produces:
  - artifact: implementation
protocols: []
scopes: []
references:
  working-instructions:
    path: references/working-instructions.md
    description: The commands, baseline and push rule the implement and fix stages share.
---

# Implement

Build and test the assigned change, then report what was built.

## 1. Identify the assignment

RUN below is the run's name. The input may hold:

| Field | Meaning |
|---|---|
| `workspace` | the create-workspace stage's output. Work in each repo's `worktreeDir`; without it, work in the current checkout. When a phase changes a repo the workspace lacks, add it first with `yok orchestrate skill run create-workspace.workspace add RUN --repos NAME --run RUN`, then do all reads, edits, checks and commits for that repo in the `worktreeDir` the command's JSON report prints, never in the main checkout, and name the added repo in the report. |
| `phases` | the phase numbers to build. Without it, every phase in the plan. |

The first that applies is the assignment:

1. `.yok/RUN/artifacts/plan.md` exists: build its phases.
2. Otherwise the user's request, or the plan or phase file they name.

A list of things to fix is the `fix` skill's job, not this one's.

## 2. Load the working instructions

Run `yok orchestrate skill ref implement.working-instructions` and follow its Commands section.

Read `docs/learnings/index.md` and open the learnings whose signal or `paths` match the files you
will change.

### Reading the plan

`plan.md` carries the overview, the `## Phases` digraph, `## Design References`, `## ADRs` and
`## Project Docs`. Open every ADR and doc it lists before editing. When a step would go against
an ADR, stop: that is blocked.

A `phases/phase-N.md` is already decomposed; take it as given rather than re-deriving the
feature:

- `## Implementation`: the build steps, in order. Each change is a diff to apply.
- `## Test Scenarios`: `### Unit`, `### Integration`, `### E2E`, each scenario numbered `SCn`.
  One test per scenario, at the level it sits under. Carry the id in the test title
  (`SC12: …`) so a reviewer can trace tests back to scenarios. `### QA Agent` scenarios are not
  yours; the qa stage proves them.
- `## Commit`: the commit message.

## 3. Build the phases one at a time

Build the phases one after another in the order of the `## Phases` digraph. Start a phase only
after the one before it is committed. When a phase is `BLOCKED`, stop.

The node's mode decides who builds each phase:

- `mode: subagent`: you start one sub-agent per phase, directly from here. A plan with one
  phase still gets its sub-agent. No intermediate sub-agent sits between you and the phase
  sub-agents. Each phase sub-agent works in the same worktree. Give it: the paths to its
  phase file and `plan.md`, the worktree, the commands, and these parts of this skill:
  section 2, "For each phase", "The E2E leg" and section 4. It returns `COMPLETED` or
  `BLOCKED` and its commit SHA. You brief it, collect its result and write the report.
- `mode: inline`, or run standalone: build every phase here, inline.

For each phase:

- **Read the design first.** When a step names a frame or a `Spec: design/spec.md` part, open
  both before the step's first test and build to them; qa checks the running screen.
- **Build one behavior at a time** with `tdd`, at each scenario's assigned level.
- **Count a scenario done** only when a test at its assigned level is green. Moving it to a
  cheaper level is `BLOCKED`, not a pass.
- **Test as you go:** affected tests and typecheck while iterating; full tests, typecheck and
  lint once the phase is built. Docs-only changes need the artifact checked, not invented tests.
- **Account for every spec rule.** In `implementation.md`, list each rule the phase's steps point
  at with its test, or `visual, for qa`. Build any rule with neither; one the code cannot meet
  is `BLOCKED` with the reason.
- **Commit the phase** with its `## Commit` message, staging only its changes. Commit without
  asking.

### The E2E leg

`tdd` owns when an e2e test is required and what makes one hermetic. A phase also owes evidence:

- **The report.** The runner writes its own JSON to `.yok/RUN/artifacts/phase-N-e2e.json`.
  The flag each runner needs is in the `tdd` skill's `references/hermetic-e2e.md`. Nothing in
  the file is hand-written.
- **The flow is given.** The phase's `### E2E` block is the spec; use it as written. Before
  creating a spec file, grep the e2e directory for the surface and extend the spec that covers
  it.
- **The environment is the first task, not a blocker.** Bring the stack up, and confirm the
  behavior under test is switched on. Only when setup still cannot run is the phase `BLOCKED`.
- **Skipping.** Only when the phase changes no behavior seen from outside: an internal
  refactor, docs, config with no runtime effect. Write
  `.yok/RUN/artifacts/phase-N-e2e-skipped.md` naming the reason.

## 4. When blocked

Try the configured setup and investigate within the assigned scope first. When what is left
needs a decision, missing access or a change of scope:

- A sub-agent building a phase returns `BLOCKED` with the evidence, the scenario or step, and
  the next action. It never waits for the user.
- The stage itself asks the user the one open question. When the answer cannot unblock it,
  finish the stage with `--error -` and that evidence. Never report unfinished work as done.

## 5. Report and finish

Push as the working instructions' Push section says.

Load `writing-style`, then write `.yok/RUN/artifacts/implementation.md`:

- one row per phase: `COMPLETED` or `BLOCKED`, its commit SHA, the files changed
- per repo, the branch and the pushed head
- each scenario id and the test that proves it
- each check run, with pass and fail counts, and every justified skip
- the E2E report or skip note per phase
- per phase, each spec.md rule its steps point at, with the test that covers it or `visual, for qa`

Finish the stage with `--artifact '{"type":"implementation","name":"implementation","path":"artifacts/implementation.md"}'` and one line as
the output: how many phases were built and the pushed head. `COMPLETED` means the assignment
met its checks; it is not a verdict that the work can ship.

Standalone, review the finished work with the `code-review` skill, run the `fix` skill on the
`review-fixes.json` it writes, then give the same report in the reply.
