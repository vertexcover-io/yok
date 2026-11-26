---
name: run-tests
description: >
  Run each repo's test suite three times and once with coverage, and report the test count per
  type, the suite's time, its flaky, failing and slow tests, its coverage and the coverage of the
  lines changed in the audit's period. Runs as the test-audit workflow's run-tests stage.
summary: Say per repo how many tests ran, how many are flaky or failing, and the coverage.
mode: inline
allowed-tools: [Bash, Read, Grep, Glob]
tier: fast
outputs:
  description: Per repo, the counts, time, flaky, failing and slow tests and coverage, with the reason for each value not measured.
  schema: run-tests.output.v1
  module: scripts/coverage.ts
protocols: []
scopes: []
references:
  coverage:
    path: scripts/coverage.ts
    description: Reads an lcov report and prints the coverage of the whole suite and of the lines changed since a time.
---

# Run tests

The input holds `workspace`, create-workspace's output, and `audit`, audit-start's output, whose
`periodStart` begins the audit's period. Do every step for each repo in `workspace.repos`, in its
`worktreeDir`. SCRATCH below is a folder in the scratchpad.

This stage runs unattended. Ask nobody anything. A measurement you cannot make is never a reason
to finish with `--error`: give it a null value, its reason under `notMeasured`, and, when a step
broke, a line in `errors`.

## Steps

1. **Find each test type.** Read the project's config, the file `yok orchestrate get config.path`
   names. When a package sets `testTypes`, its globs mark the integration and e2e test files and
   its `testAll` command runs them all. Otherwise find each type the way the test-audit skill finds
   layers: a separate e2e or integration command in the package scripts, a runner config such as
   `playwright.config.*`, a CI workflow, a folder named `e2e` or `integration`. Every other test
   file is a unit test. A type nothing marks gets a null count with the reason that no test is
   marked that type.
2. **Run each type three times as JUnit XML.** Get the runner's JUnit, random-order and repeat
   flags from `yok orchestrate skill ref test-audit.runners`. Turn retries off. Shuffle with a new
   seed each run when the runner can, and save run N of type T in `SCRATCH/REPO/T/runN/`. Start
   the services a type needs with the project's own scripts, and record a type as not run when
   that would reset, migrate or seed data it did not create. Time each run with the wall clock.
3. **Summarize the runs.** Run `python3 PATH SCRATCH/REPO --json`, where PATH is printed by
   `yok orchestrate skill ref --path test-audit.junit-summary`. It prints, per type, the test
   count, the tests failing every run, the flaky tests with each run's outcome, and the slow files.
4. **Run the suite once with coverage** as lcov, with the runner's coverage flag, then run
   `yok orchestrate skill run run-tests.coverage LCOV --repo WORKTREE --since PERIOD_START`. It
   prints `coverage` and `coverageChanged`, the coverage of the lines changed in the period, or
   null when no changed line is measured.
5. **Reply** with the `run-tests.output.v1` JSON: `{ repos: [...] }`, one entry per repo with
   `repo`, `commands` (the command that ran each type), `tests` (`all` and each type's count),
   `seconds` (the summed wall time of each type's first run), `coverage`, `coverageChanged`,
   `flaky`, `failing` (with the failure message), `slow`, `notMeasured` and `errors`.
