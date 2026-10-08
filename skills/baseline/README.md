# baseline

Records how the project's checks stand before any code changes. It runs the baseline commands from `orchestrate.config.yaml` inside the run's workspace and saves their output as the run's `baseline` artifact, so later stages can tell a failure the change caused from one that was already there.

## When it runs

The `task` workflow runs it as the third stage, right after `create-workspace` and before `design`. The `quick` workflow skips it. It is a pipeline stage, not something you invoke by hand.

## What it does

1. Runs `scripts/baseline.ts` with `--run RUN_NAME`, adding `--packages NAME1,NAME2` when the stage input names packages. With no packages named, every package is baselined.
2. The script finds the run's workspace, runs the workspace-level `baseline` command and each package's `commands.baseline` command, and waits for all of them. This can take minutes.
3. It writes `artifacts/baseline.json` with each command's output and exit code, and prints `{ path, workspace, packages }`.
4. A red suite is not a failure of this stage: that is exactly what the baseline records. The stage names each command that exited non-zero.
5. A script that cannot start, a missing config, or a missing workspace makes the script exit non-zero. The stage stops and reports the error as printed; fixing the config is the person's call.

## Inputs and outputs

- Reads: the run (by name) and `orchestrate.config.yaml`, plus an optional `packages` list in the stage input.
- Produces: the `baseline` artifact at `artifacts/baseline.json`. When no package has a `baseline` command, or their worktrees are missing, the script prints `path: null` and the stage finishes without an artifact.

## Files

- `SKILL.md`: the stage contract and the four steps.
- `scripts/baseline.ts`: the script. Flags: `--run NAME` or `--run-id ID` (else `$YOK_RUN_ID`), `--packages A,B`, `--dir DIR`. A project can replace it through `extensions.baseline.references.script` with its own `main(argv)` module or a shell command in any language.
- `scripts/baseline.test.ts`, `scripts/baseline.e2e.test.ts`: unit and end-to-end tests.
- `evals/evals.json`: eval cases for the skill.
