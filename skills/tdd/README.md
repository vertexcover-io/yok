# tdd

The test-first method, RED-GREEN-REFACTOR, that yok follows when it changes code. Every line of production code answers a test that failed first. Its references are also the testing standard other skills read when they write or review tests.

## When it runs

Not a stage of its own. The `implement` stage loads it before changing code, in both the `task` and `quick` workflows. Invoke it directly with `/yok:tdd` in Claude Code or `$tdd` in Codex when you want test-first work in a normal session.

## What it does

- Reads the project's `orchestrate.config.yaml` or `orchestrate.config.json` for each package's test commands, and any override in `.claude/yok/tdd-reference.md`.
- Agrees the seams first: the public boundaries (exported function, endpoint, CLI command) the tests will target.
- RED: writes one minimal test, runs only that file, and watches it fail for the right reason. A test that passes at once or errors instead of failing is fixed before moving on.
- GREEN: writes the least code that passes, then runs the full suite once when all behaviors are green.
- REFACTOR: cleans up after green, merges near-duplicate tests, and fixes lint on the touched files.
- Repeats one seam at a time. Changes with an externally visible effect also get an end-to-end test that actually ran.

It also covers bug fixes (reproduce first), refactoring legacy code through characterization tests, and a test budget: one test per agreed seam, no more.

## Files

- `SKILL.md`: the method, the red flags that mean TDD was abandoned, and what to do when stuck.
- `references/testing.md`: what a good test proves. The standard for every test.
- `references/anti-patterns.md`: mock and assertion mistakes to avoid.
- `references/integration-e2e.md`: when unit tests are not enough and how to write the rest.
- `references/hermetic-e2e.md`: end-to-end suites that provision themselves, isolate state and fail fast.
- `evals/`: eval fixtures.
