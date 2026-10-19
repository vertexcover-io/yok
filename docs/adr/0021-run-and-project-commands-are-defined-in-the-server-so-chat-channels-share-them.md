---
status: active
date: 2026-10-17
source: server-run.md (step 3), .yok/server-run-task/artifacts/design.md
tags: [harness-server, harness-cli, chat-channels]
---

# `yok run` and `yok project` keep their arguments and options in @yok/server, so a chat channel parses typed text with the CLI's own definitions

## Context and Problem Statement

A chat inbox (Slack, later Discord or Telegram) must turn a typed line such as `run task "fix the login bug" --project refrens` into a run, with the same flags and wording the CLI has. The commander definitions lived in @yok/cli, which @yok/server cannot import because the CLI depends on the server.

## Considered Options

- The commander definitions, without actions, in @yok/server; the CLI attaches its actions, and an in-process `runChannelCommand(text, source, client)` parses with them and calls the API through the typed client over `app.request`
- A plain data table of flags in @yok/server, built into commander by the CLI and parsed with node's `parseArgs` by the server
- A hand-written parser for the few flags a channel needs
- The same shared code behind a public `POST /commands` route

## Decision Outcome

Chosen: commander definitions in @yok/server with an in-process channel function, because one parser means a flag added to `yok run` (a policy's `--NAME VALUE`, ADR 0019, included) reaches every channel with no channel code, while two parsers disagree on repeatable and negated flags and a hand parser falls behind the CLI. Every planned inbox runs inside the server process, so a public route would only add a contract to keep stable.

## Consequences

A new run or project flag, and the CLI's reply wording for run, project and doctor, live in `packages/server/src/commands.ts`; the channel forces `interaction: false` (ADR 0020).
This narrows guide 03's P9 and CLAUDE.md's CLI rule: the CLI still parses, calls one route and prints, but its run and project definitions are shared with the channel.
