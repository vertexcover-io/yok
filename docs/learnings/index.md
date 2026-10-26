# Learnings

- [Name by what it does, not `xOf`](naming.md) — Use when naming a function or a field
- [Don't nest ternaries](nested-ternaries.md) — Use when writing a conditional expression with more than two outcomes
- [Don't test log lines](no-log-assertions.md) — Use when writing a test assertion
- [Inline single-use helpers, unless they hold complex logic](single-use-helpers.md) — Use when extracting a function that has one caller
- [Don't pass a Result up unchanged; unwrap it and catch once where the error is handled](unwrap-forwarded-results.md) — Use when a function calls several Result-returning functions and only passes their errors up
