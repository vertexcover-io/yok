---
status: active
date: 2026-11-20
source: .yok/sign-in-gate-2/artifacts/spec.md
tags: [harness-server, identity, slack-hook, cli-to-server]
---

# yok checks the caller on every route of a gated server, and Caddy only does https

## Context and Problem Statement

A shared server sat behind one Caddy password that everyone typed and the CLI and GitHub Actions saved, while yok checked no one (0027). A leaked password gave every route to anyone and could not be taken from one person, and any member of the Slack channel could run any command.

## Considered Options

- One `requireCaller` middleware in `createRoot`, right after `hostGuard`, on only when `SERVER_DOMAIN` is set; the caller is a signed `yok_session` cookie or a CLI token sent as `Authorization: Bearer`
- Keep Caddy's shared `basic_auth` and only attribute runs (0040)
- Check inside `createApi`, route by route
- Let the proxy authenticate people (forward auth or an OAuth proxy) and trust a header yok reads

## Decision Outcome

Chosen: the middleware in `createRoot`, because the check is then per person, revocable, and the same for browsers, the CLI and CI, with no second login system in front. It sits outside `createApi` so Slack's in-memory client (0035) and the `createApi` tests keep working with no caller. It always works out the caller, and refuses only when gated, so a local server stays open: no login for `yok run`, the local browser or the CLI e2e tests. A test walks every route of `createRoot` with the gate on and asserts each route outside the open list refuses a bare request, so a route added later is gated by default.

## Consequences

Open without a caller: `/api/health`, `/login`, the GitHub OAuth routes, the device-login routes (0047) and `/api/hooks/slack`, whose gate is Slack's signature (0033). Refusals: a navigation redirects to `/login?next=…`, `/api/*` gets 401 JSON with code `unauthenticated`, dashboard data routes get 401 text, and the terminal websocket gets 401 before the upgrade (0043). A cookie caller on any method but GET or HEAD must send `Origin`; routes that mint or revoke credentials take a cookie only, except `DELETE /api/tokens/current`. The loopback listener and Host/Origin guard of 0027 stay; this supersedes the rest of 0027 (no auth in yok, a proxy does the login), which still assumes a single-user server machine.
