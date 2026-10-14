---
status: active
date: 2026-10-13
source: .yok/review-loop/artifacts/design.md
tags: [workflow-engine, code-review-stage, fix-stage, shipped-workflows]
---

# code-review only reviews; a separate fix stage repairs, and the next pass reviews only the fix commits

## Context and Problem Statement

The code-review stage reviewed a change, fixed its own findings and recorded them in one session. Nobody reviewed those repairs, and the reviewer graded its own work.

## Considered Options

- A `review-loop` workflow node: pass 1 runs code-review; each later pass runs the `fix` stage on the previous pass's findings, then code-review on only the fix commits
- Keep the fix step inside the code-review stage, followed by a self re-review of the repair commits
- Split them in a run only, and keep the fix step for standalone `/code-review`

## Decision Outcome

Chosen: the `review-loop` node, because the fixer and the reviewer are then different nodes, the repair is checked by the same personas that raised each finding, on the fix commits alone so a later pass costs a fraction of the first, and the loop is an engine `loop` node (ADR 0002) rather than prose inside a skill. Standalone `/code-review` does the same and hands its list to `/yok:fix`, so there is one fixer everywhere.

## Consequences

code-review's run output is a contract (`review.output.v1`, its `findings[]` the fix list), and a `fix` stage takes `fixes` from any stage. A run pays one extra fix-and-review pass when the first review asks for changes.
