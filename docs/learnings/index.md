# Learnings

- [Name by what it does, not `xOf`](naming.md) — Use when naming a function or a field
- [Don't nest ternaries](nested-ternaries.md) — Use when writing a conditional expression with more than two outcomes
- [Don't test log lines](no-log-assertions.md) — Use when writing a test assertion
- [Inline single-use helpers, unless they hold complex logic](single-use-helpers.md) — Use when extracting a function that has one caller
- [Don't pass a Result up unchanged; unwrap it and catch once where the error is handled](unwrap-forwarded-results.md) — Use when a function calls several Result-returning functions and only passes their errors up
- [Build a new feature for every agent yok runs, not just Claude](build-for-all-agents.md) — Use when building a new feature that works with the agent, such as Claude Code or Codex
- [Run the suite with `bun run test` and watch that it does not hang](run-tests-with-bun-run-test.md) — Use when running the project's whole test suite
