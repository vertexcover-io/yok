---
status: active
date: 2026-10-23
tags: [harness-server, sdk, triggers]
---

# The yok server fires cron triggers itself, from a 15-second tick over `triggers.json`; slept-through slots fire once, never over 6h late

## Context and Problem Statement

A workflow can declare a `trigger:` cron schedule and should run unattended at each slot, on a laptop that sleeps and a server that restarts.

## Considered Options

- The yok server stores the schedules in `YOK_HOME/triggers.json` and asks every 15 seconds which triggers are due
- The OS fires each trigger: one crontab or launchd entry per trigger that runs `yok trigger fire`

## Decision Outcome

Chosen: the server's tick, because it keeps one store on every platform and the tick reads the stored `nextFireAt`, so it decides what to do with slots it slept through: they collapse into one firing of the latest slot, and a slot more than 6h old is skipped, since a 9am digest is wanted once and not at 6pm. OS entries would fire while the server is down, but each platform needs its own installer and a second copy of every schedule kept in step with ours.

## Consequences

Triggers fire only while the server is up; keeping it up across reboots is a separate step. A trigger is stored under `{project, name}`, and a firing starts its run through `startProjectRun`, the start-up path `POST /api/runs` takes, so it gets the pull on a cloned project, the doctor and the policy merge, with `interaction: false`. A webhook trigger should reuse the store, the fire log and `startProjectRun` rather than add a second launcher.
