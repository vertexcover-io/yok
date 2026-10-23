---
status: active
date: 2026-10-23
source: docs/prd-lost-compact-recovery.md
tags: [agent-plugin, harness-server-to-session, workflow-engine, event-store]
---

# A line yok types into Claude's pane for a context step waits for Claude's input box and counts once its effect shows; an unreachable box or a lost resume line pings Slack

## Context and Problem Statement

yok drives a compaction by typing `/compact` and then the resume line into the Claude Code pane. On REF-26671 a settings popup swallowed both, yok marked the step complete anyway, and the run sat idle for 37 minutes with a status saying the compaction happened; an unattended run would never finish.

## Considered Options

- Type at Claude's input box and confirm by effect: send Escape only while the box is hidden, at most 3; type `/compact` once and count it by the compaction's SessionStart; count the resume line by the run's `orchestrate.resume`, retyped once; ping Slack when the box never shows or the resume line is lost twice
- Checked typing confirmed by a receipt hook: PreCompact (manual) and UserPromptSubmit record a hash of each line Claude takes, and a line with no receipt within seconds is retyped
- Escape then type, with no check
- Wait for idle before typing, and Escape until no popup footer shows

## Decision Outcome

Chosen: type at the input box and confirm by effect. The input box (a `❯` line between two rules) is the one sign that Enter submits a message: a popup or dialog replaces it, and Claude keeps it on screen while it works. So yok types as soon as the box shows, even while Claude finishes its turn, since Claude holds the line until then; waiting for idle would hold the step for the rest of a long turn. An Escape goes out only while the box is hidden, because an Escape at the box could cancel Claude's turn, and two open its Rewind menu.

Each line counts by what it causes, not by a receipt. A compaction's SessionStart closes its step; `/compact` is typed once, because a compaction can take minutes and a retype could start a second one. The `--resume` skill runs `yok orchestrate resume` first, so an `orchestrate.resume` recorded after the line was typed shows Claude took it. Its 30-second window starts only once Claude no longer shows busy, capped at 180 seconds, so a line Claude holds behind a finishing turn is never typed twice. A receipt hook added two hooks to every session and a record to every prompt, and still could not tell a line Claude held from one it lost.

Two failures need a person, and the Slack notifier posts each with a mention; the run's status does not change, so no blocker, runs-page banner or status line text repeats them. An input box that does not show after 3 Escapes records `agent.input.unreachable` (titled `Agent blocked at STEP — Could not reach Claude's input box`), and nothing is typed; a compaction then ends `applied: false` with reason `Could not reach Claude's input box` (0024), and the resume line is still tried. A resume line not confirmed on either try records `agent.line.lost`: without it the run has nobody driving it.

## Consequences

Any line yok types into Claude's pane goes through `tryLine`. After each Escape yok pauses 300 ms (Claude reads an Escape followed within 50 ms by another key as one Alt key), then reads the screen again. C-u empties the box before each line, where a cancelled line may be left. Only the two paths that kill and relaunch Claude's process, a new session and a model switch, still wait for idle, so they never cut a working turn. A Claude Code version that redraws its input box differently stops every typed line, and the Slack notice says so at once.
