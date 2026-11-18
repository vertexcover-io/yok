---
name: create-workspace
description: >
  Create the run's workspace before any code is written: the run's branch checked out in one repo
  (mono) or in each repo the request touches (multi). Runs as the pipeline's create-workspace stage.
mode: inline
allowed-tools: [Bash]
tier: fast
inputs:
  description: Spec name, and optionally the request text, base branch and repo list.
  schema: create-workspace.input.v1
outputs:
  description: Layout, branch, workspace folder and the repos in it.
  schema: create-workspace.output.v1
  module: scripts/workspace.ts
protocols: []
scopes: []
references:
  select-repos:
    path: references/select-repos.md
    description: How to choose which repos go in a multi-repo workspace.
  workspace:
    path: scripts/workspace.ts
    description: The script that reports the layout and creates, extends or removes the workspace.
---

# Create Workspace

Give the run its own branch and working folder, so no agent writes in the main checkout. The
workspace holds one git worktree per repo, each on the branch `SPEC_NAME`. With an `upstream`,
that branch starts from the upstream branch on origin and tracks it, so pushes land there.

The input is a `create-workspace.input.v1` object: `specName`, and optionally `request` (the text
of what the run should do), `baseBranch`, `upstream` (a branch on origin to start from and push
to) and `repos`.

This is a pipeline stage for yok. It reads its extension and reference, and makes the
worktrees with this skill's `workspace` script.

If `yok` is not found, stop and report that; do not create worktrees by hand.

## Steps

1. **Read the layout.** Run the `workspace` script with `info`. It prints `{ layout, packages }`.
2. **Choose the repos.**
   - The input has `repos`: use them as given, and skip `select-repos`.
   - `layout` is `mono`: skip this step. The workspace is the one repo.
   - `layout` is `multi`: read the `select-repos` reference and follow it to pick repo names
     from `packages`.
3. **Create the workspace with a 5-minute timeout.** Run the `workspace` script with
   `create SPEC_NAME --run SPEC_NAME`, adding `--base BASE_BRANCH` when the input has
   `baseBranch`, `--upstream UPSTREAM` when it has `upstream`, `--pr URL` when it has no
   `upstream` and its `request` holds a line `Pull request: URL` (the run then works on that pull
   request's own branch), and `--repos NAME1,NAME2` in multi layout. `--run SPEC_NAME` names the run, so
   its event log records the workspace; always pass it. `create` also runs the project's
   `workspace.setup`, which can take minutes, so run it through the Bash tool with an explicit
   `timeout: 300000` (5 minutes).
4. **Read the JSON report.** `create` prints it when it ends. If Bash moved `create` to the
   background, it is still running: wait for the task-finished notice and read the report from
   the task's output file, as the orchestrate reference for your agent says. Slow is not dead:
   never fail the node while it runs.
5. **Stop on a failed create.** If `create` exits non-zero, or any repo in its report has
   `status: "failed"`, report each failed repo's `name`, `error.kind` and `error.message`, plus
   anything on stderr, and stop. Change nothing: no retry, no cleanup. A person decides.

   The only clean retry is `remove SPEC_NAME --run SPEC_NAME`, then this skill again. Never use
   `add` to patch a failed create: the run has no record of the workspace, so later stages would
   not find it.
6. **Reply with the output.** Give the `create-workspace.output.v1` JSON, built from the report:

   ```json
   {
     "layout": "multi",
     "branch": "feat-x",
     "workspaceDir": "/abs/meta/.workspaces/feat-x",
     "repos": [{ "name": "api", "worktreeDir": "/abs/meta/.workspaces/feat-x/api" }]
   }
   ```

   `layout`, `branch` and `workspaceDir` come straight from the report; `repos` keeps each repo's
   `name` and `worktreeDir`.
