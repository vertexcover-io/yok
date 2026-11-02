---
signal: Use when pushing a new commit, or force-pushing, to a branch that has an open PR
paths: ["**"]
tags: [git, pr]
strength: hard-rule
---
# After pushing to a branch with an open PR, run the pr skill to update the PR description

A push changes what the PR holds, so its description goes stale: a squash, an amend or a new
commit can drop or add whole sections. After every push to a branch with an open PR, run the `pr`
skill to rewrite the description so it matches what is on the branch now.

**Occurrences:**
- 2026-10-29 · squashed and force-pushed PR #47; its description still described the tmux attach step that the push had removed

**Stale when:** the `pr` skill is no longer in the skill list, or a hook updates the PR description on push.
