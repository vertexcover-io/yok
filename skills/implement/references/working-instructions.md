# Working instructions

Shared by the implement and fix stages. RUN is the run's name.

## Commands

Read the project's orchestrate config (`orchestrate.config.yaml` or `orchestrate.config.json`
at the repo root). Each package's `commands` holds its `test_all`, `test_file`, `typecheck` and
`lint`; use the packages that own the files you change. A missing config or a declared command
that cannot run is a blocker. An omitted command is `NOT_APPLICABLE`, with a reason. The run's
baseline, when there is one, is `.yok/RUN/artifacts/baseline.json`; use it to tell an existing
failure from a regression.

Load `code-quality` before edits and `tdd` before changing code.

## Push

In a run, push each repo's branch. The stage is done only when every repo has no dirty tracked
file and `HEAD` equals `origin/BRANCH`. Outside a run, never push: say what is ready to push and
let the user do it. Never force-push; when the remote holds commits this checkout
lacks, finish the stage with `--error -` naming them.
