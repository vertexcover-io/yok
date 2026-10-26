---
signal: Use when building a new feature that works with the agent, such as Claude Code or Codex
paths: ["packages/**/src/**"]
tags: [agents, claude, codex]
strength: default
---
# Build a new feature for every agent yok runs, not just Claude

yok runs both Claude Code and Codex, so a new feature should work with both. Build it for Claude only when the other agent does not support what the feature needs, or when the user explicitly asks for Claude only.

**Occurrences:**
- 2026-10-26 · naming the session after the run was first built for Claude only, though Codex has `/rename` too

**Stale when:** `WorkflowAgentSchema` in `packages/core/src/workflow/types.ts` lists only one agent.
