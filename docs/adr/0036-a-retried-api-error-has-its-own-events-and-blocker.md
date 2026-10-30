---
status: active
date: 2026-10-27
source: .yok/auto-resume-api-error/artifacts/design.md
tags: [workflow-engine, event-store, sdk]
---

# A retried API error has its own `agent.error.*` events and `api-error` blocker, apart from the usage-limit ones

## Context and Problem Statement

Claude's StopFailure errors `server_error` and `unknown` are now retried by the helper that already waits out a usage limit. The retry needs run events and a blocker reason, and the usage-limit ones (`agent.limit.reached`, `agent.limit.waiting`, `agent.limit.resumed`, blocker `usage-limit`) already have the same lifecycle.

## Considered Options

- New `agent.error.reached`, `agent.error.waiting` and `agent.error.resumed` events and an `api-error` blocker holding the error and the retry time
- Reuse `agent.limit.*` and `usage-limit`, with the real error name in the payload and `from: "backoff"` on `agent.limit.waiting`

## Decision Outcome

New events and blocker, because a server error is not a usage limit: reusing the limit events would make the run state, the status line and the runs page call a dropped connection a usage limit, and the Slack notifier's "Rate limit" notice, keyed on `agent.limit.waiting`, would fire for it. The one helper reads which event started it and keeps a separate in-a-row count per kind.

## Consequences

Every reader of blocker reasons handles `api-error`, and these events are stored in every run's event log from now on. Extends ADR 0013's list of blocker reasons and their closing events without changing its rule.
