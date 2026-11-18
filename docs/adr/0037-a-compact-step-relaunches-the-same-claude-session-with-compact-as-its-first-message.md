---
status: active
date: 2026-11-02
source: docs/prd-compact-by-relaunch.md
tags: [orchestrate-script, harness-server-to-session, agent-plugin]
---

# A compact step relaunches the same Claude session with `/compact` as its first message, instead of typing it

## Context and Problem Statement

yok typed `/compact` into Claude's input box (ADR 0024), and a popup, menu or draft over the box still swallowed it often enough that compactions silently never happened. The model switch already avoids typing by relaunching the session with its first message on the command line (ADR 0009).

## Considered Options

- Relaunch the same session in its pane with `claude --resume SESSION "/compact PROMPT"`, after waiting for Claude to go idle and logging any draft in its box
- Keep typing `/compact` at the input box, confirmed by the compaction's SessionStart (ADR 0024)
- Relaunch, and fall back to typing `/compact` when the relaunch fails

## Decision Outcome

Chosen: relaunch with `/compact` as the first message, because a command-line argument cannot land in a popup or be merged into a draft, and the session id stays the same, so nothing is linked or swapped. The SessionStart with source `resume` that the relaunch fires first is ignored; the one with source `compact` completes the node, as before. Unlike typing, a relaunch kills Claude, so it waits up to 30 seconds for Claude to show neither busy nor a menu, and drops (and logs) any draft in the box. A failed relaunch, refusal or timeout completes the node `applied: false` (ADR 0025) and the resume line is typed into the session in the pane; there is no typed fallback, which would bring back the path this replaces. Amends 0024: its rules for typing `/compact` no longer apply, and three paths now wait for idle (new session, model switch, compact); its resume-line rules stay.

## Consequences

A compact costs one Claude restart, and an unanswered menu or a turn still busy 30 seconds after the Stop leaves it not applied. The resume line after a compact is still typed under ADR 0024.
