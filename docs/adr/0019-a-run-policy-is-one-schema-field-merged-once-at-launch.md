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

- One `PoliciesSchema` in `packages/sdk/src/policies.ts`; the server reads the top workflow's `policies:` block from the plan it compiles, and `yok run` sends only its `--NAME VALUE` flags (read as YAML) in the start-run request; the server merges CLI > workflow > config > default once, saves values with their sources on the registry entry, and init copies them into state.json
- The CLI compiles the workflow and sends both layers in the start-run request
- (rejected outright) a separate registry object beside the schema, or a shared framework for policy behaviour

## Decision Outcome

Chosen: the server reads the workflow layer from its compiled plan and merges once, because it is the route tiers already take (ADRs 0009, 0018): the server already compiles and checks the workflow, it keeps one merge point beside `resolveTiers`, and a resumed run or a mid-run config edit keeps the behaviour the run started with. A new policy is one schema line that the config, workflows, CLI and every step reply pick up. Each policy's effect lives where it applies (a hook, the engine, a `references/policies.md` entry), since policies differ too much to share one shape.

## Consequences

Readers take policies from state.json through `readPolicies`, which gives runs saved before policies the defaults; only the top workflow's `policies` apply. The `policies:` key, the `--NAME VALUE` flag form and the saved `{ values, sources }` shape are contracts.
