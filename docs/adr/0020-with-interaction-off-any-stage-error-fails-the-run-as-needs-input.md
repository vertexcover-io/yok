---
status: active
date: 2026-10-15
source: .yok/run-policies/artifacts/design.md
tags: [workflow-engine, orchestrate-script]
---

# With interaction off, any `done --error` fails the run as `needs-input`, even on an `allowFailure` node

## Context and Problem Statement

An unattended run must stop when a stage hits a question only a person can answer, even in a workflow that marks that stage `allowFailure: true`, or the run would build on an unanswered question.

## Considered Options

- With `interaction: false`, every `done --error`, and a node the Stop hook fails after its agent keeps stopping, records failure kind `needs-input`, which blocks its scope even under `allowFailure` (never for an `always` node); a container whose child needs input fails with the same kind
- A separate `done --blocked` flag that a stage uses only for unanswered questions
- Matching on stage names (ticket-fetcher, design, planning) in the engine

## Decision Outcome

Chosen: every error is `needs-input` when interaction is off, because in an unattended run any failure needs a person to step in, and it keeps the refusal message one command (`done --error`) for every skill, updated or not. A `--blocked` flag was rejected as a second failure path skills must remember; stage names were rejected because the engine knows no stage names (docs/guide/03-core-principles.md P8). `always` nodes keep `allowFailure`, so a crashing retro never turns a finished run into a failed one (ADR 0008).

## Consequences

A crash in an unattended run is labelled `needs-input` like an unanswered question. `needs-input` is a stored failure kind that `findBlockingFailure` treats specially.
