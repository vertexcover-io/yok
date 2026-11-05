# pr-reply

Posts the one comment a `pr-fix` run leaves on its pull request.

## When it runs

Last stage of the `pr-fix` workflow, marked `always`, so a failed run still says which step failed.

## Inputs and outputs

- Reads: `pr` (schema `pr-reply.input.v1`), the `pr-triage` work list and the `design` when they exist, and the run's state.
- Produces: one free-text comment on the pull request, linked as the `pr-comment` artifact.

## Files

- `SKILL.md`: the stage contract and its five steps.
- `scripts/reply.ts`: posts one free-text comment on the pull request and prints its URL.
