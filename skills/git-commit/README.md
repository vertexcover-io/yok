# git-commit

Turns a dirty working tree into a few commits a reviewer can read: one logical concern each, with a short conventional subject. In a pipeline run it first squashes the branch's checkpoint commits, then commits the same tree again cleanly.

## When it runs

Both shipped workflows run it as the `commit` stage: `task` after the qa loop (skipped when qa was BLOCKED), `quick` after code-review. `visual-pr` runs next and does the push.

Standalone, invoke it with `/yok:git-commit` in Claude Code or `$git-commit` in Codex, or ask to commit, split, squash or tidy your changes. It never pauses for approval: commits are local and easy to undo.

## What it does

- Decides which way in: a dirty tree (commit it, history untouched) or a branch to squash (a run, or "squash my commits").
- Squash path: finds the base, stops if the remote has commits this checkout lacks, resets the branch to its base with the working tree kept, and saves the undo ref `refs/yok/pre-squash/BRANCH`.
- Reads the status, diffs and recent log, and matches the repo's existing commit conventions.
- Groups changes by concern: feature plus its tests, refactors apart from features, config and dependency changes apart, lock file with its manifest. Splits a mixed file by hunk.
- Commits in order, checking `git diff --cached --stat` before each one. Subject only, at most 72 characters; a body only for a breaking change, a reason the diff cannot show, or a ticket trailer.
- After a squash, checks the new history holds everything the old one did, then reports the log, every file left out, and the undo command.

## Inputs and outputs

Reads `workspace` from the create-workspace stage and works once per repo in its `worktreeDir`. The repo's base commit comes from `.yok/RUN_NAME/state.json`. A caller that already squashed can pass `--working-commits PATH`.

Produces no artifact: the result is the commits on the branch. Untracked files that do not clearly belong, and generated files, stay out.

## Files

- `SKILL.md`: the stage contract and the full workflow.
- `references/hunk-staging.md`: how to stage part of a file with `git apply --cached`.
- `evals/`: an eval suite and the fixture script that builds a test repo.
