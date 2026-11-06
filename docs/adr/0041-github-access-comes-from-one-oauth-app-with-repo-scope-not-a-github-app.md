---
status: active
date: 2026-11-04
source: docs/prd-yok-identity.md, .yok/yok-identity-1/artifacts/design.md
tags: [harness-server, identity, github-connector]
---

# Signing in with GitHub grants yok the `repo` scope, through one OAuth app, not a GitHub App

## Context and Problem Statement

A run must push and open PRs as the person who started it, with no token pasted anywhere. The PRD chose a GitHub App so people could pick repos, and kept sign-in apart from the repo grant, but an App reaches only repos it is installed on, and installing it on an org needs an org admin.

## Considered Options

- One plain OAuth app and one step: Sign in with GitHub asks for `repo workflow read:user user:email` and stores the token on the person's GitHub account
- The same app in two steps: sign-in asks only for identity and keeps no token, then Connect GitHub asks for `repo`
- A GitHub App installed per account or org, with each person authorizing it

## Decision Outcome

Chosen: one OAuth app in one step, because nothing has to be installed and everyone who runs yok from Slack needs push access, so a separate Connect click bought nothing. The trades: the token reaches every repo the person can, not a chosen list; an org that restricts OAuth apps must approve this one once; and a yok user cannot exist without granting repo access. The stored GitHub account keeps its token as an optional field, so Disconnect removes only the token and keeps the account, and a later provider, or a separate Connect step, is one more entry in `accounts` without a migration.

## Consequences

Moving to a GitHub App later means a new app and every person signing in again. Disconnect revokes the token on GitHub; signing in again reconnects. Adding a scope later, as `workflow` was on 2026-11-06 when pushes that touched `.github/workflows` were refused, widens no stored token: every connected person signs in again to get it.
