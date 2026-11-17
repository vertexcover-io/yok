---
status: active
date: 2026-11-08
source: .yok/browser-terminal/artifacts/design.md
tags: [harness-server, harness-server-to-session, viewer]
---

# The browser terminal is a websocket route in the yok server that runs `tmux attach-session` in a Bun PTY, not a ttyd beside it

## Context and Problem Statement

A run on a remote server behind Caddy could only be watched or steered over SSH with `yok attach`, which works only on the server's machine (0030). People with the run's page open wanted to see the agent's screen and type into it there, on localhost and through `SERVER_DOMAIN`.

## Considered Options

- A websocket route in the yok server (`GET /api/runs/RUN_ID/terminal`) that runs the run pane's own `attachCommand()` in a PTY from `Bun.spawn({ terminal })`, with xterm.js in the run page
- A ttyd process per run (or one shared ttyd), reached through its own port and a Caddy route

## Decision Outcome

Chosen option: the websocket route in the yok server, because it keeps one compiled binary with nothing else to install or supervise (0010), and the upgrade passes the same Host/Origin guard (0027) and Caddy login (0040) as every other path, so it needs no new port, proxy route or auth. The server sends screen bytes as binary frames and the browser sends JSON text frames; a run with nothing to attach gets a `refused` frame and close 4001, since a browser cannot read a refused upgrade's body; the tmux client ending (Ctrl-\) closes with 4000; closing the socket kills only the attach process, never the run's session.

## Consequences

Anyone past Caddy's login, or any local process that reaches the loopback port, can type into a run's agent session, so 0027's single-user assumption now guards a shell; a terminal feature (read-only mode, per-user access) is built in this route, not by adding ttyd.
