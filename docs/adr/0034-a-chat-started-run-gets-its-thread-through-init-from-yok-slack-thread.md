---
status: active
date: 2026-10-29
source: docs/prd-slack-commands.md
tags: [harness-server, orchestrate-script, notifier, event-store]
---

# A chat-started run gets its Slack thread from `YOK_SLACK_THREAD`, recorded by `init` before `workflow.started`

## Context and Problem Statement

A run started from Slack must post every update in the thread under the person's message. The notifier keeps its thread in state as `notification.threadId`, but the run folder only exists after `orchestrate init`, and `init`'s `workflow.started` is the notifier's first post.

## Considered Options

- The server sets `YOK_SLACK_THREAD` on the agent session; `init` records `notification.thread.started` between creating the state and `workflow.started`
- An optional thread field on the registry's run record that `init` reads
- The server records the thread event after `init`

## Decision Outcome

The env var read by `init`, because it changes no schema (the PRD keeps the run and registry schemas fixed) and leaves the notifier's code untouched, while still storing the thread before the first post; writing after `init` races the detached notifier and can split a run across two threads. The thread event stores no channel, so a Slack start is refused when the project's notifier posts to a channel other than the one the command came from.

## Consequences

`init` now honours `YOK_SLACK_THREAD`; a session env that carries it by mistake would thread a run's updates under that message. Moving the thread onto the run record later means a registry schema change.
