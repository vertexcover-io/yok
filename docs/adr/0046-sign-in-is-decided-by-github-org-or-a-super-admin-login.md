---
status: active
date: 2026-11-20
source: .yok/sign-in-gate-2/artifacts/spec.md
tags: [harness-server, identity, github-connector]
---

# Who may sign in is decided at GitHub sign-in, by org membership or a super-admin login

## Context and Problem Statement

With Caddy's password gone (0045), a gated server needs its own rule for who may become a yok user. Anyone with a GitHub account can finish the OAuth flow, so the rule must run at sign-in, and the team already lives in a GitHub org.

## Considered Options

- Two `.env` lines read on each sign-in: `SUPER_ADMIN_LOGINS` (GitHub logins that get in with no org) and `GITHUB_ORGS` (org slugs, compared case-insensitively); the sign-in also asks for `read:org` and pages through `/user/orgs`
- A list of allowed GitHub logins only
- Users invited and approved by an admin in a yok page, or an admin username and password

## Decision Outcome

Chosen: org membership plus a super-admin list, because the team is already an org, so adding or removing a person is a GitHub change with no yok step, and the lists in `.env` need no new table or page and apply with no restart. The super-admin list lets the first person in before any org is set, and is the same split samskara uses. A refused sign-in revokes the GitHub token it was just given, creates no user and shows a 403 page. If that GitHub id already has a user, `users.access_revoked_at` is set and their CLI tokens are deleted, and a later successful sign-in clears it. A user with it set is refused by cookie, by token and in Slack. A gated server with neither key still starts, logs a warning, and `/login` names the missing key with a 503.

## Consequences

Access is decided only at sign-in, so a person removed from the org keeps their 30-day session cookie, and their tokens (which never expire, 0047), until they next try to sign in or someone revokes the tokens in `/settings`; cutting someone off earlier is out of scope. That `/user/orgs` lists private memberships only with `read:org` comes from GitHub's documentation and was not tested against GitHub. An org that restricts OAuth apps must approve this one, as 0041 already notes.
