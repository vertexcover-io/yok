---
status: active
date: 2026-10-23
source: docs/prd-lost-compact-recovery.md
tags: [agent-plugin, harness-server-to-session, workflow-engine, event-store]
---

# A line yok types into Claude's pane for a context step counts only once a Claude hook reports it; a lost resume line pings Slack

## Context and Problem Statement

yok drives a compaction by typing `/compact` and then the resume line into the Claude Code pane. On REF-26671 a settings popup swallowed both, yok marked the step complete anyway, and the run sat idle for 37 minutes with a status saying the compaction happened; an unattended run would never finish.

## Considered Options

- Checked typing confirmed by Claude hooks: wait for idle, Escape until no popup shows, C-u, type; PreCompact (manual) and UserPromptSubmit record `hooks.prompt-received.called`; retype once; a resume line lost a second time records `agent.line.lost`
- Escape then type, with no receipt check
- Read the screen after typing for a sign the line arrived
- Wait only for the compaction's SessionStart, with a shorter timeout

## Decision Outcome

Chosen: checked typing confirmed by Claude hooks, because it is the only option that sees a lost line within seconds whatever the screen shows: Escape alone misses a popup that opens after it or ignores it, screen text changes between Claude Code versions, and a compaction can take minutes, so SessionStart reports a loss late. Only the resume line typed after a context step is worth a person's attention when it is lost twice: without it the run has nobody driving it. So `resumeRun` alone records `agent.line.lost`, and the Slack notifier posts it with a mention. The run's status does not change: the notice is how a person hears of it, so no blocker, runs-page banner or status line text repeats it. A `/compact` lost twice records nothing; the step ends `applied: false` with reason `Claude did not take /compact after 2 tries` (0024), and the resume line follows as usual. A compaction's SessionStart closing its step also counts as Claude taking the `/compact`, so a receipt that never lands cannot get a compaction typed twice.

## Consequences

Every Claude session registers two more hooks, and each prompt writes one receipt holding only the line's sha256, which the rate-limit wait does not count toward its run of limits; a receipt for any line but its own `continue` ends the wait, since the person typed it. Any new line yok types at an idle Claude goes through `sendLine`, with Escape sent only once Claude is idle. One Escape does not always close a popup: Claude's /config popup opens with focus in its search box, and the first Escape only leaves the box. So after each Escape yok pauses 300 ms (Claude reads an Escape followed within 50 ms by another key as one Alt key), reads the screen, and sends another Escape while a popup footer (`Esc to close`, `Esc to clear`, `Esc to cancel`) still shows, at most 3 in all. It never sends a second Escape to a bare prompt, because two Escapes there open Claude's Rewind menu, which would swallow the line too.
