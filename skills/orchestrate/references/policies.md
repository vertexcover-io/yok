# Run policies

A policy is a rule that applies to the whole run. The `next` reply lists them under `policies`.

Each heading below is one policy and one value, written `## NAME: VALUE`. Follow every heading
that matches a policy in the reply. If a policy has no matching heading, it is the default and
there is nothing to do. Stage skills never mention policies; this file is the only place.

## interaction: false

No one will answer in this run.

- Never ask. The question tool is refused, and so is ending the turn to ask in plain text.
- Sort each open question:
  - An assumption has a sensible answer from the task or the code. Use it, and write it down
    where the stage's document lists assumptions. A stage with no document says it in its
    `--summary`.
  - A blocker needs information only a person has, or is a guess that is expensive to undo.
    Finish the node with `done NODE_RUN_ID --error -` and list the questions a person must
    answer, in under 500 characters. This fails the run.
- When `await-approval` prints `autoApproved: true`, the file is approved. Finish the stage at
  once; do not end the turn to wait.
