---
name: orchestrate
description: >
  Runs a yok v2 workflow from inside the Claude Code or Codex session `yok run` launches.
  Not triggered by a user request — the yok server starts this skill directly as the
  session's first message, passing --workflow and --inputs.
---

# orchestrate

`yok run` launches this session with `YOK_RUN_ID` and `YOK_HOME` already set in its
environment, then sends this skill as the first message.

Read the reference for the agent you are before Step 1: `references/claude-code.md` in Claude
Code, `references/codex.md` in Codex. It names the tools this skill refers to by what they do:
asking the user, running a long command in the background, keeping a task list, and resuming.

## Arguments

`--workflow PATH --inputs JSON [--name NAME]`, or `--resume NAME`

With `--resume NAME`, skip Step 1 (no `init`): tell the user the run is resuming, then run
`yok orchestrate resume --run NAME`. A step the previous session left open has nobody working on
it any more; `resume` ends it as interrupted, so `next` hands it out again, and changes nothing
when no step is open. Run it only for steps no one is working on: a step it ends while still
running is handed out a second time. On a non-zero exit, show its error output and stop. Then go straight to
Step 2's loop with that `NAME`. The reference says how a resumed session receives it.

## Step 1: initialize the run

Use `--name` as the run name when supplied. Otherwise, derive a short kebab-case run name from
`inputs.prompt` when it is present, or from the workflow's name (the `--workflow` file's basename
without extension). Then run:

```
yok orchestrate init NAME
```

`init` reads `YOK_RUN_ID` from this session's environment, so no `--run-id` flag is needed.
Every later action on the run names it by `NAME` (`--run NAME`), not by its id. On a non-zero
exit, show the command's error output and stop — do not retry with a different name.

## Step 2: run the workflow

Tell the user the run folder `init` printed (`dir`). Then repeat:

1. Run `yok orchestrate next --run NAME`. It prints one JSON reply. Never run two `next`
   commands at the same time.
