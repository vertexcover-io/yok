---
status: active
date: 2026-11-04
source: docs/prd-slack-tag-the-requester.md
tags: [harness-server, orchestrate-script, notifier, sdk, harness-server-to-session]
---

# A Slack-started run keeps its thread on its registry record, and every session launch lays it over the env

## Context and Problem Statement

The server laid the Slack thread's `SLACK_CHANNEL_ID`, `YOK_SLACK_THREAD` and `SLACK_MEMBER_ID` over the project env only at a run's first launch. A model switch, a context `new` or `compact`, `yok resume` and `yok retry` rebuild the env from the project config, and tmux's `respawn-pane -e` then resets the requester and channel to the `.env` values, so from the first relaunch the run tags the configured member instead of whoever typed the command.

## Considered Options

- Save the thread (channel, thread ts, requester's Slack user id) as an optional `thread` field on the registry run record, and make `sessionEnv` take it as a required argument at every launch
- Carry the three keys forward from the replaced session's own env into each relaunch
- Lay the overlay at each launch site separately

## Decision Outcome

The registry field with a required `sessionEnv` argument, because only the registry record reaches `yok resume` and `yok retry`, which start from the CLI's env and never had the keys; carrying them forward from the old session covers only the in-session relaunches. A required argument makes the compiler stop any launch site, present or future, from leaving the thread out, which separate per-site overlays cannot. This amends ADR 0034: `init` still reads the thread ts from `YOK_SLACK_THREAD`, but the registry now carries the thread too.

## Consequences

Every run started from Slack with its notifier on writes `thread` to `registry.json`, and the run schema is strict, so removing the field later needs a registry migration. A new way to launch a run's session must pass the run's `thread` to `sessionEnv`.
