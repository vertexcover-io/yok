---
status: active
date: 2026-10-21
source: .yok/parallel-nodes-design/artifacts/design.md
tags: [workflow-engine, shipped-workflows]
---

# A node with no `dependsOn` waits for the node before it, but is not skipped with it

## Context and Problem Statement

Once nodes run as soon as their dependencies end, a node that names no `dependsOn` would start at once. The shipped review and QA loops rely on written order: `code-review` and `qa` name no dependency yet must run after `fix`, which is skipped on pass 1.

## Considered Options

- An order edge: the node waits for the node before it in run order to end, without inheriting its skip or reading its output
- A full implicit `dependsOn` on the node before it
- No implicit edge: an empty `dependsOn` is ready at once, and authors name every dependency

## Decision Outcome

Chosen: an order edge, because a full `dependsOn` passes a skip on, so `code-review` and `qa` would be skipped on pass 1 along with `fix`, and no implicit edge would make every workflow that relies on written order run its nodes together. The edge is taken from the dependency-sorted order, so a node that names a dependency written below it forms no cycle. Two nodes run side by side only when each names its dependency.

## Consequences

The compiled node carries the edge apart from `dependsOn`: readiness reads both, while the skip rule, `nodes.X` reads and the guaranteed-artifact check read `dependsOn` alone.
