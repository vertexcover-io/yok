# run-tests

Measures a project's test suite for the weekly test audit. For each repo it runs every test type three times and once with coverage, and reports the test count per type, the suite's time, its flaky, failing and slow tests, its coverage, and the coverage of the lines changed in the audit's period.

## When it runs

The `test-audit` workflow runs it right after `audit-start`, which opened the audit and fixed its period. It runs unattended and asks nobody anything.

## What it does

1. Finds each test type: the package's `testTypes` globs when the config sets them, otherwise the type's own command, runner config, CI workflow or folder name. A test nothing marks is a unit test.
2. Runs each type three times as JUnit XML, in random order where the runner can.
3. Summarizes the runs with the test-audit skill's `junit_summary.py --json`.
4. Runs the suite once with coverage and measures it with `scripts/coverage.ts`.
5. A measurement it cannot make gets a null value and its reason; a step that broke is listed in `errors`, which makes the audit partial. It never fails the run over a measurement.

## Inputs and outputs

- Reads: `workspace` (create-workspace's output) and `audit` (audit-start's output, for `periodStart`).
- Produces: the `run-tests.output.v1` JSON, one entry per repo.

## Files

- `SKILL.md`: the stage contract and its steps.
- `scripts/coverage.ts`: the output schema, and the script that reads an lcov report and prints `coverage` and `coverageChanged`. Run it as `yok orchestrate skill run run-tests.coverage LCOV --repo WORKTREE --since ISO_TIME`.
- `scripts/coverage.test.ts`: its unit tests.
