# learn: baseline

Measured with the simulated sessions in `sim/` (Claude Code 2.1.x; agent and simulated user on
Sonnet; correction check on Haiku), on yok and the plugin it grew out of, October 2026.

## Auto trigger

These numbers led to a hook that nudged the agent after a correction. The hook is gone: learn now
runs as a stage after planning and by hand with `/yok:learn`, so nothing has to trigger it.

| Setup | Corrections that triggered learn | One-offs that wrongly triggered it |
|---|---|---|
| Description only, first wording | 0 of 6 | 0 of 6 |
| Description only, imperative "run this as soon as…" | 1 of 6 | 0 of 6 |
| Hook, regex check | 2 of 3, both mid-task; missed 2 of 3 real corrections, flagged 2 non-corrections | 0 of 3 |
| Hook, Haiku check with regex fallback | 6 of 6, all after the work was done | 0 of 6 |

The regex missed corrections such as "Hold on, did you hardcode … in both apps?" and "shared-config
already has a place for this", and flagged "did the switch go in on both apps?". The Haiku check
read all of them right, in 4 to 8 seconds, in the background.

## Final run: every scenario, both plugins

34 sessions: auto-shared-list and auto-one-off 3 times each, every other scenario once.

- 33 of 34 passed after fixes found by the run. The remaining one was a false positive the skill
  proposed (a one-off sandbox setup issue) that the user rejected; the rejection and its reason were
  logged, which is the signal this logging exists for.
- 24 of 24 runs that logged an event reached Samskara: row stored, fields matching the JSONL,
  linked to the session's project, and the evidence messages covering the exchange.
- Occurrence was not exercised in the final run: in both runs the agent read the existing learning
  and did not repeat the mistake. It passed in earlier rounds.

## Agent model

Three scenarios (several-real-fixes, manual-with-text, auto-shared-list) with only the agent's model
changed (`SIM_AGENT_MODEL`); the simulated user and grader stayed on Sonnet. The earlier plugin, one run each.

| Agent | Result |
|---|---|
| Sonnet | 3 of 3 (and the full run above) |
| Opus | 2 of 3; the third offered a lint check and a written learning together, the user took the learning, and both were logged (`lint/rejected`, `new/accepted`): accurate, but step 3 meant one or the other |
| Haiku | 0 of 3: ignored the learning format (no signal, Occurrences or Stale when), skipped logging a user-stated rule, proposed before fixing the code, logged one learning twice, and dropped the evidence ids |

The skill needs Sonnet or Opus as the agent. On Haiku the learning files and the events are not
reliable enough to keep.

## Learn stage, no hooks: yok only, October 2026

After the hook was replaced by the `learn` stage after planning. The auto scenarios end with a
pipeline turn that starts the stage; `run-two-passes` and `viewer-comment` run inside a fake yok
run (a registry entry, the run's folder and event log, `$YOK_RUN_ID`, and this checkout's `yok`).

19 sessions: every scenario once, auto-shared-list and auto-one-off 3 times each, plus
run-two-passes and viewer-comment.

- 16 passed. Every event landed in the repo the agent worked in, with evidence ids that point at
  the real messages.
- 2 failed on grading, not on the skill. compact-mid-session found and logged a second real
  correction ("Don't touch node_modules") the scenario did not expect, and the grader read that
  learning instead of the expected one. One auto-shared-list run wrote the right rule framed as
  "check shared-config before hard-coding", and the grader wanted "put shared lists in
  shared-config".
- 1 not exercised: contradiction-replaces, where the agent used pnpm on its own.
- run-two-passes: the stage found the run from `$YOK_RUN_ID`, logged the shared-config learning
  and left its mark; the later `/learn` read only what came after the mark, said nothing new was
  corrected, and left a second mark. The agent used pnpm on its own, so a second pass that finds
  a new correction is not exercised yet.
- viewer-comment: the correction arrived as the viewer's `[review]` message on the plan, and the
  stage logged it with that message as the evidence.
- Samskara (`samskara-check.mjs`) on viewer-comment, run-two-passes (logged through
  `yok orchestrate skill run`) and shared-list-edited (logged with `node`, outside a run): 3 of 3
  stored, fields matching the JSONL, linked to the session's project, and the evidence messages
  covering the exchange.

The first round of this run exposed two defects, both fixed before the numbers above: SKILL.md
told the agent to run the scripts from the skill's folder, so events went to the plugin's repo; and
the sim's mistake detector missed writes made from inside `apps/`.

After rebasing on main (the review loop, compact steps, `recordResumed`): run-two-passes,
viewer-comment and shared-list-edited all pass.

## Not measured yet

- Real sessions. These are scripted users in one dummy repo; the Learn events page in Samskara
  shows the real accept and reject rates once people use it.
- A real `yok run`: the stage starting after the plan is approved, a comment sent from the viewer
  through the server, and the run moving on to implement after the stage's `done`.
- A second pass that finds a new correction, and Codex sessions, whose transcripts the candidates
  script does not read.
