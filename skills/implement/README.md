# implement

Builds a change test-first and commits it: an approved plan, one of its phases, review feedback, or a plain request. Independent phases are built in parallel by sub-agents.

## When it runs

Both shipped workflows run it as the `implement` stage: `task` after planning, `quick` straight after create-workspace. In `task` it also runs as `fix` inside the qa loop, taking qa's bugs as `feedback`.

Standalone, invoke it with `/yok:implement` in Claude Code or `$implement` in Codex to build any change. It then reviews its own work with the `code-review` skill.

## What it does

- Picks the assignment, first match wins: `feedback` items to fix, else the run's `plan.md`, else the user's request.
- Reads the project's `orchestrate.config.yaml` or `.json` for each package's test, typecheck and lint commands, and the run's baseline to tell old failures from regressions. Loads `code-quality` and `tdd`.
- Builds phases in waves from the plan's dependency graph. Phases with no unbuilt dependency run at once, one sub-agent each, in the same worktree; two phases that share a file run one after the other.
- Each phase: one test per scenario at the level the plan assigns, then the full tests, typecheck and lint, then its E2E leg with the runner's JSON saved as evidence.
- Commits each completed phase with the plan's `## Commit` message. Never pushes.
- Asks the user one question when blocked; if the answer cannot unblock it, finishes the stage with an error rather than reporting unfinished work.

## Inputs and outputs

Reads `workspace` (where to work), optional `phases` (which to build) and optional `feedback` (review items, each a defect to reproduce). Consumes the `plan` artifact when there is one: `.yok/RUN_NAME/artifacts/plan.md` and `phases/phase-N.md`.

Produces the `implementation` artifact, `.yok/RUN_NAME/artifacts/implementation.md`: per phase COMPLETED or BLOCKED with its commit, each scenario and the test that proves it, every check run, and the E2E report or skip note. Also writes `phase-N-e2e.json` or `phase-N-e2e-skipped.md` per phase. The stage output is one line: phases built and the last commit.

## Files

- `SKILL.md`: the stage contract and the full workflow.
- `evals/evals.json`: an eval suite.
