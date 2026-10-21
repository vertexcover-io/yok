---
status: active
date: 2026-10-21
source: docs/2026-10-21-parallel-nodes-design.md
tags: [workflow-engine, orchestrate-script, agent-plugin]
---

# `next` hands out every ready node at once; only inline agent nodes, context steps and model switches wait

## Context and Problem Statement

`next` handed out one leaf and answered `waiting` until it ended, so nodes that did not depend on each other ran in sequence: a ten-minute subagent review held up a test run that only needed the plan.

## Considered Options

- One `next` starts every ready node and replies with a `steps` list, the single `exec`, `stage` and `agent` replies removed
- A separate scheduler beside the walk that decides what runs in parallel
- Keep the single replies and add a list reply beside them

## Decision Outcome

Chosen: one `steps` list from the existing walk, because the walk already owns the skip, fail and loop rules a scheduler would have to copy, and one reply shape is one loop for the skill. Exec, wait and subagent nodes run in the background beside each other and beside at most one inline agent node, which the session does itself; a context step or model switch goes out alone and only when no node is open, since it restarts the session; a run whose agent cannot run background work (Codex) gets one node per `next`.

## Consequences

Amends 0002 (the skill runs every leaf it is handed, not one) and 0009 (a model reply waits until nothing is open). The Stop hook and the question guard act on the open inline node, read from the agent mode recorded on `workflow.node.started`.
