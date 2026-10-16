# write-scenarios

Turns the factors the person kept into regression scenarios for an existing product flow, and gets them approved.

## When it runs

The `regression` workflow runs it after `find-factors` and before `write-regression-tests`.

## What it does

1. Reads `factors.md` and scopes the work to the ticked factors.
2. Traces the flow and writes one scenario per rule that sets an outcome the user can see, each tagged `[unit]`, `[integration]` or `[e2e]` with What / Given / When / Then.
3. Merges duplicates, checks every inspected condition is covered or out of scope, and writes `plan.md` with each scenario as a ticked checklist item.
4. Waits for approval in the viewer. You untick a scenario's checkbox to leave it out, or comment to change it; only the ticked scenarios get tests.

## Inputs and outputs

- Reads: `flow`, the optional `workspace`, and the `factors` artifact.
- Produces: the `plan` artifact at `artifacts/plan.md`, which `write-regression-tests`, `review-regression-tests` and `visual-pr` read.

## Files

- `SKILL.md`: the stage contract and its five steps.