2. Act on the reply's `kind`. A `steps` reply lists every node that can start now. Start
   each entry in the order given, by its own `kind` below: exec entries and `mode: subagent`
   entries run in the background, and at most one entry, the last, is `mode: inline`, which
   you do yourself. Once every entry is started, go back to 1 when the inline entry is done,
   or right away when there is none. Each node is finished on its own: its `done` or `exec`
   result is all `next` needs, whatever the other nodes are doing.
   - `exec`: tell the user `▶ NODE_ID` (the entry's `nodeId`). Then run the entry's `command`
     exactly as printed.
     - `mode: inline`: it is the only node open. Run it in the foreground, with a 10-minute
       timeout. When it returns, tell the user `✓ NODE_ID completed` or
       `✗ NODE_ID failed: MESSAGE`, from the printed JSON's `status` and `error.message`. A
       failed node exits non-zero; that is expected, so go back to 1. If the command times
       out instead, no result was recorded and the node is still running: run the same
       `command` again as a background task (see the reference), then go back to 1.
     - `mode: background`: run it as a background task (see the reference) and go on with the
       next entry. When the task ends, log `✓` or `✗` the same way.
   - `stage` with `mode: inline`: tell the user `▶ NODE_ID (stage STAGE)`. Read the file at `skill`,
     then the file at `extension` when it is not null; where the extension conflicts with the skill,
     the extension wins. Follow the skill with the reply's `input` as its input, `variables` as the
     values of the variables the skill names, and `prompt` as extra instructions when present.
     The reply's `policies` lists the run's policies. Open `references/policies.md` and find
     each policy from the reply by its heading, `## NAME: VALUE`. Do what those entries say.
     A policy with no heading there changes nothing.
     When the skill needs one of its references, run
     `yok orchestrate skill ref STAGE.REF`. It needs no `--run`: it finds the run through
     `YOK_RUN_ID` and reads the config that run started with. Never open a reference file by
     its path, since that skips the project's changes to it. When the skill says to run one of
     its scripts, run `yok orchestrate skill run STAGE.REF ARGS`, where REF names the script
     and ARGS are the arguments the skill gives it; it needs no `--run` either, and runs the
     project's replacement when there is one. When the skill is done, run the reply's `done`
     command with `--output -`, `--summary`, and one `--artifact` for each artifact the skill
     names, and pass the output on stdin in a quoted heredoc. The output is JSON when the skill
     declares `outputs` (or the node an `output` schema), and plain text otherwise:

     ```bash
     yok orchestrate done NODE_RUN_ID --run NAME --summary "Chose two buttons for the header." \
       --artifact '{"type":"design","name":"design","path":"artifacts/design.md"}' \
       --output - <<'OUT'
     { "the": "skill's output" }
     OUT
     ```

     The summary is what the run's Slack thread shows when the node ends. Write one sentence, at
     most 200 characters, for a person who has not read the run. If the reply has a
     `summaryHint`, say what it asks for. If not, say what the node did and what it means, in
     plain words. Never paste a raw metric, JSON or the output, and name a verdict code only when
     the `summaryHint` asks for it. Put it in double quotes with no `"`, `$` or backtick inside.
     Each `--artifact` is one JSON object in single
     quotes: a file the skill wrote, `{"type":"TYPE","name":"NAME","path":"artifacts/PATH"}`, or
     a link, `{"type":"TYPE","name":"NAME","url":"https://…"}`. `type` says what it is, in
     lowercase words joined by `-`; `name` says which one, and is the type again when there is
     only one.

     If the skill could not finish, pass `--error -` instead, with the reason in the heredoc.
     Always pass the output in the quoted heredoc (`<<'OUT'`), never inside `'…'` on the command line:
     the shell leaves a quoted heredoc alone, while a single apostrophe in quoted text ends the
     quote and lets the rest run as shell. If `done --output` exits non-zero, read its JSON error.
     When `retryable` is `true`, fix the command input or each issue in `issues` and retry `done`
     with the same `nodeRunId`; the node is still running. An issue of kind `verifier` or
     `verifier-error` is a stage check that failed: read its `findings` or `message`, fix the
     work, and call `done` again. The third rejected `done` on a node fails it for good
     (`verify-exhausted`): log `✗` and go back to 1, since `next` decides whether that failure
     ends the run (a node with `allowFailure` lets it go on, and a node with `always` still
     runs after it). On any other error whose `retryable` is `false`, stop and report the error.
     This node is not over until its `done` reports completed, reports `verify-exhausted`, or
     you report an unrecoverable stage error with `done --error`. A `next` you run before then,
     because a subagent ended, leaves it open: carry on with it after acting on that reply. Log
     `✓` or `✗` from the printed JSON, then go back to 1.
   - `agent` with `mode: inline`: tell the user `▶ NODE_ID`. Do what `prompt` asks, with
     `input` as its data, and follow the reply's `policies` the same way as a stage. Then finish
     it with the reply's `done` command the same way as a stage.
   - `stage` or `agent` with `mode: subagent`: first check the node's skill. When the skill
     says how it uses sub-agents, run the node here as the `mode: inline` steps above say and
     tell the skill the node runs with `mode: subagent`; the skill starts the sub-agents it
     needs. Start it only when no inline node of yours is open, and finish it with its `done`
     before you take up any other inline node or end the turn; any other inline node waits until
     then. Otherwise tell the user `▶ NODE_ID (subagent)`. Start a background subagent on the
     reply's `tier` when present. Brief it to do the node as the
     `mode: inline` steps above say, with the reply's fields, and:
     - send you its questions and approval requests at the address your agent reference names,
       and wait, instead of asking the user or running `await-approval`;
     - end with a `YOK-RESULT` line and a JSON object of `output`, `summary` and `artifacts`, or
       a `YOK-ERROR` line and the reason, instead of running `done`;
     - run no `yok orchestrate` command but `skill ref`, `skill run`, `comments reply`, and
       `emit` for the skill's own events.

     Tell it the node runs with `mode: subagent`.

     Relay its questions to the user and send back the answers. Its messages reach you between
     your own tool calls, so a question waits only while one long command runs: relay each one
     at once, naming the node it came from, then carry on with the inline node. For an approval
     request, run
     `yok orchestrate await-approval NODE_RUN_ID --run NAME --file FILE`, end the turn, then send
     it each `[review]` message and the approval. While an inline node is open, finish it and its
     `done` first, since ending the turn would leave it half done. When it ends, run `done` with
     its result, or with `--error -` and its reason, then go back to 1: `next` may hand out more
     nodes while your inline node is still open, and you carry on with that node after acting on
     its reply. When `done` asks for a fix, send the issues back to it.
   - `context`: tell the user `↻ NODE_ID: ACTION` (the reply's `nodeId` and `action`, e.g.
     `↻ fresh: new`), then end the turn at once, without running any other command. The work
     starts once the turn is over: for `new` the yok replaces this session with a fresh one,
     and for `compact` it compacts this session. Either way the session then receives
     the skill's `--resume NAME` message and carries on. Codex has no context steps: the Stop
     hook completes the node as not applied and sends you back to `next`.
   - `model`: tell the user `⇄ NODE_ID: MODEL` (the reply's `nodeId` and `model`), then end the
     turn at once, without running any other command. Once the turn is over, yok
     restarts this same session on `model` (and `effort`, when set), keeping the conversation,
     and sends it the skill's `--resume NAME` message. The `next` that follows hands out the
     node, or reports it as failed if the switch failed. Codex runs never get a `model` reply.
   - `blocked`: the stage `stage` needs artifacts in `missing` that no finished node wrote.
     Tell the user which, and stop. Nodes started before it may still be open; once the
     artifacts exist, `yok orchestrate resume --run NAME` hands them out again.
   - `waiting`: nodes are still running, and no other node can start until one ends. `running`
     lists each one's `nodeRunId` and `nodeId`. The node you are working on yourself, when it is
     listed, is your own work: carry on with it, and never `resume` for it. Wait for any of your
     background tasks or subagents to end, finish it as above, then go back to 1. If any other
     entry in `running` has no background task or subagent working on it any more, tell the
     user, run `yok orchestrate resume --run NAME`, then go back to 1, which hands every open
     node out again; `resume` interrupts them all, so let any still working finish first. If
     `resume` does not list that `nodeRunId` under `interrupted` (a context step is never
     interrupted), stop and report it: nothing will end it.
   - `finished`: tell the user the run ended with `status`, then stop.
3. Mirror each `exec`, `stage` and `agent` entry of a `steps` reply into your task list (the
   reference names the tool), without spending a turn on it: make each task call in the same
   step as a command you run anyway. Create a task named `NODE_ID` beside the `▶` log, mark it
   in progress beside the node's first command, and mark it completed beside the first `next`
   after the node ends. On `✗`, leave it open with a note that it failed. After `--resume` the
   list starts empty.
4. On any non-zero exit from `next`, show its error output and stop.

`exec` and `done` record how each node ended. Never run `yok orchestrate emit` for a node, and
never edit `.yok/NAME/state.json`, `.yok/NAME/event.jsonl` or the yok `registry.json`
yourself: a hook refuses any tool call that writes, moves or deletes them, and its message names
the command to use instead. Reading them is fine.

When you need the user's input, ask the way the reference says. A Stop hook checks the run when
your turn ends, and a turn that ends with a node still open, or before `next`, is sent back to
you with the command you still owe. A node marked with `yok orchestrate await-approval` is the
exception: the turn ends, and the user's approval or comments start the next one.
