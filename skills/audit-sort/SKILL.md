---
name: audit-sort
description: >
  Turn the test audit's findings, its duplicate, flaky, failing and slow tests, into one audit
  result each, with a state, proof of what happened and the fix. Runs as the test-audit
  workflow's audit-sort stage.
summary: Say how many results need approval and how many need work, per problem type.
mode: inline
allowed-tools: [Bash, Read, Grep, Glob]
tier: deep
outputs:
  description: One audit result per finding, each with its state, proof and fix.
  schema: audit-sort.output.v1
  module: scripts/sort.ts
protocols: []
scopes: []
references: {}
verifiers:
  - { id: diffs-apply, module: scripts/sort.ts, functionName: checkDiffsApply }
---

# Audit sort

The input holds `audit`, audit-start's output; `tests`, run-tests' output; and `duplicates`,
test-duplicates' output. Read every test and source file a result names in the repo's worktree,
which `yok orchestrate get workspace` lists.

This stage runs unattended. Ask nobody anything.

## Steps

1. **Make one result per finding.** A finding is a duplicate, a flaky test, a test failing every
   run, or a slow file, in one repo. Its id is `AUDIT_ID:REPO:PROBLEM_TYPE:SLUG`, where AUDIT_ID is
   `audit.id` and SLUG is the test's file and name in lowercase words joined by `-`, so the same
   finding next week gets the same id.
2. **Write the proof for a person who has not seen the code.** `where` is the file and line, such
   as `auth/session.test.ts:58`. `summary` says in two or three plain sentences what happened. Its
   `blocks` carry the evidence: a `test-run` block with each run's outcome, a `code` block with the
   test, a `quote` block with the failure message, a `diff` block with the fix.
3. **Choose the state and write the fix.** Deleting a duplicate test whose named keeper stays is
   the only change made without a person: it is `auto_fixed`, and its fix carries the `diff` that
   deletes the test. Any other change you can show and a person can judge, such as making a flaky
   wait deterministic, is `needs_approval`, and its fix carries the `diff`. A problem whose cause
   or fix needs a person to investigate is `needs_work`, and its fix carries the `prompt` that
   would start that work. Every fix has a one-line `summary`. Write each `diff` against the file
   as it is in the worktree, with its context lines, and check it there with `git apply --check`;
   done refuses a diff that does not apply.
4. **List the auto-fixes for the fix stage.** For each auto_fixed result, add one item to `fixes`
   with the result's `id` and `repo`, the test's `file`, a `summary` naming the test to delete, a
   `trigger` saying which keeper proves the same thing, and a `hint` naming the keeper's file and
   line, which must still pass. Set `autoFix` to whether `fixes` has any item.
5. **Reply** with the `audit-sort.output.v1` JSON: `{ results, autoFix, fixes }`.
