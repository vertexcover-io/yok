---
status: active
date: 2026-10-18
source: server-run.md (part 3, starting runs from Slack), .yok/server-run-task-2/artifacts/design.md
tags: [harness-server, chat-channels, subscribers]
---

# A run started from a chat thread reports into it through its own notifier, never from the server

## Context and Problem Statement

A run started by `/yok` in Slack must post its progress into the thread its command opened, while the notifier that posts progress today runs inside the run's session and opens its own thread in the project's `SLACK_CHANNEL_ID`.

## Considered Options

- The thread rides on the run: `POST /runs` takes `thread: { place, threadId, memberId? }`, the run record keeps it, init seeds `state.notification` with it and turns the notifier on, and every session of the run starts with the yok home's `SLACK_BOT_TOKEN` and `SLACK_CHANNEL_ID` set to the thread's channel
- The server posts progress: one Slack object in the server both receives commands and posts every run's notices, fed the run's events

## Decision Outcome

Chosen: the thread rides on the run, because the notifier keeps working when the server is down or restarted, and no route or event feed from runs to the server is needed (0006, 0007, 0011 hold unchanged). The server posting was rejected because every run would depend on a live server to report, and events are stored by the run's own processes, which never call the server.

## Consequences

A thread run's notifier is on whatever the project's config says, and its agent session can read the bot token in its env; `loadSessionEnv` must lay the thread's keys over the project env on every session restart.
