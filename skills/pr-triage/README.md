# pr-triage

Reads an open pull request and turns the run's prompt into the work list the rest of the run builds from.

## When it runs

First stage of the `pr-fix` workflow.

## Inputs and outputs

- Reads: `pr` (a number in the project's repo, or a URL) and `prompt` (schema `pr-triage.input.v1`).
- Produces: a `pr-triage.output.v1` object with `task`, `pr` (repo, number, URL, branch, base, head), `hasConflicts`, `items` and `leftOut`, also saved as the `pr-triage` artifact.

## Files

- `SKILL.md`: the stage contract and its five steps.
- `scripts/pr.ts`: reads the pull request through `gh` and prints its facts; holds the stage's schemas.
