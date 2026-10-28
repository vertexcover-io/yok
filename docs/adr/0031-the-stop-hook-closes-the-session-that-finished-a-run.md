---
status: active
date: 2026-10-28
source: docs/prd-close-session-on-finish.md
tags: [orchestrate-script, harness-server-to-session, agent-plugin]
---

# The Stop hook closes the agent session that finished a run, through a detached helper

## Context and Problem Statement

A run that ended left its Claude or Codex process and tmux session open forever, so every finished run left a session behind.

## Considered Options

- The Stop hook starts a detached `yok orchestrate close` helper
- The orchestrate skill closes the session after `next` replies `finished`
- `next` kills the pane when it records the finish

## Decision Outcome

Chosen: the Stop hook's helper, because the hook fires on every turn end and reads the run state itself, so the close does not depend on the agent following a skill step, and `next` runs inside the pane, where killing it would cut off its own `finished` reply. Only the session that finished the run closes: one whose last `hooks.session-start.called` is older than the run's `workflow.completed` or `workflow.failed`, or which has none. A session resumed after the finish stays open as a chat.

## Consequences

`yok resume` accepts a finished run and relaunches under the run's terminal name, which the registry therefore keeps (the PRD's clearing of it was dropped in design).
A comment sent to a closed run waits for a resume (0004); a `blocked` run is live and never closes (0013).
