# retro

Audits a finished `yok run` and reports the defects in yok itself that the run exposed. It reads the run's session transcripts, not the feature's code, and writes one ranked report for the people who build yok.

## When it runs

Last stage of the `task` workflow, after `visual-pr`. It runs even when an earlier stage failed, and its own failure never changes the run's status. The `quick` workflow does not run it.

You can also invoke it yourself with `/yok:retro` in Claude Code or `$retro` in Codex, with a run or a transcript path.

## What it does

- Dispatches the audit to a fresh sub-agent, so the auditor does not inherit the run's own reasoning and reads a transcript that is complete.
- The sub-agent runs the `retro` script's `extract`, which turns the run's transcripts into a handful of small files per session.
- Runs the detectors and walks from `references/audit-method.md`, then classifies each issue by class, fix type and severity.
- Cites every claim as a transcript line, which the script's `cite` command prints. Secrets are masked and never quoted.
- Writes `.yok/RUN/artifacts/retro.md` (or `retro.md` in the current directory when given a bare transcript) and reports `N major, M minor`.

## Inputs and outputs

Reads nothing from earlier stages. It takes the run's `event.jsonl` and `state.json`, the session transcripts they point to, the project repo and the PR when those exist. Produces the `retro` artifact, `artifacts/retro.md`.

## Files

- `SKILL.md`: the stage contract and the brief the dispatching session gives the sub-agent.
- `references/audit-method.md`: the auditor's full method, from safety rules through extraction, detectors, classification and the report format.
- `references/transcript-schema.md`: the transcript record shape and the hand-written queries the method sometimes needs.
- `scripts/retro.ts`: the `extract` and `cite` commands.
- `scripts/transcript.ts`: transcript parsing shared by the script.
- `scripts/*.test.ts`, `evals/`: tests and eval fixtures.
