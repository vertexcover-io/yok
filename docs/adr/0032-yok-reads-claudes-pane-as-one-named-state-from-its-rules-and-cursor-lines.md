---
status: active
date: 2026-10-30
tags: [agent-plugin, harness-server-to-session]
---

# yok reads Claude's pane as one named state from its rules and ❯ lines

## Context and Problem Statement

In run ref-26119 every compact step failed with "Claude input box did not show": a strict rule pattern missed a named session's rule in a narrow pane. Eleven small helpers (rule and footer patterns, option numbers, box and busy checks) were combined differently by each caller, so one miss broke typing in ways no single test showed.

## Considered Options

- One pure `readClaudeScreen` that names the state (ready, busy, menu, popup, unknown) from the rules and the ❯ lines alone; every caller switches on it, and a line still types at the box while Claude is busy
- Keep 0024's helpers and loosen the rule pattern
- One `readClaudeScreen`, with a context-step line waiting while Claude is busy

## Decision Outcome

Chosen: one `readClaudeScreen` that types at the box while Claude is busy, because it is the only option where every caller acts on the same reading, the reading uses only what every Claude screen draws, and Claude queues a line typed during its turn, so waiting would only add a 30-second give-up after a slow compaction or a long Stop hook. A rule is a ─ line with at most one title, never one with box corners or bars, so /config's search-box edge is not one. The lowest plain ─ line decides: a ❯ line under it is a menu (a permission prompt, the trust dialog, /config), whose keys belong to a person; a ❯ line just above it with a rule above that is the input box, when at most four status lines sit under it; a ❯ line between it and the plain ─ line above is a menu too, which covers the question dialog's divider above its last option; anything else is a popup, closed with Escape at most 3 times. A blank pane, or a box with more lines under it than a status area holds, is unknown, so no key is sent. Footer text and option numbers are not read: the permission prompt has no "Enter to" footer and the trust dialog has no numbers. A ❯ line in the transcript counts only with a plain ─ line above it. When the box shows, a /compact or resume line is typed even under a spinner; with no box, busy and menu wait at most 30 seconds, and a try that gives up logs the screen's last 15 lines.

## Consequences

Amends 0024: its footer-based box check is replaced; its typing while Claude is busy, confirm-by-effect and Slack ping still hold. A new Claude screen is supported by adding a capture to `packages/core/src/agents/fixtures/` and a row to the readClaudeScreen table.
