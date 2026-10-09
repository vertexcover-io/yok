---
status: active
date: 2026-10-09
source: .yok/runs-dashboard/artifacts/design.md
tags: [workflow-engine, event-store, sdk]
---

# A run waiting on the person is `status: "blocked"` in state.json, with a `blocker` folded from the agent events

## Context and Problem Statement

A run whose agent waits on the person (a question, a usage limit, a stuck or crashed agent) read `status: "running"`, so the runs page, status line and notifier could not tell it from a working run without each parsing `event.jsonl` themselves.

## Considered Options

- `status: "blocked"` plus a `blocker { reason, node?, since, details }` object, folded by built-in handlers
- A separate `attention` field beside an unchanged `status`
- Each reader derives it from `event.jsonl` on read

## Decision Outcome

Chosen: `status: "blocked"` plus `blocker`, because the run's own status then says it cannot move on without someone, every reader gets it from `state.json` alone, and the fold keeps it consistent with the event that caused it. `agent.question.asked`, `agent.limit.waiting`, `agent.stuck` and `agent.stopped` open it; the matching answer or resume, any `workflow.node.*` event, `orchestrate.exec`, `orchestrate.done` or a tool call other than AskUserQuestion close it; `orchestrate.next`, other hook events and subscriber events never do, since they follow an opening event at once. A tool call closes it because the agent is working again, which covers a usage limit, stuck turn or error the agent moved past without its own closing event, and a question the person declined.

## Consequences

Every check of "is the run still going?" must accept `blocked` as well as `running` (`next`, the Stop hook, the status line). A new reason needs its own opening event and a `details` shape in `BlockerSchema`. Since a `stuck` blocker tells the person to step in, the Stop hook never records `agent.stuck` for a turn that ends while Claude reports a background task running.
