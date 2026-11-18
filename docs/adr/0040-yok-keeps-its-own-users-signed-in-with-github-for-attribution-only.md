---
status: active
date: 2026-11-04
source: docs/prd-yok-identity.md, .yok/yok-identity-1/artifacts/design.md
tags: [harness-server, identity, slack-hook, chat-dispatcher, event-store]
---

# yok keeps its own users, signed in with GitHub, to attribute runs; Caddy's password still decides who gets in

## Context and Problem Statement

The server had one shared password and one `gh` login, so every PR a run opened was authored by the box owner and no run recorded who started it. ADR 0027 kept yok free of any login, and the first PRD draft only mapped a Slack member id straight to a GitHub token.

## Considered Options

- A yok user record (`HOME/users.json`, mode 0600) that people sign in to with GitHub, holding one entry per provider account in `accounts` (the account's id and login, plus its token while yok holds access), keyed by provider so another provider is one more key, with Slack linked to it and the run's owner stored as `user` on the registry run
- A Slack member id mapped straight to a GitHub token, with no yok user
- Replacing Caddy's basic auth with yok sessions

## Decision Outcome

Chosen: a yok user record, because every entry point (Slack now, the dashboard or a CLI later) resolves to the same person and their accounts, where a Slack-to-token map would be rebuilt for each new entry point. The session cookie and every OAuth `state` are HMAC-signed values with a purpose and an expiry. All the new pages (`/login`, `/auth/*`, `/link/*`, `/settings`) stay behind Caddy's password with no new exemption, so only the team can create users. Amends 0027: yok now keeps sessions, but they say who someone is and never whether they may reach the server.

## Consequences

`registry.json` runs carry a `source` (`api`, `slack` or `trigger`; absent on runs saved before it, which read as `api`) and an optional `user` (the yok user who started the run, absent when none did), which ADR 0034 had avoided. Every agent session's env goes through `sessionEnv`, which gives a Slack run its starter's isolated GitHub env, or an empty one when no yok user started it.
