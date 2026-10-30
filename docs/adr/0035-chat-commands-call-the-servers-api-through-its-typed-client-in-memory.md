---
status: active
date: 2026-10-29
source: docs/prd-slack-commands.md
tags: [harness-server, chat-dispatcher, cli-to-server]
---

# Chat commands call the server's own API through its typed client, in memory

## Context and Problem Statement

Each Slack command must do what the matching `yok --remote` command does. The project, doctor and trigger logic lives inside route handlers that take Hono's request context and return a response, so the dispatcher has no plain function to call.

## Considered Options

- The dispatcher uses `createYokClient` with a `send` that answers through the API app in memory
- Extract each handler's logic into Result-returning functions that the routes and the dispatcher both call

## Decision Outcome

The in-memory client, because every body schema, lock and error shape the API applies reaches Slack unchanged, with no handler rewritten, and the reply text comes from the same formatters the CLI uses, now in the server. `run` is the exception: it calls `startProjectRun` directly to pass the thread, and `runs`/`run status` read `listRunSummaries`, which has no route.

## Consequences

A new chat command is a client call plus a formatter; a new route needs a client method before chat can use it. The CLI's reply formatters live in `@yok/server`.
