---
status: active
date: 2026-10-28
source: conversation with the user on 28 Oct 2026, after PR #24 (server-run)
tags: [harness-cli, cli-to-server]
---

# The CLI has one command tree; a global `--remote` flag aims it at the saved server, and the saved login is read only with that flag

## Context and Problem Statement

`yok remote run`, `remote project …`, `remote doctor` and `remote trigger …` re-declared the local commands with their own flags and printing, and made the same client calls. The only real differences were how the client was made, what `run` does around the call on a laptop, and `--project` being required away from a checkout. Two trees drift and double every test.

## Considered Options

- One tree with a global `--remote` flag parsed before the subcommand; `yok-remote` is `yok --remote`; `login` is top-level and remote-only; `remote status` folds into `server status --remote`
- Keep the `remote` tree and share the bodies through helpers
- Pick the server from the saved login whenever one exists, with no flag

## Decision Outcome

Chosen: the flag, because one body per command is the only option with nothing to keep in sync, and the flag keeps the choice visible on the command line, which the no-flag option loses: a saved login must never redirect a plain `yok run`. The root's `preAction` hook refuses the flag on a command that acts on this machine and refuses `login` without it, each with one fixed line that names the command and what to type instead.

## Consequences

`run`, `project`, `trigger`, `doctor`, `login`, `ls` and `server status` take `--remote`, read through `isRemote(command)` and `resolveClient(remote)` in `packages/cli/src/client.ts`; `--project` is required with it, except on `ls`, which lists every project and takes `--project` only as a filter (amended 2026-10-30); `run` then sends `interaction: false` by default, prints the id and view link, and neither attaches nor opens a browser. `server start` and `server stop` refuse the flag ("works only on the server's machine"); every other command refuses it ("works only on this machine"). The installer and the npm launcher put `--remote` in front of the arguments. A new command is local-only until it is added to the allowed set.
