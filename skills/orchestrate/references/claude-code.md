# orchestrate in Claude Code

Read this when you are Claude Code. It names the tools that SKILL.md describes by what they do.

- **Asking the user:** use `AskUserQuestion`. Never end your turn with a question in plain text,
  except for a stage's approval after `yok orchestrate await-approval`: then end the turn with
  one line saying how to approve, so the viewer's comments can reach you.
- **Long commands:** an inline `exec` runs through the Bash tool with `timeout: 600000`. A
  `mode: background` command, or an inline one that timed out, runs with Bash's
  `run_in_background: true`. Claude Code sends a task-finished notice when it ends; wait for it.
- **Subagents:** start one with the `Agent` tool: `subagent_type: "general-purpose"`,
  `run_in_background: true`, `model` set to the family in the reply's model id (`opus` for
  `claude-opus-5-5`; one of `opus`, `sonnet`, `haiku`, `fable`), and `effort` set to the reply's
  `effort`. Its questions and its report arrive as messages from it, and an idle notice follows
  each of its turns. It has finished only when a message or idle notice from it carries the
  `YOK-RESULT` or `YOK-ERROR` line; on any other, keep waiting. Answer it with `SendMessage` to
  its name. A running subagent lets your turn end; its next message starts the next one.
- **Task list:** mirror nodes with `TaskCreate` and `TaskUpdate`, or `TodoWrite` where those are
  absent. Give each task `activeForm: "Running NODE_ID"`. Send each task call in the same message
  as a command you run anyway.
- **Resume:** a resumed or replaced session receives `/orchestrate --resume NAME` as its
  first message.
