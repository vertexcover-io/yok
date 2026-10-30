---
status: active
date: 2026-10-29
tags: [agent-plugin, harness-server-to-session]
---

# yok reads Claude's pane as one named state from its rules and ❯ lines, and a context-step line waits while Claude is busy

## Context and Problem Statement

In run ref-26119 every compact step failed with "Claude input box did not show": a strict rule pattern missed a named session's rule in a narrow pane. Eleven small helpers (rule and footer patterns, option numbers, box and busy checks) were combined differently by each caller, so one miss broke typing in ways no single test showed.

## Considered Options

- One pure `readClaudeScreen` that names the state (ready, busy, menu, popup, unknown) from the rules and the ❯ lines alone; every caller switches on it, and a context-step line waits while Claude is busy
- Keep 0024's helpers and loosen the rule pattern
- One `readClaudeScreen`, but keep 0024's typing at the box while Claude is busy

## Decision Outcome

Chosen: one `readClaudeScreen`, with busy meaning wait, because it is the only option where every caller acts on the same reading, and the reading uses only what every Claude screen draws. A rule is a ─ line with at most one title, never one with box corners or bars, so /config's search-box edge is not one. The lowest rule decides: a ❯ line under it is a menu (a permission prompt, the trust dialog, /config), whose keys belong to a person; a ❯ line just above it with a rule above that is the input box; anything else is a popup, closed with Escape at most 3 times; a blank pane is unknown. One exception covers the question dialog, which draws a rule above its last option: a numbered `❯ 1.` cursor just above the lowest rule is a menu too. The input box counts only with at most four status lines under it, so a box left in history above a popup is not typed into. Otherwise footer text and option numbers are not read: the permission prompt has no "Enter to" footer and the trust dialog has no numbers. Transcript lines that start with ❯ sit above the lowest rule, so they never count. A /compact or resume line now waits while Claude shows busy (at most 30 seconds, then the try gives up and logs the screen's last 15 lines), where 0024 typed at the box mid-turn: a context step starts once Claude's turn ends, so the wait is short, and one rule for every state is simpler than a busy exception. Review comments and `/rename` still type at an empty box while Claude works, since waiting would hold them for the whole turn.

## Consequences

Amends 0024: its footer-based box check and its typing while Claude is busy are replaced; its confirm-by-effect and Slack ping still hold. A new Claude screen is supported by adding a capture to `packages/core/src/agents/fixtures/` and a row to the readClaudeScreen table.
