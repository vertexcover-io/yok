---
status: active
date: 2026-11-02
source: .yok/retry-failed-run/artifacts/design.md
tags: [workflow-engine, event-store, sdk, orchestrate-script, harness-server, harness-cli, cli-to-server]
---

# `yok retry` reopens a failed run's failed steps through events, so `failed` is no longer final

## Context and Problem Statement

A run that failed on a node was over for good: `decideNext` finishes any run that is not live, and `yok resume` only interrupts running steps, so a run that failed on qa or implement had to start over and redo every node that finished.

## Considered Options

- Reopen through events: `workflow.node.retried` for each failure that stopped its scope and each failed loop, switch or include above it, then `workflow.resumed`; a retried leaf folds to `interrupted`, a retried container back to `running` in place
- The same events, with retried containers folded to `interrupted` too
- Widen `yok resume` to reopen a failed run

## Decision Outcome

Chosen: reopen through events, with containers reopened in place, because it reruns only what failed. A container folded to `interrupted` would be started by `next` as a new node run, and a new loop run starts at pass 1 with no children, so every finished node in the loop would run again. A separate `yok retry` (and `POST /runs/:id/retry`) keeps `yok resume` meaning "relaunch as it stopped"; retry runs resume's guards, then the reopen, then resume's launch, for Claude Code and Codex alike.

Rules that come with it:

- A retried loop gets back its pass's `iteration.previous` on the event, taken from its last `workflow.node.iterated`, since the failure replaced the loop's output with its error.
- A `needs-input` failure is reopened only with `--answered`. With interaction off every agent error is `needs-input` (extends 0020), so refusing them all would block retry for nearly every unattended failure.
- A container that stopped on its own with nothing failed inside it (a loop out of passes, an `until` that threw) makes retry refuse, even beside a failed step, since the run would fail on it again. A container the engine stopped only because a node beside it failed is reopened with that node; the engine fails it with its own kind, `drained`, so retry reads why it stopped instead of guessing it from the generic `exception`. An `allowFailure` failure the run moved past is not reopened.
- `workflow.resumed` folds only `status` and `completedAt`; the blocker was already dropped when the run failed (0013). The Stop hook's finisher rule (0031) still holds: the retried session starts after the old `workflow.failed`.

## Consequences

`workflow.failed` can be followed by `workflow.resumed`, so every reader of run status must accept a failed run coming back.
An `always` node that already ran after the failure stays completed, and a second failure posts a second "Run failed" in the run's thread.
