# find-factors

Lists the factors that change an existing product flow's behavior or outcome, and lets the person pick which ones the regression tests cover.

## When it runs

The `regression` workflow runs it right after `create-workspace`, before `write-scenarios`. It also works on its own for "what affects this flow".

## What it does

1. Agrees the flow's scope, then reads every unit on its path in the run's workspace.
2. Traces each condition that changes the flow's fields, actions, validation, access, calculations or outcomes, and groups them into factors.
3. Writes `factors.md`: one ticked checkbox per factor, gates first, each with a product-language description.
4. Waits for approval in the viewer. You untick a factor's checkbox or comment to drop or add factors; Approve sends any unsent changes and locks the ticked set.

## Inputs and outputs

- Reads: `flow` (the flow to cover) and the optional `workspace` from `create-workspace`.
- Produces: the `factors` artifact at `artifacts/factors.md`.

## Files

- `SKILL.md`: the stage contract and its five steps.
