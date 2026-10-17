# review-regression-tests

Reviews the regression tests against the approved scenarios and the testing standard, and hands back a fix list. It never edits files.

## When it runs

The `regression` workflow runs it in its review loop, after `write-regression-tests`, in place of `code-review`. When it finds problems, the next pass runs `write-regression-tests` on its findings and reviews again, at most twice.

## What it does

1. Reads `plan.md`, `implementation.md` and the test diff.
2. Runs two reviewers in parallel: the plan review in `references/review.md`, and `code-review`'s testing persona.
3. Checks each finding, drops the wrong ones, and labels the rest `test`, `plan` or `product`.
4. Writes `test-review.md` and returns the verdict and findings.

## Inputs and outputs

- Reads: the optional `workspace`, `round` and `rounds`, and the `plan` artifact.
- Produces: the `test-review` artifact at `artifacts/test-review.md`, and the `review-regression-tests.output.v1` output.

## Files

- `SKILL.md`: the stage contract and its steps.
- `references/review.md`: the brief for the plan-review sub-agent.
- `scripts/review.ts`: the output schema.
