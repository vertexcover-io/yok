---
signal: Use when a change makes an existing function, file or command do more than its name says
paths: ["packages/**/src/**"]
tags: [naming, refactor]
strength: default
---
# Rename a function, file or command in the same change that widens what it does

When you extend something to cover a new case, check that its name still describes the whole job. If it no longer does, rename it in the same change, and update its callers, tests and docs. A name that names only the old case sends the next reader looking in the wrong place.

**Occurrences:**
- 2026-10-27 · the `limit-wait` helper was extended to retry API errors and kept its name until the user asked for a more generic one

**Stale when:** this rule is folded into `docs/learnings/naming.md`.
