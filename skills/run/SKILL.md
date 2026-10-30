---
name: run
description: >
  Start a yok run from inside this session: pick the workflow, build its inputs from what the
  user said, and launch `yok run`. Use when the user says "start a yok run", "run this through
  yok", "kick off the task workflow", "yok this", or asks to hand a task, bug, regression or
  skill request to yok. Not for driving a run that is already open.
allowed-tools: [AskUserQuestion, Bash, Read]
---

# Run

Launch a yok run for the user, from the session they are already in. The run gets its own
agent session; this one launches it and reports. `README.md` beside this file says the same
for people.

## 1. Find the workflow

`yok orchestrate workflows` lists every workflow as JSON: the ones yok ships, then the
project's own from the config's `workflowPath` folder. Each entry has its `name`, a
`description`, the `workflow` argument `yok run` takes, and the file's `path`. Run it first,
then settle which entry the user means:

- **A name** the user gave is the entry with that `name`.
- **A path, or a name ending in `.yaml` or `.yml`**, is a file in the project, relative to the
  repository root (`git rev-parse --show-toplevel`). It need not be listed, but it must exist;
  its `workflow` argument is that path.
- **No name** means match the request to each `description`. Ask the user only when two fit
  and the user gave no hint: one question, two options, the more thorough one first.

A name no entry has, or a file that is not there, ends the request: tell the user what you
looked for and the names the list holds, then stop.

Read the chosen file at its `path`. Its `inputs:` block lists every input, with each one's
`type`, `default` and `required`; a workflow without an `inputs:` block takes none. The step is
done when one entry is chosen and its file is read.

## 2. Build the inputs

Each key under the workflow's `inputs:` is a flag:

- `prompt`, when declared, is `--prompt`: the task in the user's words, whole, as the first
  message the agent gets. Build it from the conversation: what to do, where, and any
  constraint the user named. Keep it whole; a title loses the constraints.
- every other key is `--input KEY=VALUE`, one flag each. Pass a value when the user gave one;
  leave a key with a `default` out otherwise. A `required` key the user gave no value for is
  asked, in the same question as the workflow when there is one.

A workflow that declares no `prompt` gets no `--prompt`.

Policies are flags too: `--interaction false` when the user wants the run unattended (no stage
asks them anything). Add `--name NAME` when the user named the run.

The step is done when every value the user gave has its flag and the prompt, when there is
one, holds every constraint they named.

## 3. Launch

From the repository root:

```bash
yok run WORKFLOW --no-attach --prompt "PROMPT" --input KEY=VALUE
```

WORKFLOW is the entry's `workflow` argument.

Always pass `--no-attach`: the run lives in its own tmux session, and this session stays where
it is. Pass the prompt through a quoted heredoc when it holds quotes, backticks or `$`:

```bash
yok run task --no-attach --prompt "$(cat <<'PROMPT'
...
PROMPT
)"
```

`yok run` runs the doctor first. When it stops as BLOCKED, show the user the check that failed
and stop. Any other non-zero exit, from `yok` not found to a bad input or a git error, ends the
same way: show what it printed and stop. The user fixes it and asks again, so one request
starts at most one run.

The step is done when the command has printed three lines: the run id, the attach command and
the run's page URL.

## 4. Report

Reply with the three lines `yok run` printed, as printed, and nothing more. The command opens
the run's page in the browser on its own, and the attach command is how the user follows the
run from a terminal. This session does not follow the run.
