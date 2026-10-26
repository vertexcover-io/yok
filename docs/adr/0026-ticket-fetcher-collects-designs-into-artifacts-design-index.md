---
status: active
date: 2026-10-23
source: docs/prd-design-reference-verification.md
tags: [ticket-fetcher-stage, design-stage, planning-stage, qa-stage, shipped-workflows]
---

# Ticket-fetcher collects a ticket's designs into `artifacts/design/`, indexed in one `INDEX.md` every later stage reads

## Context and Problem Statement

A UI ticket's mockups, screenshots, Figma frames and spec docs were downloaded and then ignored. Only planning's best-effort design-scout sub-agent wrote an index, to `.yok/RUN/design/`, a folder `done` cannot register, so planning, implement and qa usually saw no design.

## Considered Options

- Ticket-fetcher copies the designs into `.yok/RUN/artifacts/design/` and writes `INDEX.md` there, registered as the optional `design-refs` artifact
- Planning's design scout keeps collecting into `.yok/RUN/design/`, found by convention
- The design stage collects the designs when it first reads the ticket

## Decision Outcome

Chosen: ticket-fetcher writes `artifacts/design/INDEX.md`, because it already holds the tracker credentials and the downloaded files, and `done` registers only files inside `artifacts/`. Every stage then finds the designs at one registered path. The index's columns are `Screen | Local file | Width | Source | Source of truth for`; ticket-fetcher fills file, width and source, and the design stage names the screens.

## Consequences

Planning's design-scout brief is gone, and a stage that needs designs reads `design/INDEX.md` and consumes `design-refs` as optional. Changing the folder or the columns means changing ticket-fetcher, design, planning, implement, qa and both coverage verifiers together.
