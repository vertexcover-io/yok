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

Chosen: `status: "blocked"` plus `blocker`, because the run's own status then says it cannot move on without someone, every reader gets it from `state.json` alone, and the fold keeps it consistent with the event that caused it. `agent.question.asked`, `agent.limit.waiting`, `agent.stuck` and `agent.stopped` open it. Three things close it: its own closing event (`agent.question.answered` for a question, `agent.limit.resumed` for a usage limit), `agent.resumed` with the same reason, and the workflow completing or failing. yok's PreToolUse `record-resumed` hook writes `agent.resumed { agent, sessionId, reason, tool }` when it sees the main agent's Bash call or file edit on a blocked run, naming the blocker's reason; on a running run it writes nothing. A sub-agent's call never writes it: a sub-agent shares the session id but can keep working while the main agent waits on the person. A call another PreToolUse guard (`record-guard`, `bash-antipatterns`) refuses still counts, since the agent making it is working again. No other event clears a blocker: step moves, `orchestrate.*` calls and tool-call log events change nothing about it. `agent.resumed` is enough because every workflow action the agent takes (`yok orchestrate next`, `exec`, `done`) is a Bash call, which the hook hears in both Claude and Codex, so it always comes before the workflow can move. It covers a usage limit, stuck turn or error the agent moved past without its own closing event, and a question the person dismissed without answering, since AskUserQuestion is not matched by `record-resumed` and so cannot close its own question.

## Consequences

Every check of "is the run still going?" must accept `blocked` as well as `running` (`next`, the Stop hook, the status line). A new reason needs its own opening event and a `details` shape in `BlockerSchema`. Since a `stuck` blocker tells the person to step in, the Stop hook never records `agent.stuck` for a turn that ends while Claude reports a background task running. Every kind of background task counts, so an agent that stops mid-step while a job that never ends (a dev server, a file watcher) runs in the background is neither sent back nor marked stuck. That miss is accepted: counting only helpers would mark an agent stuck while it waits on a background test run or build, which happens far more often.
