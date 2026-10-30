---
status: active
date: 2026-10-29
source: docs/prd-slack-commands.md
tags: [harness-server, slack-hook, chat-dispatcher]
---

# Chat commands arrive as signed Slack mentions on one server route, and a platform-free dispatcher runs them

## Context and Problem Statement

People who request and review runs live in Slack, but starting a run or checking the server needs `yok --remote` in a terminal. Slack must reach the server, which sits behind Caddy's password and has no auth of its own (0027).

## Considered Options

- App mentions sent to `POST /api/hooks/slack`, verified by Slack's signature, with a dispatcher that knows no platform
- Slash commands
- Socket Mode, a persistent connection from the server to Slack
- A separate bot process that calls the API with the Caddy password

## Decision Outcome

App mentions on one signed route, because a mention is a real message the person authored with a thread of its own, which a slash command is not; Socket Mode and a second process both add a long-lived component the server does not have. The route's only gate is the signature plus one allowed channel id, so the channel's membership is the access list; Caddy exempts exactly that path from its password. The hook only verifies, filters and replies; one dispatcher maps words to yok commands, so another platform is one more hook.

## Consequences

Amends 0027: `/api/hooks/slack` skips the proxy's password and yok checks Slack's signature there itself, so that check must never be weakened. Who may drive yok is managed in Slack, not in yok's config.
