---
status: active
date: 2026-11-20
source: .yok/sign-in-gate-2/artifacts/spec.md
tags: [harness-cli, harness-server, identity, cli-to-server]
---

# The CLI logs in by device code and holds a hashed, non-expiring token

## Context and Problem Statement

The CLI saved Caddy's shared password and sent it as a Basic header. With a per-person caller check (0045) it needs a credential that names one person, is made without typing a secret into a terminal, and can be taken back from one machine without touching the rest.

## Considered Options

- Device code, as `gh auth login` does: the CLI posts its hostname, shows a user code like `ABCD-EFGH`, the person approves it at `/device` with a signed-in cookie, and the CLI polls for the token once; the server keeps only the token's SHA-256 in `api_tokens`, and tokens never expire
- Tokens that expire, with a refresh step
- A token created in `/settings` and pasted into the terminal
- A localhost callback the CLI listens on

## Decision Outcome

Chosen: the device code with hashed, non-expiring tokens, because it works on a machine with no browser to call back to, the person approves a named machine on a page they are already signed in on, and nothing secret is typed. Hashing means a read of `yok.db` shows no usable token. A token never expires because CI and idle laptops would otherwise need a refresh flow; revoking one in `/settings`, or `yok logout` (`DELETE /api/tokens/current`), is the end. A token is `yok_` plus 32 random bytes in base64url, and `last_used_at` is written at most every 5 minutes. Pending device requests live in memory for 10 minutes, so a server restart drops them.

## Consequences

A leaked token works until revoked, and nothing but a refused sign-in (0046) or a revoke removes it. The CLI saves `YOK_SERVER_URL` and `YOK_SERVER_TOKEN` to `~/.yok/.env` with mode 0600 and removes the old password keys; the Basic-auth code is gone, and the old password is refused with a line telling the person to run `yok login --server URL`. CI holds a token created in `/settings` as the `YOK_TOKEN` secret.
