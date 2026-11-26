---
name: test-duplicates
description: >
  Compare the tests added in the audit's period against the whole suite and list each one that
  proves what another test already proves, with the test that stays. Runs as the test-audit
  workflow's test-duplicates stage.
summary: Say per repo how many tests were added in the period and how many of them are duplicates.
mode: inline
allowed-tools: [Agent, Bash, Read, Grep, Glob]
tier: deep
outputs:
  description: Per repo, the tests added in the period and each duplicate with its keeper.
  schema: test-duplicates.output.v1
  module: scripts/duplicates.ts
protocols: []
scopes: []
references: {}
---

# Test duplicates

The input holds `workspace`, create-workspace's output, and `audit`, audit-start's output. Do
every step for each repo in `workspace.repos`, in its `worktreeDir`.

This stage runs unattended. Ask nobody anything. When a step cannot finish for a repo, set its
`testsAdded` to null, say why in `notMeasured`, and add a line to `errors`; never finish the stage
with `--error` for it.

## Steps

1. **List the tests added in the period.** BASE is
   `git rev-list -1 --before=PERIOD_START HEAD`, or git's empty tree when that prints nothing.
   Read `git diff BASE HEAD` over the test files and list every test case it adds, with its file,
   line and name. Their number is `testsAdded`.
2. **Review them against the suite.** Read `yok orchestrate skill ref test-audit.slice-prompt`
   and send it to one sub-agent per group of added tests, at most five at a time, with the added
   tests as the slice and the rest of the suite as the neighbours to check.
3. **Keep only proven duplicates of an added test.** Keep a finding when it is DUPLICATE or
   SUBSUMED, the test to drop was added in the period, and it names a keeper by file and line that
   stays. Read both tests again before keeping it.
4. **Reply** with the `test-duplicates.output.v1` JSON: `{ repos: [...] }`, one entry per repo
   with `repo`, `testsAdded`, `duplicates` (each `test`, `keeper` and `reason`), `notMeasured` and
   `errors`.
