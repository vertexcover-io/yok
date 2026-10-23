---
status: active
date: 2026-10-23
source: docs/prd-lost-compact-recovery.md
tags: [workflow-engine, harness-server, orchestrate-script]
---

# A context step whose action did not happen still ends `completed`, and every surface labels it skipped

## Context and Problem Statement

A compaction or new session that did not happen ended `completed` with `applied: false` in its output, and nothing read that field, so the viewer, status line and agent reported it as done. The PRD asks that it show as skipped, with its reason, everywhere run status is shown and in the next instruction the agent fetches.

## Considered Options

- Keep `completed` with `{ applied: false, reason }`, and have the viewer, the status line and the next `next` reply label it skipped
- End the node with status `skipped` and a new skip reason, exempting context steps from the dependency-skip rule

## Decision Outcome

Chosen: keep `completed` and label it, because a `skipped` node also skips every node that names it in `dependsOn` (`decideStart`, `next.ts:305`), and a lost compaction is no reason to skip the fix after it; an exemption would add a skip that does not skip to the engine's one skip rule. The guide's rule to record a passed-over node as `workflow.node.skipped` covers nodes the engine decided not to run, not a step that ran and whose action failed.

## Consequences

Readers learn of the skip through `readContextSkip` on the node's output (`ContextOutputSchema`), never from its status; a new surface that shows step status must call it.
