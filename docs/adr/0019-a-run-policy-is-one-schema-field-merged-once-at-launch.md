---
status: active
date: 2026-10-15
source: .yok/run-policies/artifacts/design.md
tags: [sdk, harness-server, orchestrate-config, workflow-engine, harness-cli, cli-to-server]
---

# A run policy is one field of one Zod schema, merged once at launch and frozen into state.json

## Context and Problem Statement

A developer needs per-run settings that change how stages behave (first: `interaction: false` for an unattended run), set in the shared config, a workflow or one `yok run`, without editing shared files and without the run changing mid-way.

## Considered Options

- One `PoliciesSchema` in `packages/sdk/src/policies.ts`; `yok run` sends the top workflow's `policies:` block and its `--NAME VALUE` flags (read as YAML) in the start-run request, as it sends `plan.tiers`; the server merges CLI > workflow > config > default once, saves values with their sources on the registry entry, and init copies them into state.json
- The request carries only the flags, and the server parses the workflow file itself
- (rejected outright) a separate registry object beside the schema, or a shared framework for policy behaviour

## Decision Outcome

Chosen: the CLI sends both layers and the server merges once, because it is the route tiers already take (ADR 0009): the CLI has already compiled and checked the workflow, the server keeps one merge point beside `resolveTiers` without parsing workflows itself, and a resumed run or a mid-run config edit keeps the behaviour the run started with. A new policy is one schema line that the config, workflows, CLI and every step reply pick up. Each policy's effect lives where it applies (a hook, the engine, a `references/policies.md` entry), since policies differ too much to share one shape.

## Consequences

Readers take policies from state.json through `readPolicies`, which gives runs saved before policies the defaults; only the top workflow's `policies` apply. The `policies:` key, the `--NAME VALUE` flag form and the saved `{ values, sources }` shape are contracts.
