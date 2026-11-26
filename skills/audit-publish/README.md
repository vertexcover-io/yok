# audit-publish

Saves the weekly test audit. It builds the report, every metric per repo and the results, from the earlier stages' outputs and publishes it with `yok orchestrate audit finish`.

## When it runs

The `test-audit` workflow runs it after `audit-sort`. It runs unattended and asks nobody anything.

## What it does

1. Reads the node's facts with `yok orchestrate node show` and builds the report with `scripts/report.ts`, so the same stage outputs always make the same rows.
2. Each repo audit-start measured gets every metric at scope '', plus testCount per unit, integration and e2e. A value a stage could not measure, or a repo a stage left out, becomes a not_measured metric with its reason.
3. A stage error or a missing repo makes the audit `partial`; an audit with nothing measured is `failed`; otherwise it is `complete`.
4. Publishes the report with `yok orchestrate audit finish`, which refuses, with nothing written, once an apply run acted on one of the audit's results.

## Inputs and outputs

- Reads: `audit`, `tests`, `duplicates` and `sorted`, the outputs of audit-start, run-tests, test-duplicates and audit-sort.
- Produces: the `audit-publish.output.v1` JSON, `{ auditRunId, status, metrics, results }`.

## Files

- `SKILL.md`: the stage contract and its steps.
- `scripts/report.ts`: the output schema and the script that prints the report. Run it as `yok orchestrate skill run audit-publish.report < FACTS`.
- `scripts/report.test.ts`: its unit tests.
