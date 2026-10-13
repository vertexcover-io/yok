---
name: test-audit
description: >
  Audit a test suite for broken and flaky tests, slow files and redundant tests, and propose ranked
  actions to fix them. Use when the user says "audit the tests", "too many tests", "the suite is
  slow", "find flaky tests" or "find duplicate tests".
summary: Say the test count and wall time, how many tests are failing or flaky, and how many removals and merges are proposed.
mode: inline
allowed-tools: [Agent, Bash, Read, Write, Edit, Grep, Glob]
tier: deep
produces:
  - artifact: test-audit
protocols: []
scopes: []
references:
  runners:
    path: references/runners.md
    description: >-
      JUnit XML, random-order and repeat flags per runner, and the fallback for a runner it does not
      list. Read it at step 1.
  slice-prompt:
    path: references/slice-prompt.md
    description: >-
      The prompt each slice reviewer gets. Read it at step 4, before dispatching the reviewers.
  junit-summary:
    path: scripts/junit_summary.py
    description: >-
      Summarises the audit folder (audit/LAYER/runN/*.xml) per layer: tests failing every time,
      flaky tests, slowest files and tests. Run it with python3 at step 2; do not read it.
---

# Test audit

Coding agents add a test for every change and rarely delete one. The suite grows faster than the
code, gets slow, and starts to re-prove the same rule at three layers. This skill finds that and
proposes ranked actions. It changes nothing until the user picks which actions to apply.

## Where the report goes

- **In a run**, as a workflow stage: RUN is the run's spec name. The report is
  `.yok/RUN/artifacts/test-audit.md`. A stage runs unattended, so ask nobody anything and stop
  after step 6: write the report, then finish with
  `yok orchestrate done NODE_RUN_ID --run RUN --summary "SUMMARY" --artifact '{"type":"test-audit","name":"test-audit","path":"artifacts/test-audit.md"}'`.
  Applying the actions is a later stage's job or the user's call, never this one's. Read the
  references with `yok orchestrate skill ref test-audit.NAME`, and get the script's path with
  `yok orchestrate skill ref --path test-audit.junit-summary`.
- **Standalone**: the report goes in the scratchpad, or where the user asks. Read the references
  from this skill's folder. Step 7 runs only after the user picks actions.

Three axes, in this order, because each one feeds the next:

1. **Health** — does the suite pass, every time? A redundancy verdict on a broken test is worthless.
2. **Speed** — where does the wall time go?
3. **Redundancy** — which tests can go or merge without losing what they prove?

## Rules

- **Read-only until the user picks.** Steps 1–6 edit nothing in the repo. Step 7 applies only the
  actions the user chose, and never runs inside a workflow.
- **Every removal names its keeper.** A test is redundant only when another named test (`file:line`),
  its *keeper*, asserts the same behaviour, and the auditor read both. "Probably covered somewhere"
  is not evidence.
- **A distinct branch is not redundant.** An edge case, error path or input the code branches on
  stays, even if it looks like its neighbour.
- **Slow is not a reason to delete.** A slow test that is the only proof of a wiring path stays; the
  fix is to make it faster or move its branch checks down a layer.
- **One keeper per contract.** When two layers prove the same rule, the cheaper one (the unit test)
  keeps the branches and one e2e per command or entry point keeps the wiring.
- **A failing test may be right.** Decide whether the test or the code is wrong (step 2) before
  touching either; until then the assertion stays as written.

## Step 1 — Baseline

**Find every layer.** A *layer* is one runner over one set of tests: unit, integration, e2e,
browser, script tests. Find them in the package scripts, the runner configs (`vitest.config.*`,
`playwright.config.*`, `cypress.config.*`, `jest.config.*`, `pytest.ini`), the CI workflows, and
folders named `e2e`, `integration` or `tests`. Get each runner's JUnit XML, random-order and repeat
flags from `references/runners.md`; it also says what to do for a runner it does not list.

**Run every layer**, once, as JUnit XML. Slow, or needing services, is a reason to start the
services, not to skip the layer. A layer that needs a database, a server or a browser gets
them from the project's own commands: its e2e runner script, `docker compose`, the README's or
CLAUDE.md's setup steps. Browser test tools download their own browser; if it is missing, run the
tool's download command (for example `bunx playwright install`). Install nothing else. A layer may
stay unrun only after starting its services failed, and only for a reason a person must fix: a
missing secret, a paid or remote service, a tool that is not installed. Record it as **not run**,
with the command tried and its error.

**Protect existing data.** Read each setup or e2e script before running it. Run it as is when it
creates its own database or container and removes it afterwards. When it resets, migrates, seeds
or truncates a database it did not create, ask the user first; in a run, record the layer as not
run with that reason. Stop every service the audit started once the runs are done.

**Turn retries off** for every audit run, this one included (Playwright `--retries=0`). A retry
re-runs a failed test until it passes and reports only the pass, so the flake disappears. Retry
is not repeat: repeat runs every test N times and keeps every result.

**Save each run** in its own folder, `audit/LAYER/runN/`, in the scratchpad; a run may write any
number of reports into it. Check the layer's result count in the summary against the count the
runner printed; a lower count means a report was overwritten.

Record, in the scratchpad:

- per layer: test files, tests, wall time, pass, fail and skip counts, and whether it ran (yes, or
  not run and why)
- test lines against source lines (the ratio is the first smell)
- the `audit/` folder of runs. Every later number is compared against this baseline.

Done when every layer has a saved run, or a not-run entry with its reason.

## Step 2 — Health: broken, flaky, wrong

Look for flakes per layer. If the runner can shuffle, run it two more times, each with a new
recorded seed; that also catches a test that fails only after another one. If it can't shuffle,
run it once more with its repeat flag set to 3 (Playwright `--repeat-each=3`), retries still off:
the order never changes, so separate runs add nothing, and repeat starts the services once. A
runner with neither gets two more plain runs.

Then run `python3 JUNIT_SUMMARY audit/`, where JUNIT_SUMMARY is the `junit-summary` reference's
path. It reports each layer on its own: tests failing every time, flaky tests (some copies failed,
some passed), and the slowest files.

**Failing tests.** For each one, compare the last change to the test file with the last change to
the source files it imports (`git log -1 --format=%cI -- FILE`), and read the commits, spec, ADR or
README behind the newer one:

| Evidence | Verdict | Fix |
|---|---|---|
| The source changed after the test, and the record says the new behaviour is intended | test outdated | update the assertion to the new contract |
| The test matches the documented contract, and the source's last change broke it | code wrong | fix the code; the test stays |
| Fails only with a missing tool, port, env var or network | environment | make the test hermetic, or skip it with a reason the runner prints |
| No record either way | unknown | report both readings and ask |

**Flaky tests.** For each one, name the cause: shared state between tests, real time or timers,
the order of async work, a real network or service, a leaked process, port or file. Prefer moving
the check down a layer to hardening a large test; large tests are where flakes live.

**Passing but wrong.** Search the test files for tests that cannot fail: no assertion, an assertion
on a value the test just built, `skip`/`todo`/`xit`/`t.Skip` left behind, commented-out tests,
`expect(true)`, a catch block that swallows the assertion.

Done when every failing and flaky test has a verdict and a cause, and the search has run over every
test file.

## Step 3 — Speed

From each layer's slowest-files list, take every file at 5% or more of that layer's test time, or
its ten slowest, whichever is more. Time each of those on its own; a file whose own wall time is far
above its summed test time spends it in setup. Read each one and name the cause:

- spawning the CLI or a subprocess per test, where calling the function would prove the same branch
- starting a server, browser, container or terminal session per test instead of once per file
- building or compiling the same artifact in more than one file
- real sleeps, polling with long intervals, timeouts that are always hit
- real network calls or tool probes where a stub on `PATH` or a fake would do
- a module with no unit tests, so its branches are proved only through slow e2e tests
- parallelism off, or files that serialise on a shared lock, port or folder

Done when every selected file has a cause, a fix, and the rough time the fix saves.

## Step 4 — Redundancy

Split the suite into slices of at most about 8,000 test lines each, with related files in one slice:
a module's unit test with its e2e test, two providers that share helpers. Launch one subagent per
slice, at most five at a time, in one message, each with the prompt in `references/slice-prompt.md`.
Above five slices, run them in waves. Each returns its *findings*.

What they flag:

| Category | Meaning |
|---|---|
| DUPLICATE | asserts the same behaviour as another test |
| SUBSUMED | another layer already proves it: an e2e re-checks a unit branch, or a unit test re-checks what one e2e proves |
| PARAMETERIZABLE | near-identical tests that differ only in input; one table-driven test |
| LOW-VALUE | proves only the framework or schema library, a constant, a mock echoing what the test passed in, or the text of a shipped file |

And the structural patterns behind them, which matter more than any single test:

- e2e tests that re-check branches the unit tests own
- one rule tested in three places (CLI e2e, command e2e, core unit)
- shared helpers tested again through every caller
- many schema-only tests
- tests that pin the text of shipped content (prompts, config, docs) and break on every edit

Done when every slice has returned its findings.

## Step 5 — Merge the findings

- **Resolve conflicts.** Two slices may flag opposite sides of one pair (one says drop the unit test,
  the other says drop the e2e). Keep the unit test for a branch and the e2e for wiring; never drop both.
- **Protect keepers.** A test named as a keeper for any removal stays.
- **Dedupe** tests flagged by two slices.
- **Count** removals, rows trimmed, tests merged (N → M), net change and percent.

## Step 6 — Report and actions

Write the report where "Where the report goes" says. Sections, in order:

1. Baseline: one row per layer with tests, wall time, pass, fail and flaky counts. A layer not run
   is named in the report's first lines. If the CI config skips a layer, say so here as a separate
   finding.
2. Health: each failing or flaky test with its verdict, cause and fix
3. Speed: selected files, cause, fix, estimated saving
4. Redundancy totals and the conflicts resolved
5. Remove list by file: `file:line` — name — kept by `file:line` — reason
6. Merge groups
7. Structural patterns, each with the tests it accounts for
8. Actions

The actions section is one ranked list. Each action is a row: what to do, the tests it touches, the
time it saves, the risk (low for a deletion with a verified keeper, higher for anything that writes
new tests or touches setup), and whether you recommend it. Fixes for failing tests come first; a
cleanup on a red suite hides what it broke. Standalone, ask the user which actions to apply; in a
run, finish the stage here.

## Step 7 — Apply the chosen actions

- Work on a branch. Commit only when the user says so.
- Give each subagent (up to five) a disjoint list of files it may edit. Pass the report and its
  conflicts table as binding.
- Each subagent re-reads every keeper before deleting a test and skips, with a reason, any claim that
  does not hold. It changes only test files and reports suspected production bugs. It runs its own
  files' tests, lint and typecheck.
- When all have finished, run every layer, lint and typecheck yourself. Report before and after:
  test count, wall time, pass and fail. Say so if any contract lost its last test.

## Extra evidence (when the stack supports it)

- **Coverage per file.** Run one file under coverage and compare its covered lines with its keeper's.
  A subset is a candidate, not a verdict: coverage does not see what is asserted.
- **Mutation spot-check.** Empty the body of the function a test claims to protect, or invert one
  condition, and run that test. If it still passes, the test proves nothing.
