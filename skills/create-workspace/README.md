# create-workspace

Gives a run its own branch and working folder before any code is written, so no agent writes in the main checkout. The workspace is one git worktree per repo, each on a branch named after the run.

## When it runs

Both shipped workflows run it as the second stage, right after `ticket-fetcher`. In `task` it is followed by `baseline`; in `quick` by `implement`. It is a pipeline stage, not something you invoke by hand.

## What it does

1. Runs `scripts/workspace.ts info`, which prints the layout (`mono` or `multi`) and the packages a workspace can hold, from `orchestrate.config.yaml`.
2. Picks the repos. A `mono` layout has one repo. In `multi` layout the stage follows `references/select-repos.md`: a repo the request names or describes is in, a borderline one is in, and with no request or no clear match every repo is in. An explicit `repos` list in the input wins.
3. Runs `workspace.ts create SPEC_NAME --run SPEC_NAME`, adding `--base BRANCH` when the input sets a base branch and `--repos NAME1,NAME2` in multi layout. The script fetches the base from origin, adds the worktrees, and runs the project's setup command in each.
4. If the script exits non-zero, the stage reports each failed repo with its error kind and message, retries nothing, and removes nothing. A person decides what to do.
5. Replies with the layout, branch, workspace folder and the repos in it.

## Inputs and outputs

- Reads: `specName`, and optionally `request`, `baseBranch` and `repos` (schema `create-workspace.input.v1`).
- Produces: a `create-workspace.output.v1` object with `layout`, `branch`, `workspaceDir` and `repos`, each repo with its `name` and `worktreeDir`. Later stages receive this as their `workspace` input. No artifact.

## Files

- `SKILL.md`: the stage contract and the five steps.
- `references/select-repos.md`: how to choose repos for a multi-repo workspace.
- `scripts/workspace.ts`: the script. Commands: `info`, `create BRANCH`, `add BRANCH --repos`, `remove BRANCH`. Flags: `--run NAME` or `--run-id ID`, `--repos A,B`, `--base BRANCH`, `--force` (remove with uncommitted files).
- `scripts/workspace.test.ts`, `scripts/workspace.e2e.test.ts`: unit and end-to-end tests.
