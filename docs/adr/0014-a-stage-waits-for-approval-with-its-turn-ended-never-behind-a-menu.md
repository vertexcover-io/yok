---
status: active
date: 2026-10-09
source: .yok/plan-approval-blocks-comments/artifacts/design.md
tags: [orchestrate-script, harness-server-to-session, agent-plugin]
---

# A stage waits for approval with its turn ended, never behind a menu, so viewer comments reach it

## Context and Problem Statement

The design and planning stages asked for approval with an `AskUserQuestion` menu. The server types viewer comments only into an empty input box (ADR 0004), and an open menu hides it, so comments waited unanswered until the user picked an option.

## Considered Options

- End the turn after `yok orchestrate await-approval` marks the node as waiting; the Stop hook lets that turn end
- Keep the menu, and answer open comments just before opening it
- Keep the menu, and have the server press Esc to close it before typing a comment
- End the turn in plain text and rely on the Stop hook's one-bounce limit

## Decision Outcome

Chosen: end the turn after `await-approval`, because it is the only option where a comment sent during review reaches the agent at once. Answering before the menu leaves later comments waiting; pressing Esc can cancel a choice the user is making; the bounce limit resets on every comment reply, so the agent is sent back after each one. The user approves with the viewer's Approve button, an `approve` comment sent through the existing comment flow, or by typing approve.

## Consequences

In a run, Claude and Codex stages ask for approval with `await-approval` and a one-line prompt, never a menu.
Approval typed in the terminal is free text, so the agent judges a vague reply.
