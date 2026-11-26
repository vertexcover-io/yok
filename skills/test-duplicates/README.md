# test-duplicates

Finds the tests added in the test audit's period that prove what another test already proves, each with the test that stays.

## When it runs

The `test-audit` workflow runs it after `run-tests`. It runs unattended and asks nobody anything.

## What it does

1. Lists the test cases added since the period began, from `git diff` over the test files.
2. Sends them to reviewer sub-agents with the test-audit skill's slice prompt, at most five at a time.
3. Keeps a finding only when the dropped test was added in the period and its keeper stays, after reading both tests again.
4. A repo it cannot review gets `testsAdded: null`, the reason, and a line in `errors`, which makes the audit partial.

## Inputs and outputs

- Reads: `workspace` (create-workspace's output) and `audit` (audit-start's output, for `periodStart`).
- Produces: the `test-duplicates.output.v1` JSON, one entry per repo.

## Files

- `SKILL.md`: the stage contract and its steps.
- `scripts/duplicates.ts`: the output schema.
