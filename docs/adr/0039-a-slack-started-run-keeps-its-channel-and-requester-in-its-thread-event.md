---
status: active
date: 2026-11-05
source: docs/prd-slack-tag-the-requester.md
tags: [orchestrate-script, notifier, event-store, sdk]
---

# A Slack-started run keeps its channel and requester in its thread event, and the notifier reads them from state

## Context and Problem Statement

The server lays the Slack thread's `SLACK_CHANNEL_ID`, `YOK_SLACK_THREAD` and `SLACK_MEMBER_ID` over the project env only at a run's first launch. `init` already stores the thread ts as `notification.thread.started`, and the notifier reads it from state, but it read the channel and the member to tag from its session's env. A model switch, a context `new` or `compact`, `yok resume` and `yok retry` rebuild that env from the project config, so from the first relaunch the run posted its thread ts into the `.env` channel and tagged the configured member instead of whoever typed the command.

## Considered Options

- Store the thread's channel and the requester beside the thread id in the `notification.thread.started` payload, and have the notifier take them from state over its env
- Save the thread on the registry run record and lay it over the env at every session launch, with `sessionEnv` taking it as a required argument
- Carry the three keys forward from the replaced session's own env into each relaunch

## Decision Outcome

The event payload. `init` runs once per run, in the first session, whose env the server built with the thread, so it records `channel` and `user` once and every later post reads them from state: no launch site has to pass anything, and a launch path added later needs no change. A bad value fails only that run's event, where a registry field fails every registry read for every run. The registry option was built first and replaced after review for those reasons. This amends ADR 0034, whose thread event now carries two optional fields. `init` takes `user` from `SLACK_MEMBER_ID`, so a mention with no user id records the env's member at the run's start. `SLACK_BOT_TOKEN` stays in env.

## Consequences

A run started before this change has no `channel` or `user` in its thread event and keeps reading them from env. No registry or launch change is involved, so an older yok binary still reads the registry and every run; it does not know the two fields, so its notifier goes back to the env's channel and member.
