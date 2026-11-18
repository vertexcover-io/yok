---
status: active
date: 2026-11-17
source: .yok/remote-resume-retry/artifacts/design.md
tags: [harness-server, harness-cli, cli-to-server, viewer]
---

# Resume and retry do their start-up work on the server and name the run in the request body

## Context and Problem Statement

`yok resume` and `yok retry` built the session env and ran the doctor in the CLI, then posted that env to `POST /runs/:id/resume|retry`, so only a CLI on the server's machine could bring a run back. A remote run fails as needs-input on any stage error (0020), and nobody could retry it from a laptop or its page.

## Considered Options

- The server does the start-up work, and `POST /runs/resume` and `POST /runs/retry` take the run in the body as `{ id }` or `{ project, name }`
- The server does the start-up work, and the routes keep `/runs/:id/…`; a remote name is first resolved by listing the project's runs
- The CLI keeps building the env and running the doctor and sends the env, which cannot work off the server's machine

## Decision Outcome

Chosen: the server does the start-up work and the body names the run, because only the server has the run's checkout, `.env` and tools, and a remote caller knows a run by project and name, not by id; resolving the name inside the route keeps every caller, the CLI here or remote and the run page, to one request. This extends 0018's start-up work to relaunches: the server builds the env with `loadEnv` (the builder `loadSessionEnv` wraps) from the run's recorded config and compiled workflow and runs `checkCheckout` over it. It amends 0038, whose route was `POST /runs/:id/retry` with a CLI-built env, and 0030's allowed set, which gains `resume` and `retry`.

## Consequences

The request body carries no env; only the run's checkout and config decide the env a resumed session gets.
A name resolves only inside a registered project, so a run whose checkout is no longer a project can be brought back only by id.
