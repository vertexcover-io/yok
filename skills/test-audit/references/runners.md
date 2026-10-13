# Runner flags

Read this in steps 1–3 to get JUnit XML, a random order or repeats out of the project's runner.
Confirm each flag against the runner's `--help` before the first run; flags move between versions.

## Contents

- [The table](#the-table)
- [A runner not in the table](#a-runner-not-in-the-table)
- [Gotchas](#gotchas)

## The table

FILE below is `audit/LAYER/runN/report.xml` in the scratchpad: one folder per run, as step 1 says.
"Repeat" is only for a runner with no random order; one that can shuffle gets separate seeded runs.

| Runner | JUnit XML | Random order (record the seed) | Repeat (no random order only) |
|---|---|---|---|
| Bun 1.3+ | `--reporter=junit --reporter-outfile=FILE` | `--randomize --seed=N` | — |
| Vitest 1+ | `--reporter=junit --outputFile=FILE` | `--sequence.shuffle --sequence.seed=N` | — |
| Jest 29.2+ | `jest-junit` package: `--reporters=default --reporters=jest-junit`, with `JEST_JUNIT_OUTPUT_DIR` set to the run folder | `--randomize --seed=N` | — |
| pytest | `--junitxml=FILE` (built in) | `pytest-randomly` plugin: on once installed, `--randomly-seed=N` | — |
| Go 1.17+ | `gotestsum --junitfile FILE -- ARGS`; plain `go test -json` also works as input for your own parse | `-shuffle=on` (prints the seed), `-shuffle=N` to replay | — |
| Rust (cargo-nextest) | `[profile.ci.junit] path = "junit.xml"` in `.config/nextest.toml`, then `--profile ci` | none | none: separate runs |
| Clojure (Kaocha) | `lambdaisland/kaocha-junit-xml`: `--plugin kaocha.plugin/junit-xml --junit-xml-file FILE` | on by default, `--seed N` to replay | — |
| JVM (Maven Surefire / Gradle) | written by default: `target/surefire-reports/`, `build/test-results/test/`; copy the folder into the run folder | JUnit 5.8+: `junit.jupiter.testmethod.order.default=org.junit.jupiter.api.MethodOrderer$Random` in `junit-platform.properties` | — |
| Playwright | `--reporter=junit` with `PLAYWRIGHT_JUNIT_OUTPUT_NAME=FILE` (add `list` to keep console output) | none; files run in config order | `--repeat-each=N` |
| Cypress | `--reporter junit --reporter-options "mochaFile=audit/LAYER/runN/[hash].xml"` (one file per spec) | none | none: separate runs |
| RSpec | `rspec_junit_formatter` gem: `--format RspecJunitFormatter --out FILE` | `--order random --seed N` | — |

`scripts/junit_summary.py audit/` reads the whole tree and reports each layer on its own.

## A runner not in the table

1. Search its `--help` for `junit`, `xml`, `json` or `report`, and for `random`, `shuffle`, `seed`,
   `order`, `repeat` or `count`.
2. No JUnit output but JSON: convert it, or read pass/fail and time per test from it directly.
3. No machine output at all: run each test file on its own, N times, and record its exit code and
   wall time. That finds flaky and slow *files*; name the file and read it to find the test.
4. No random order: use its repeat flag if it has one, else run it N times in the default order.
   That still finds tests that flake on timing, just not on order. Say in the report that order was
   not shuffled.
5. A plugin the table needs is not installed: say so in the report and use the fallback above. Do not
   add a dependency during an audit.

## Gotchas

- Go caches passing test results; a cached run proves nothing about flakiness and reports near-zero
  time. Pass `-count=1` (or `-count=N`).
- Shuffling only within a file (Bun, Vitest) misses leaks between files; a parallel run with a shared
  port, folder or lock is the usual cross-file cause.
- Retries are often set in the config file (`retries:` in `playwright.config.*` or
  `cypress.config.*`). The command-line flag overrides it; pass it on every audit run.
- Bun's `--rerun-each` reloads the test file on each repeat, so it hides state that leaks between
  tests; use seeded runs instead.
- A reporter that writes one file per spec (Cypress) needs a per-file name such as `[hash]`. A fixed
  name keeps only the last spec, and the baseline undercounts with no error.
- An e2e runner script (`e2e/run.ts`, `scripts/e2e.sh`) often creates its own database and starts
  the servers; prefer it over calling the runner directly, and pass reporter flags through it.
- A runner's own per-file time often excludes setup and import cost. When a file's wall time on its
  own is much larger than its summed test time, the cost is in setup.
