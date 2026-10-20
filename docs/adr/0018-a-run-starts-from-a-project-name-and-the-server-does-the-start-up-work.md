---
status: active
date: 2026-10-16
source: server-run.md (steps 1-3), .yok/server-run/artifacts/design.md
tags: [harness-server, harness-cli, cli-to-server]
---

# A run starts from a registered project's name; the server compiles, loads the env and runs the doctor

## Context and Problem Statement

`POST /runs` took absolute paths, a full env and resolved tiers that only a CLI standing in the checkout could build, so nothing off the server's machine could start a run.

## Considered Options

- A project name from `HOME/projects.yaml`, with the server doing the compile, env and doctor
- A checkout path on the server, with the server doing the compile, env and doctor
- A name or a path, with the CLI doing the compile, env and doctor and sending the result, as before

## Decision Outcome

Chosen: a project name with the server doing the start-up work, because a remote caller knows a name but not the server's folders, and one way to name a checkout keeps the project list the only record of what can run; a path in the body would give local and remote callers two contracts. The start-up work moves to the server because only the server has the checkout, its `.env` and the agent's tools, so its doctor checks the machine the run will use. `yok run` in a checkout that is not yet a project adds it under its folder's name; `project add` reports the doctor's FAIL rows without refusing, and a run on that project is refused until they pass.

## Consequences

The doctor's `process.env` fallback now reads the server's environment, so a key exported only in a developer's shell no longer satisfies it.
Tiers are merged on the server from the config and the compiled workflow (0009); the client sends none.
