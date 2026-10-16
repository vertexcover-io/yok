# orchestrate in Claude Code

Read this when you are Claude Code. It names the tools that SKILL.md describes by what they do.

- **Asking the user:** use `AskUserQuestion`. Never end your turn with a question in plain text,
  except for a stage's approval after `yok orchestrate await-approval`: then end the turn with
  one line saying how to approve, so the viewer's comments can reach you.
- **Long commands:** an inline `exec` runs through the Bash tool with `timeout: 600000`. A
  `mode: background` command, or an inline one that timed out, runs with Bash's
  `run_in_background: true`. Claude Code sends a task-finished notice when it ends; wait for it.
- **Subagents:**
  - Start one with the `Agent` tool, `subagent_type: "general-purpose"` and
    `run_in_background: true`.
  - If the reply names a `tier`, look it up under `tiers.models` in the run's `state.json`.
    Set `model` to the family in its model id (one of `opus`, `sonnet`, `haiku`, `fable`;
    `claude-opus-5-5` means `opus`). Set `effort` to the tier's `effort` when it has one.
  - While it runs, your turn may end. Each message from it starts a new turn for you.
  - It sends its questions as messages. Reply with `SendMessage` to its name.
  - It is finished only when one of its messages carries a `YOK-RESULT` or `YOK-ERROR` line.
    An idle notice without that line means it is still working: wait.
- **Task list:** mirror nodes with `TaskCreate` and `TaskUpdate`, or `TodoWrite` where those are
  absent. Give each task `activeForm: "Running NODE_ID"`. Send each task call in the same message
  as a command you run anyway.
- **Resume:** a resumed or replaced session receives `/orchestrate --resume NAME` as its
  first message.
