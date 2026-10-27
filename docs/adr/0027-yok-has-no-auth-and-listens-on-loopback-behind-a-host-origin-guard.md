---
status: active
date: 2026-10-27
source: server.md (sections 1 and 8, "Decision records"), .yok/server-run-architecture/artifacts/design.md (D3)
tags: [harness-server, harness-cli, cli-to-server]
---

# yok has no auth: one listener on 127.0.0.1 behind a Host/Origin guard, and a reverse proxy does https and the login

## Context and Problem Statement

ADR 0017 put an API key on every route but `/health` and kept the dashboard on a second port. Remote callers still needed a TLS proxy in front, the key needed rules to keep it out of `process.env` and every session's env, and the CLI changed behaviour silently when a remote URL was set. The server needs one way to be reached from its own machine and from another one.

## Considered Options

- One `Bun.serve` on 127.0.0.1 with no auth code: the API under `/api`, the dashboard on every other path, and a Host/Origin guard on every request that also accepts `SERVER_DOMAIN` from `HOME/.env`; a reverse proxy on the same machine (Caddy) does https and the login for remote callers
- Keep 0017's bearer key on every route, behind the same proxy
- Listen on a Unix socket in `HOME` that only this account can open, with the proxy running as this user

## Decision Outcome

Chosen: no auth in yok, loopback only, behind the guard, because the proxy already does https, certificate renewal and the login, so a key in yok repeated that check and needed its own code to stay out of agent sessions. The guard stops the one attacker a loopback port invites: a website open in a browser on the server machine, sending requests directly or through DNS rebinding, which arrive with a foreign `Host` or `Origin` and get 403. The socket was rejected for now because the proxy would have to run as this user; it stays the way out if the server machine becomes shared.

## Consequences

The design assumes a single-user server machine: any account on it can reach the port and start runs with this account's agent login. `Host` must be `localhost:PORT`, `127.0.0.1:PORT` or `SERVER_DOMAIN`, and `Origin` must be missing, `http://localhost:PORT`, `http://127.0.0.1:PORT` or `https://SERVER_DOMAIN`, so a wrong or missing `SERVER_DOMAIN` makes every request through the proxy a 403. Dashboard links start with `https://SERVER_DOMAIN`, else `http://localhost:PORT`. No yok route checks a key or a login; a client sends a Basic login only to the proxy. Each home still has its own server, found by its port file (0012). This supersedes ADR 0017.
