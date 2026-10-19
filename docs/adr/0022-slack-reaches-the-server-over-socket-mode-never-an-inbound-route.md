---
status: active
date: 2026-10-18
source: server-run.md (part 3, starting runs from Slack), .yok/server-run-task-2/artifacts/design.md
tags: [harness-server, chat-channels]
---

# Slack reaches the server over Socket Mode, an outgoing WebSocket, never through an inbound route

## Context and Problem Statement

`/yok` slash commands typed in Slack must reach a yok server that listens only on 127.0.0.1 and checks a bearer API key on every route but `/health` (0017); Slack cannot send that key.

## Considered Options

- Socket Mode: at start the server calls `apps.connections.open` with an app-level token (`SLACK_APP_TOKEN` in `HOME/.env`) and receives commands over the WebSocket it returns
- A public Request URL: Slack POSTs each command to an HTTPS route that checks Slack's signing secret instead of the API key, behind TLS or a reverse proxy

## Decision Outcome

Chosen: Socket Mode with no SDK, because it adds no inbound route, so 0017's key-on-every-route and loopback-only listener hold unchanged, and the server needs no public address, TLS or URL to keep current when it moves. A Request URL was rejected because it needs a route without the API key on a public listener. The connection uses `fetch` and Bun's built-in `WebSocket`, not Slack's SDKs, which Slack does not support on Bun and which would ship inside the compiled binary (0010).

## Consequences

The app cannot be listed on Slack's Marketplace, and each command reaches only one of the app's open sockets, so two servers sharing an app token split commands between them.
A later Discord or Telegram inbox follows the same rule: an outgoing connection, never a keyless route.
Any member of the workspace can type `/yok`, so it answers only in the channels listed in `SLACK_ALLOWED_CHANNELS` in the home's `.env`, and in none when the key is unset.
That list is the only gate: anyone who can post in a listed channel can start agent sessions as the server's OS user, add any repo or folder and purge any project, so list only private channels whose members you would trust with a shell on the server.
