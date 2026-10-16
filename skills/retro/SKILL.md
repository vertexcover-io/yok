---
name: retro
description: >
  Audits a finished yok pipeline run and reports the yok defects it exposed. Reads the
  run's session transcripts, finds what broke, and writes one ranked report for the people who
  build yok. Runs as the last stage of every task run, failed runs included. Also use
  it whenever the user says "retro", "post-mortem", "what went wrong in that run", "why did
  yok stop", or supplies a session transcript path.
mode: subagent
allowed-tools: [Agent, Bash, Read, Write, Grep, Glob, Skill]
tier: deep
produces:
  - artifact: retro
protocols: []
scopes: []
references:
  audit-method:
    path: references/audit-method.md
    description: >-
      The auditor's whole method, from the safety rules through Step 0 to Step 4.
  transcript-schema:
    path: references/transcript-schema.md
    description: >-
      The transcript record shape and the queries written by hand. Read it when Step 1 or Step 2
      of the audit method needs a query the extractor does not answer.
  retro:
    path: scripts/retro.ts
    description: >-
      The script that extracts a run's transcripts into small files (extract) and prints cited
      transcript lines (cite).
---

# Retro

The retro audits **yok**, not the feature. The feature's code is evidence only: it shows
what a stage did or missed.

The retro writes one file, `.yok/RUN/artifacts/retro.md`, where RUN is the run's spec name.
Standalone, with a transcript path and no run, it writes `retro.md` in the current directory. The
reader builds yok and has never heard of the task, the repo, or the product.

## Where it runs

By default this stage runs in its own subagent, when the agent supports one. In a pipeline run,
orchestrate starts that subagent; this skill does not.

When nothing started a subagent for you, as in a standalone `/yok:retro` or an agent that runs
every node inline, start one yourself with this page as its brief, if you can. Finish the stage
from its report.

Gather before Step 0:

- RUN, the extraction folder `.yok/RUN/retro`, and the report path. Standalone, the transcript
  path instead of RUN.
- The timezone, only when the user named one. Without it the extractor prints times in the
  machine's zone, and the report names that zone.
- The project repo: the `create-workspace` node's `workspaceDir` in `.yok/RUN/state.json`,
  when that node ran.
- The PR URL: the `pr` node's output in the same file, when that node ran.

Run this skill's `retro` script as the `retro` reference, the way you were told to run a
skill's scripts.

Ask nobody anything: a missing input is noted in the report and the audit goes on without it.

When `retro.md` exists, finish the stage with the artifact
`{"type":"retro","name":"retro","path":"artifacts/retro.md"}` and the line `N major, M minor`
as the output. When the `retro` script could not run, finish with an error and its reason; the
node allows failure, so the run's status does not change.

## The method

The auditor's method is in [`references/audit-method.md`](references/audit-method.md): the safety
rules, the extraction, the detectors, the plan gate, the classification and the report format.
Read the whole file before anything else, then follow it from Step 0.

The method sends you to
[`references/transcript-schema.md`](references/transcript-schema.md) when a detector or a walk
needs a query written by hand.
