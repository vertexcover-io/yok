# planning

Turns an approved design into a plan a coder can build from without opening the codebase: phases cut as vertical slices, every change written as a diff, and the test scenarios that prove each phase. It is the second approval gate in the `task` workflow.

## When it runs

The `task` workflow runs it as the `planning` stage, after design and before implement. `quick` has no planning stage.

Standalone, invoke it with `/yok:planning` in Claude Code or `$planning` in Codex, or ask "plan this" or "how should we implement" once a design is approved. Without an approved `design.md` it runs the `design` skill first.

## What it does

- Reads `design.md` in full and stops if its status is not `approved`. Dispatches sub-agents to locate code and binding ADRs and docs, and reads the design frames ticket-fetcher collected, then reads every file a step will edit.
- Cuts the phases. Each is a vertical slice that can be tested end to end on its own; phase 1 is the thinnest slice that proves the wiring. Derives the test matrix, one row per requirement.
- Writes `phases/phase-N.md` first, then `plan.md`. A contradiction between the design and the code goes to the user, and only their answer changes `design.md`.
- Reviews its own work with lookup checks, then sends a fresh sub-agent to confirm every diff's context lines exist in the files. Sends each decision to the `adr` skill.
- Shows the user the phases, the matrix counts and the file links, and asks for approval. A revision is applied and asked again.

## Inputs and outputs

Reads `task` (the task text) and optional `workspace` (the worktrees to read code in). Consumes the `design` artifact, `.yok/RUN_NAME/artifacts/design.md`.

Produces the `plan` artifact: `.yok/RUN_NAME/artifacts/plan.md` plus `artifacts/phases/phase-N.md`, one per phase. The stage has no other output.

## Files

- `SKILL.md`: the stage contract and the six steps.
- `references/plan-sections.md`: the `plan.md` and `phase-N.md` contract.
- `references/step-card.md`: the parts of an implementation step and how a change is shown as a diff.
- `references/test-scenarios.md`: how to derive scenarios and pick each one's test level.
- `references/docs-scout.md`: the brief for the sub-agent that finds binding docs.
- `scripts/plan.ts`: the `design-coverage` verifier, which rejects a plan that leaves a frame in `design/INDEX.md` unclaimed, or a step that builds to a frame without a diff. Tests beside it.
- `evals/evals.json`: an eval suite.
