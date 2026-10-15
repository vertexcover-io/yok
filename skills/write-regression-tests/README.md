# write-regression-tests

Writes a test for every approved regression scenario, then commits and pushes them. Inside the review loop, it fixes what the test review found.

## When it runs

The `regression` workflow runs it after `write-scenarios`, in place of `implement`. It runs again as `fix-tests` on a later pass of the review loop, before `review-regression-tests`.

## What it does

1. Writes one test per scenario in `plan.md`, at its tagged level, with the scenario ID in the test name. With `fixes`, it fixes the review's findings instead.
2. Gets `plan.md` approved again when a scenario changed.
3. Commits and pushes the tests.
4. Writes `implementation.md`.

## Inputs and outputs

- Reads: the optional `workspace`, `fixes` and `round`, and the `plan` artifact.
- Produces: the `implementation` artifact at `artifacts/implementation.md`.

## Files

- `SKILL.md`: the stage contract and its steps.
