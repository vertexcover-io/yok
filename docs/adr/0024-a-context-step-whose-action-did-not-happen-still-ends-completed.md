---
status: active
date: 2026-10-23
source: docs/prd-lost-compact-recovery.md
tags: [workflow-engine, orchestrate-script]
---

# A context step whose action did not happen still ends `completed`, and no surface labels it

## Context and Problem Statement

A compaction or new session can fail to happen: Claude refuses it, never goes idle, or never takes the typed line. The step has to end somehow, and the steps after it have to decide whether to run.

## Considered Options

- End the node `completed` with `{ applied: false, reason }` in its output, and report it nowhere
- End it `completed` and label it skipped in the viewer, the status line and the next `next` reply
- End the node with status `skipped` and a new skip reason, exempting context steps from the dependency-skip rule

## Decision Outcome

Chosen: end it `completed` with `{ applied: false, reason }` and report it nowhere. A compaction that did not happen is not a problem anyone needs to act on: the next step runs in a fuller session, and Claude Code's auto-compact catches up later, so a label would only alarm. A `skipped` status would also skip every node that names it in `dependsOn` (`decideStart`, `next.ts:305`), and a lost compaction is no reason to skip the fix after it. The guide's rule to record a passed-over node as `workflow.node.skipped` covers nodes the engine decided not to run, not a step that ran and whose action failed.

## Consequences

The output keeps `applied: false` and its reason (`ContextOutputSchema`) for anyone reading the event log or the step's output; no surface derives a status from it. The one context-step failure that needs a person is a resume line Claude never takes, which ADR 0023 turns into a Slack notice.
