---
status: active
date: 2026-10-29
source: docs/prd-close-session-on-finish.md
tags: [orchestrate-script, harness-server-to-session, agent-plugin]
---

# The `next` that ends a run closes its agent session, through a detached helper that kills the idle pane

## Context and Problem Statement

A run that ended left its Claude or Codex process and tmux session open forever, so every finished run left a session behind.

## Considered Options

- `next`, when it records `workflow.completed` or `workflow.failed`, starts a detached `yok orchestrate close` that kills the pane once the agent is idle
- The Stop hook starts the helper for the session that finished the run, which types `/exit`
- The orchestrate skill closes the session after `next` replies `finished`

## Decision Outcome

Chosen: `next` starts the helper, because `next` is the only place a run ends, so the call that writes the finish event closes the session exactly once, with no lock or close record: a later `next`, in a session resumed after the finish, finds the run already ended and starts nothing. The helper is detached because `next` usually runs inside the pane, where killing it at once would cut off its own `finished` reply. It closes the run's registered terminal on yok's tmux server, wherever that `next` ran, so a run ended by hand from another shell still closes its agent. It kills the terminal after two not-busy screen readings in a row, an open question or popup included, rather than typing `/exit`, which a popup would swallow; an agent still busy after 30 seconds is in use and stays open.

## Consequences

`yok resume` accepts a finished run and relaunches under the run's terminal name, which the registry therefore keeps; the learn offer stays quiet in the session that finished the run, since the kill would cut it off.
A comment sent to a closed run waits for a resume (0004); a `blocked` run is live and never closes (0013).
