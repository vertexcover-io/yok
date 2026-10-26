# qa

Proves a feature works by driving it: a real browser for anything with a screen, direct requests and read-backs for anything without. It films the proof, writes a proof report, and returns a verdict. Passing unit and e2e tests are not verification; this is the gate between "tests are green" and "feature is done".

## When it runs

The `task` workflow runs it as the `qa` stage inside a loop after the review loop, up to four rounds: on FAIL, `fix` repairs the reported bugs and qa runs again. A BLOCKED verdict skips commit and PR. `quick` has no qa stage.

Standalone, invoke it with `/yok:qa` in Claude Code or `$qa` in Codex, or say "verify this" or "ready to ship".

## What it does

- Reads `verification/run-log.jsonl`, the ledger of past rounds, and derives which scenarios to drive again from what changed in git since each was proven.
- Brings up the stack from the config's `environments` entry (the `environment` variable picks it), then seeds fixtures through the product's own API.
- Drives every UI behaviour with `agent-browser`, confirming each frame before it counts as evidence, and replays each flow on a phone. Proves screenless behaviour with the request, the response and a read-back of stored state.
- Runs an adversarial pass over the feature and over its own gaps.
- Builds one video per scenario with `scripts/report-media.ts` (needs `ffmpeg`), writes `verification/proof-report.html` from the template, and cleans up what it started. A FAIL with rounds left defers the report and leaves the stack up for the fix round.

## Inputs and outputs

Reads `workspace`, `task`, `round` and `rounds`, and whatever artifacts exist: `design.md`, `plan.md`, the phase files, `implementation.md` and the coder's `phase-N-e2e.json` reports. Every requirement the docs list must appear in the report's coverage table.

Produces the `proof-report` artifact, `.yok/RUN_NAME/artifacts/verification/proof-report.html`, with videos and screenshots beside it. The stage output is JSON checked against `qa.output.v1` in `scripts/qa.ts`: `status` (PASS, PARTIAL, FAIL or BLOCKED), `reason`, `report`, `gaps[]` and `bugs[]`. Each bug is a fix request (`id`, `summary`, `trigger`, `hint`, and `file` when traced), and the fix round hands the list to the `fix` stage as `fixes`; `askUser: true` marks a product question for the user.

## Files

- `SKILL.md`: the stage contract, the return contract and steps 0 to 7.
- `references/stack-up.md`: bringing up and tearing down the environment entry.
- `references/driving-the-browser.md`, `headless-verification.md`, `visual-verification.md`: how to drive, prove and read the frames.
- `references/writing-the-report.md` and `proof-report-template.html`: the report's field contract and the page it fills.
- `scripts/qa.ts`: the output schema, the report's `visualMatch` schema, and the `design-coverage` verifier, which rejects a PASS report that compares no scenario against a frame the plan builds. `scripts/report-media.ts`: builds the videos and inlines media into the report. Both have tests beside them.
