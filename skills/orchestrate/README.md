# orchestrate

The skill that drives a `yok run`. It sits inside the agent session, asks the workflow engine for one step at a time, does that step, and reports back, until the run finishes.

## When it runs

Nobody types it. `yok run WORKFLOW --prompt "…"` starts a Claude Code or Codex session with `YOK_RUN_ID` and `YOK_HOME` set, then sends `/yok:orchestrate --workflow PATH --inputs JSON` (Codex: `$orchestrate …`) as the first message. A resumed or replaced session receives `--resume RUN_NAME` instead and skips the init step.

## What it does

- Names the run (`--name`, else derived from the prompt) and runs `yok orchestrate init RUN_NAME`, which creates `.yok/RUN_NAME/`. A derived name that is taken gets a suffix from the run id.
- Loops on `yok orchestrate next --run RUN_NAME`, which prints one JSON card. The agent never sees the whole workflow.
- Acts on the card's `kind`:
  - `exec`: runs the printed command, in the foreground with a 10-minute timeout, or as a background task when the card says so.
  - `stage`: reads the stage's SKILL.md (and the project's extension, which wins on conflict), follows it with the card's `input`, then closes the node with `yok orchestrate done NODE_RUN_ID --run RUN_NAME --output -` and a one-line `--summary`, plus one `--artifact` JSON object per file the skill wrote, such as `--artifact '{"type":"plan","name":"plan","path":"artifacts/plan.md"}'`. A failure goes through `--error -`.
  - `agent`: does what the card's `prompt` asks, then the same `done`.
  - `stage` or `agent` with `mode: subagent`: hands the node to a background subagent with a fixed brief, relays its questions and approval requests to the user, and closes the node with `done` from the subagent's report. The subagent runs on the reply's `tier`.
  - `context` and `model`: ends the turn so yok can compact, replace or restart the session; the session comes back with `--resume`.
  - `blocked`, `waiting`, `finished`: reports and waits or stops.
- Retries `done` when the engine rejects the output as fixable (a schema or verifier issue); the third rejection fails the node for good.
- Reads references and scripts through `yok orchestrate skill ref STAGE.REF` and `yok orchestrate skill run STAGE.REF ARGS`, so a project's overrides apply.
- Mirrors each node into the agent's task list. Never edits `state.json`, `event.jsonl` or the registry by hand; a hook refuses those writes.

## Files

- `SKILL.md`: the full loop and every card kind.
- `references/claude-code.md`: which Claude Code tools to use for asking, background commands, the task list and resume.
- `references/codex.md`: the same for Codex, with the parts that differ (no context or model steps, plain-text questions).
