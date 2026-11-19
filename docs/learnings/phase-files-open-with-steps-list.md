---
signal: Use when writing a phase-N.md file for a plan
paths: ["**/artifacts/phases/*.md"]
tags: [planning, plan-files]
strength: default
---
# Open every phase file with a short bullet list of its steps

Put a "Steps at a glance" list right after the title and `Depends on:` line of each phase file: one bullet per step, one plain sentence saying what the step does. A phase can have dozens of steps with long diffs, and the reviewer needs the shape of it before reading any of them.

**Occurrences:**
- 2026-11-19 · SQLite plan: the user asked for a short per-step summary of phases 2, 3, 5 and 6 after reading the long phase files

**Stale when:** `skills/planning/references/plan-sections.md` already requires a steps list at the top of each phase file.
