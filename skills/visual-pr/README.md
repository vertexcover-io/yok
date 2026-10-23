# visual-pr

Creates or updates a pull request with a clear title, a visual outline of the change, and the validation evidence a reviewer needs. Inside a run it also pushes the branch.

## When it runs

The `pr` stage of both shipped workflows, `task` and `quick`, right after `git-commit`. In `task` it is skipped when QA could not verify the change.

Invoke it yourself with `/yok:visual-pr` in Claude Code or `$visual-pr` in Codex to raise a PR or improve an existing description. Outside a run it expects the branch to be pushed already.

## What it does

- In a run, pushes each repo's branch. If the commit stage squashed commits that were already on the remote, it force-pushes with a lease on the exact old tip; if the remote holds commits this checkout never had, it stops instead.
- Finds the open PR for the branch, or decides a new one is needed. Closed and merged PRs are not touched.
- Reads the full diff against the base, plus the task, plan and verification reports when they exist.
- Writes the body from the template: why the change, things to note, a change outline drawn as diff blocks, trees or diagrams, and validation results.
- Publishes with `gh pr create` or `gh pr edit`, then reads the PR back to confirm.
- Returns `created`, `updated` or `skipped` with the PR URL and number.

It does not merge PRs or change labels, reviewers or milestones.

## Inputs and outputs

Reads the `workspace` and `task` inputs, the optional `qa` input (the QA stage's output, which fills the body's QA section), and the optional `plan` and `proof-report` artifacts. Produces the optional `pr-description` artifact, `artifacts/pr-description.md` (one per repo when the workspace has several).

## Files

- `SKILL.md`: the stage contract, the push rules and the steps.
- `references/pr-description-template.md`: the sections a PR body carries.
- `references/pr-visual-guide.md`: how to draw the change outline.
- `evals/`: eval fixtures.
