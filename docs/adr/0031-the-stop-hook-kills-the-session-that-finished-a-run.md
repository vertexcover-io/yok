---
status: active
date: 2026-10-29
source: docs/prd-close-session-on-finish.md
tags: [orchestrate-script, harness-server-to-session, agent-plugin]
---

# The Stop hook kills the terminal of the session that finished a run, as its last step

## Context and Problem Statement

A run that ended left its Claude or Codex process and tmux session open forever, so every finished run left a session behind.

## Considered Options

- The Stop hook of the finishing turn kills the run's registered terminal as its last step
- `next`, when it records the finish, starts a detached helper that kills the terminal once the agent shows idle
- A helper the Stop hook starts types `/exit` at an empty input box

## Decision Outcome

Chosen: the Stop hook's kill, because the Stop is itself the end of the agent's turn, so nothing has to watch the screen or wait, and the kill needs no helper process, lock or log. Only the session that finished the run closes: one whose last `hooks.session-start.called` is older than the run's `workflow.completed` or `workflow.failed`, or which has none, so a session resumed after the finish stays open as a chat. The hook kills the terminal by its registered name on yok's tmux server, with the same `kill-pane` every agent provider's `stop` uses, never by typing `/exit`, which a dialog would swallow. The kill is the hook's last step, since it ends the agent and the hook with it.

## Consequences

A finishing turn that waits on an open question or permission prompt sends no Stop, so its session closes only once that is answered and the turn ends; a message typed during the finishing turn is lost with the session.
`yok resume` accepts a finished run and relaunches under the run's terminal name, which the registry keeps; a comment sent to a closed run waits for a resume (0004); a `blocked` run is live and never closes (0013).
