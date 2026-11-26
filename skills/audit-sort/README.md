# audit-sort

Turns the weekly test audit's findings into audit results a person can act on: one result per duplicate, flaky, failing or slow test, each with a state, proof of what happened and the fix.

## When it runs

The `test-audit` workflow runs it after `test-duplicates`. It runs unattended and asks nobody anything.

## What it does

1. Makes one result per finding, with an id built from the audit, repo, problem type and test, so the same finding next week gets the same id.
2. Writes the proof for someone who has not seen the code: where, a plain summary, and evidence blocks.
3. Marks a change a person can judge as `needs_approval` with its diff, and a problem that needs investigating as `needs_work` with the prompt that would start it.

## Inputs and outputs

- Reads: `audit`, `tests` and `duplicates`, the outputs of audit-start, run-tests and test-duplicates.
- Produces: the `audit-sort.output.v1` JSON, `{ results }`.

## Files

- `SKILL.md`: the stage contract and its steps.
- `scripts/sort.ts`: the output schema, which refuses a fix that does not match its state.
- `scripts/sort.test.ts`: its unit tests.
