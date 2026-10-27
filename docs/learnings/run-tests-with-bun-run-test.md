---
signal: Use when running the project's whole test suite
paths: ["packages/**", "skills/**"]
tags: [testing, bun]
strength: default
---
# Run the suite with `bun run test` and watch that it does not hang

Use the `bun run test` script, which adds `--parallel --timeout 20000`, and never bare `bun test`: without those flags a stuck test can hang the run. Track the run while it goes (a background task with a deadline, not one blocking call): the suite takes 3-4 minutes, so a run far past that is stuck, and you stop it and find the hung test.

**Occurrences:**
- 2026-10-27 · a bare `bun test` over all packages ran for over 10 minutes; the user said the suite should not take over 3-4 minutes

**Stale when:** the `test` script in package.json no longer carries `--parallel`, or the suite's normal run time changes from 3-4 minutes.
