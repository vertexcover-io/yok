# Run policies

A `stage` or `agent` reply's `policies` holds the run's policy values. Follow the entry below
for each policy whose value is not its default.

## interaction: false

No one will answer in this run.

- Never ask. The question tool is refused, and so is ending the turn to ask in plain text.
- Sort each open question:
  - An assumption has a sensible answer from the task or the code. Use it and record it in the
    stage's `## Assumptions` section; a stage with no document states it in its `--summary`.
  - A blocker needs information only a person has, or is a guess that is expensive to undo.
    Finish the node with `done NODE_RUN_ID --error -` and list the questions a person must
    answer, in under 500 characters. This fails the run.
- When `await-approval` prints `autoApproved: true`, the file is approved. Finish the stage at
  once; do not end the turn to wait.
