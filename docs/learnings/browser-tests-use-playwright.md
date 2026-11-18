---
signal: Use when writing or changing a test that drives a real browser
paths: ["packages/**/*.e2e.test.ts"]
tags: [testing, browser, playwright]
strength: default
---
# Drive the browser in tests with Playwright, not agent-browser

Test suites call Playwright's library directly: each test opens its own browser context, so tests can't leak tabs or state into each other, and locators wait for the page by themselves. `agent-browser` is the qa stage's tool for driving a feature and filming proof; it is not for test suites, where one process per action and a browser shared across `describe` blocks led to order-dependent failures.

**Occurrences:**
- 2026-11-17 · the runs page's SC41 failed only after the viewer suite ran, because that suite's `afterAll` closed the shared agent-browser browser and SC41's cleanup then couldn't close the last tab

**Stale when:** `playwright` is removed from the root package.json devDependencies, or `packages/server/src/viewer.e2e.test.ts` stops being the browser test suite.
