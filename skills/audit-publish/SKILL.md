---
name: audit-publish
description: >
  Build the test audit's report, its metrics per repo and its results, from the earlier stages'
  outputs and publish it with yok orchestrate audit finish. Runs as the test-audit workflow's
  audit-publish stage.
summary: Say whether the audit is complete, partial or failed, and how many results it published.
mode: inline
allowed-tools: [Bash, Read]
tier: fast
outputs:
  description: The published audit's id and status, and how many metrics and results it holds.
  schema: audit-publish.output.v1
  module: scripts/report.ts
consumes:
  - artifact: fix-result
    optional: true
  - artifact: pull-request
    optional: true
protocols: []
scopes: []
references:
  report:
    path: scripts/report.ts
    description: Reads the node's facts on stdin and prints the audit report for audit finish.
---

# Audit publish

The input holds `audit`, `tests`, `duplicates` and `sorted`, the outputs of audit-start, run-tests,
test-duplicates and audit-sort. NODE_RUN_ID is the id in this stage's `done` command and SCRATCH
a folder in the scratchpad.

This stage runs unattended. Ask nobody anything.

## Steps

1. **Build the report.** Run
   `yok orchestrate node show --node-run NODE_RUN_ID > SCRATCH/facts.json`, then
   `yok orchestrate skill run audit-publish.report < SCRATCH/facts.json > SCRATCH/report.json`.
2. **Publish it.** Run `yok orchestrate audit finish < SCRATCH/report.json`. It prints the
   published audit. When it refuses, finish the stage with `--error -` and its message: a refusal
   means the audit cannot be published again, and nothing was written.
3. **Reply** with the `audit-publish.output.v1` JSON: the audit's `auditRunId` and `status`, and
   the number of `metrics` and `results` in the report.
