---
signal: Use when editing a skill's SKILL.md or its references
paths: ["skills/**/*.md"]
tags: [skills, writing]
strength: hard-rule
---
# Rewrite the section a skill edit touches, in plain steps ordered by execution

Before adding text, check whether the edit conflicts with its neighbours or needs the whole section rewritten, and rewrite it when it does. Write in plain terms a person can read, say what to do rather than what to avoid, and word it for general use with no specific examples. Open each step with a bold leading phrase that sets the direction, and keep the information in one place, in the order the agent runs it.

**Occurrences:**
- 2026-10-23 · plan for the design-references feature added long, example-heavy skill steps; the user asked for these rules in review

**Stale when:** skills stop being the instructions agents follow at run time, or `skills/` is moved or removed.
