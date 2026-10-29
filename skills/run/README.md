# run

Starts a yok run from inside a Claude Code or Codex session, so the user never leaves the chat to type `yok run`.

## When it runs

Invoke it with `/yok:run` in Claude Code or `$run` in Codex, or say "start a yok run", "run this through yok" or "yok this". It is not a pipeline stage.

## What it does

- Lists the workflows with `yok orchestrate workflows`: the ones yok ships and the project's own from the config's `workflowPath` folder, each with its description. A name the user gave picks that entry; a path picks a file in the project; no name picks by description, asking once only when two fit. A name not listed, or a file not there, stops the request.
- Reads the chosen file's `inputs:` block, so a new workflow or a new input needs no change here.
- Builds one flag per declared input: `--prompt` when the workflow declares `prompt`, `--input KEY=VALUE` for the rest the user gave a value for, plus `--interaction false` or `--name` when asked.
- Runs `yok run … --no-attach` from the repository root and stops on any non-zero exit, so one request starts at most one run.
- Reports the three lines `yok run` printed: the run id, the attach command and the run's page URL. Then stops.

## Files

- `SKILL.md`: how the workflow is found, how the inputs become flags, the launch command and the report.
- `evals/evals.json`: six evals, one per promise the skill makes.
