# code-review

A deep review of one change that hunts for subtle bugs and for code that works but should have been written differently. Five reviewer personas run in parallel, each on one axis; their reports are aggregated into one file, each finding is rated by how likely it is to fire, and the open ones become a fix list for the `fix` skill; code-review never edits code.

## When it runs

Both shipped workflows run it inside the `review-loop` right after `implement`: pass 1 reviews, and when it asks for changes, pass 2 compacts the session, runs the `fix` stage on the findings, and reviews only the fix commits, starting from the heads pass 1 recorded. In `task` it is followed by the `qa` loop; in `quick` by `git-commit`. You can also invoke it yourself, and standalone it only runs when you ask:

- Claude Code: `/yok:code-review [--plan PATH] [--pr NUMBER] [--commits RANGE] [--output PATH]`
- Codex: `$code-review`

Scope, first match wins: `--pr` reviews the PR diff, `--commits` a range such as `HEAD~3..HEAD`, a run reviews its branch against the merge-base with the base branch, and with nothing it reviews the working tree.

## What it does

1. Preflight: pins the diff against the merge-base, reads the PR description when there is one, and commits any dirty tracked files as a WIP commit so reviewers can experiment and revert. An empty diff, a bad ref, a missing plan or a stale PR head stops the review here.
2. Dispatches five sub-agents in one message, one per persona: Defects, Spec, Security, Testing, Simplify. Testing and Simplify run on the cheaper model. Each gets its own persona file, the whole diff, and the repo's documented standards. Simplify is skipped when the diff touches no code file; a skill's markdown and a workflow file count as code.
3. Aggregates the reports under one heading per axis, without reranking across axes, and gives a verdict: `CHANGES_REQUESTED` (a Medium-or-above finding is open) or `APPROVED`. An approval with findings the fixer left says how many and the worst.
4. Ends with the open Medium-and-above findings as a fix list: the run's JSON output, and standalone also `review-fixes.json`, for `/yok:fix`.

Severity is set by the finding's trigger (who has to do what for it to fire), not by its worst case: Critical fires in normal use, High on a realistic action, Medium on an unusual sequence, Low needs an insider, a coincidence, or a bug that predates the change. A Low with a small fix is bumped to Medium so it gets closed; a Low never changes the verdict.

## Inputs and outputs

- Reads: the `workspace` from create-workspace, and optionally the `plan` and `design` artifacts for the Spec persona. Without them it infers intent from the commits, PR description and branch name.
- Produces: the `review` artifact at `.yok/RUN_NAME/artifacts/review.md`. Standalone it writes to `--output PATH`, else `.yok/review.md` (or `./REVIEW.md` with no `.yok/`) and prints the review inline. The stage output is JSON checked against `review.output.v1` in `scripts/review.ts`: `verdict`, `report`, `reviewed` (the head it reviewed in each repo), and `findings[]`, the open Medium-and-above findings in the shared fix-request shape, each with `askUser: true` when its fix goes against the plan or needs a bigger change.

## Files

- `SKILL.md`: the standards ladder, the severity rubric, scope rules, the three steps, the later pass and the brief every persona receives.
- `references/persona-*.md`: one file per axis. Defects, spec, security and testing look for things that are wrong; simplify looks for code that could be better, against the `code-quality` skill.
- `evals/`: eval cases with sample diffs and plans.

## Upgrading a project that extends a persona

The `reuse`, `simplification`, `efficiency` and `altitude` personas are now one, `simplify`. A project whose `orchestrate.config.yaml` names one of the four old keys under `extensions.code-review.references` fails to compile with `code-review has no reference reuse`; move that extension to `simplify`.
