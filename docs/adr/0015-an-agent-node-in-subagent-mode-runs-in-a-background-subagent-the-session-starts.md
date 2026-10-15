---
status: active
date: 2026-10-13
source: .yok/subagent-node-mode/artifacts/design.md
tags: [workflow-engine, orchestrate-script, agent-plugin, sdk]
---

# An agent node set to `mode: subagent` runs in a background subagent the session starts, on its tier's model, with the session relaying its questions

## Context and Problem Statement

The orchestrate session ran every agent and stage node in its own context: the context filled up, every stage saw the run's reasoning, and a tier change restarted the session (ADR 0009). Workflow authors want a node to run apart from the session, on its own model.

## Considered Options

- The session starts a background subagent per node and relays its questions
- Keep every node inline and reject subagents for stages that ask the user
- yok launches a headless `claude -p` per node

## Decision Outcome

Chosen: a background subagent the session starts, because it is the only option that keeps the session's context small, runs the node on its tier's model without a restart, and still reaches the user: the subagent sends its questions or approvals to the session mid-run and the session answers, while the session alone runs `done`, which the Stop hook can see. A headless `claude -p` cannot reach the user. A subagent cannot start subagents, so a stage that starts its own (implement one per plan phase, code-review one per reviewer) stays inline, where the session already starts them. The reply names the node's yok tier, not a model, so the tier stays the one place a model is chosen; an agent that cannot start subagents on demand (Codex) runs every node inline. This amends ADR 0009: its live-session switch still holds for inline nodes, and its reason against subagents no longer applies.

## Consequences

The agent node's `mode`, the reply's `mode`/`tier`, the subagent's `YOK-RESULT`/`YOK-ERROR` report and the adapter's `subagents` flag are contracts; a stage that starts its own subagents loses them when set to `mode: subagent`.
A tier whose model has no Claude Code alias would run the subagent on the session's model without warning.
