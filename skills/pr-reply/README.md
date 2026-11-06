# pr-reply

Posts the one comment a `pr-fix` run leaves on its pull request: inside the review thread the run was asked from, else on the conversation. Its script also posts the run's page link when the run starts (`--started`), which pr-triage calls first.

## When it runs

Last stage of the `pr-fix` workflow, marked `always`, so a failed run still says which step failed.

## Inputs and outputs

- Reads: `pr` and `prompt` (schema `pr-reply.input.v1`), the `pr-triage` work list and the `design` when they exist, and the run's state.
- Produces: one free-text comment on the pull request, linked as the `pr-comment` artifact.

## Files

- `SKILL.md`: the stage contract and its five steps.
- `scripts/reply.ts`: posts one free-text comment on the pull request and prints its URL.
