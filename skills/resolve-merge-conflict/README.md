# resolve-merge-conflict

Resolves git merge and rebase conflicts by recovering the intent behind each conflicting change before touching a hunk. A resolution that compiles but means the wrong thing is worse than none.

## When it runs

Not a stage of any shipped workflow. Invoke it with `/yok:resolve-merge-conflict` in Claude Code or `$resolve-merge-conflict` in Codex. It also triggers on its own when a merge, rebase, cherry-pick or stash pop has stopped with conflicts, or when you say an open PR has conflicts.

It handles conflicts only. Ordinary commits belong to `git-commit`.

## What it does

- For a PR, checks the branch out, fetches the base from the remote that owns the PR, and merges it. It rebases only when asked, and never touches a dirty working tree.
- Checks the incoming side is not a stale copy of its remote, and says so when it is.
- Reads commit messages, PRs and tickets to find why each side changed.
- Resolves each hunk keeping both intents where possible. Where they clash, the side matching the merge's goal wins and the trade-off is noted. It never aborts.
- Runs the project's typecheck, tests and format, reading the commands from `orchestrate.config.yaml` in a yok repo.
- Finishes the merge or rebase. It shows the resolution and asks before pushing or, where the project asks to be consulted, before committing.

The report names which side won each incompatible hunk and why, one line each.

## Files

- `SKILL.md`: the steps, the open-PR path, and the stale-base checks.
- `evals/`: eval fixtures.

Adapted from the `resolving-merge-conflicts` skill in mattpocock/skills (MIT).
