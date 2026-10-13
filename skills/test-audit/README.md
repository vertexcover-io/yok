# test-audit

Audits a whole test suite and proposes ranked actions to make it smaller, faster and green. It answers three questions: which tests are broken or flaky (and whether the test or the code is wrong), where the wall time goes, and which tests can go or merge without losing what they prove. It works with any runner that writes JUnit XML, and falls back to per-file runs for one that does not.

## When it runs

It is a stage no shipped workflow uses yet; a project workflow can add it as a node. In a run it works unattended, writes `.yok/RUN/artifacts/test-audit.md` and stops at the report; it never applies the actions. You can also invoke it with `/yok:test-audit` in Claude Code or `$test-audit` in Codex, or say "audit the tests", "the suite is slow" or "find duplicate tests"; standalone, it asks which actions to apply and then applies them.

## What it does

- Finds every test layer (unit, integration, e2e, browser) and runs each one, starting the database, servers and browser the project needs. Records per layer: tests, wall time, pass and fail counts. If CI skips a layer, the report flags it separately.
- Reads each setup or e2e script first, and asks before running one that would reset, migrate or seed a database it did not create.
- Runs every layer with the runner's retries off. A layer that can shuffle gets two more seeded runs; one that can't (Playwright) gets one more run with its repeat flag. `scripts/junit_summary.py audit/` then reports each layer on its own: tests failing every time, flaky tests, slowest files and tests.
- Gives each failing test a verdict (outdated test, wrong code, environment, unknown) from git history and the documented intent, and names a cause for each flaky one.
- Reads the slowest files and names the cause of each, with a fix and the time it saves.
- Splits the suite into slices and sends one read-only reviewer per slice, up to five at a time. Each flags duplicate, subsumed, parameterizable and low-value tests, and every removal names the test that keeps the coverage.
- Merges the findings, resolves pairs flagged from both sides, and writes one report ending in a ranked action list with risk and saving per action.
- Applies the actions you pick with up to five agents on disjoint files, then compares test count and wall time before and after. It never commits without asking.

## Files

- `SKILL.md`: the rules, the seven steps and the report format.
- `references/runners.md`: JUnit, random-order and repeat flags for Bun, Vitest, Jest, pytest, Go, Rust, Clojure, JVM and RSpec, and the fallback for any other runner.
- `references/slice-prompt.md`: the prompt each slice reviewer gets.
- `scripts/junit_summary.py`: summarises the audit folder, `audit/LAYER/runN/*.xml`, per layer (Python 3 standard library only). Tests: `python3 -m unittest discover -s skills/test-audit/scripts`.
- `evals/`: eval prompts, a small fixture, and `make-two-layer-repo.sh`, which builds a repo with a unit and a Playwright layer.

Ideas from the `test-audit` skill in openclaw/openclaw (keeper per contract, evidence ledger) and PostHog's `fixing-flaky-tests` (reproduce before fixing).
