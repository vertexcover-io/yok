---
status: active
date: 2026-10-16
source: server-run.md (steps 1-3), .yok/server-run/artifacts/design.md
tags: [harness-server, harness-cli, cli-to-server]
---

# The server listens on loopback HTTP and every route but /health requires an API key, even on loopback

## Context and Problem Statement

Callers off the server's machine (a laptop CLI, scripts, later Slack and a web UI) must reach the yok server, which listened only on a Unix socket in the yok home whose file permissions were its only access check.

## Considered Options

- One HTTP listener on 127.0.0.1 at the port in `HOME/server.port`, every route but `/health` checking a bearer `YOK_API_KEY` the server writes into `HOME/.env` on first start; remote callers reach it through a TLS proxy on the server's machine
- The same listener with the key required only when the server binds an address other than loopback
- Keep the Unix socket for local commands and add a TCP listener beside it

## Decision Outcome

Chosen: loopback HTTP with the key always required, because loopback TCP is open to every user on the machine, so dropping the socket without a key would let any local account start runs with this account's agent login; generating the key into the home keeps local use free of setup. Keeping the socket beside TCP was rejected because Bun binds only the socket when one `Bun.serve` is given both. `/health` stays open so `ensureServer` can poll a server that has not yet written its key.

## Consequences

Every client sends `Authorization: Bearer KEY`, and the key never enters `process.env` or a run's session env.
Each home still has its own server, now found by its port file (0012).
