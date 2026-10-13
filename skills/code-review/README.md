# code-review

A deep review of one change that hunts for subtle bugs and for code that works but should have been written differently. Eight reviewer personas run in parallel, each on one axis; their reports are aggregated into one file, each finding is rated by how likely it is to fire, then the skill fixes every finding and records what it did.

## When it runs

Both shipped workflows run it as the stage right after `implement`. In `task` it is followed by the `qa` loop; in `quick` by `git-commit`. You can also invoke it yourself, and standalone it only runs when you ask:

- Claude Code: `/yok:code-review [--plan PATH] [--pr NUMBER] [--commits RANGE] [--output PATH]`
- Codex: `$code-review`

Scope, first match wins: `--pr` reviews the PR diff, `--commits` a range such as `HEAD~3..HEAD`, a run reviews its branch against the merge-base with the base branch, and with nothing it reviews the working tree.

## What it does

1. Preflight: pins the diff against the merge-base, reads the PR description when there is one, and commits any dirty tracked files as a WIP commit so reviewers can experiment and revert. An empty diff, a bad ref, a missing plan or a stale PR head stops the review here.
2. Dispatches eight sub-agents in one message, one per persona: Defects, Spec, Security, Testing, Reuse, Simplification, Efficiency, Altitude. Each gets its own persona file, the whole diff, and the repo's documented standards. All eight run on every review.
3. Aggregates the reports under one heading per axis, without reranking across axes, and gives a verdict: `REQUEST CHANGES`, `APPROVE WITH SUGGESTIONS`, or `APPROVE`. A rule the repo wrote down is a hard violation; a default from the persona files is a judgement call and cannot block alone.
4. Fixes every finding, one commit each, and records them under `Fixes applied`. Then runs typecheck, lint and tests once; a repair that breaks them is reverted and listed under `Left unfixed`.

Severity is set by the finding's trigger (who has to do what for it to fire), not by its worst case: Critical fires in normal use, High on a realistic action, Medium on an unusual sequence, Low needs an insider, a coincidence, or a bug that predates the change. A Low with a small fix is bumped to Medium so it gets closed; a Low never changes the verdict.

## Inputs and outputs

- Reads: the `workspace` from create-workspace, and optionally the `plan` and `design` artifacts for the Spec persona. Without them it infers intent from the commits, PR description and branch name.
- Produces: the `review` artifact at `.yok/RUN_NAME/artifacts/review.md`. Standalone it writes to `--output PATH`, else `.yok/review.md` (or `./REVIEW.md` with no `.yok/`) and prints the review inline. The stage output is the verdict on the first line, then one line per finding left unfixed.

## Files

- `SKILL.md`: the standards ladder, the severity rubric, scope rules, the four steps and the brief every persona receives.
- `references/persona-*.md`: one file per axis. Defects, spec, security and testing look for things that are wrong; reuse, simplification, efficiency and altitude look for code that could be better.
- `evals/`: eval cases with sample diffs and plans.
