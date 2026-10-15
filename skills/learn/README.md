# learn

Turns a correction from the current session into a short learning in `docs/learnings/`, after you pick between different fixes. Every proposal, accepted or not, is logged so the skill itself can be measured and improved.

## When it runs

- **As the `learn` stage of the `task` workflow**, right after the plan is approved, while you are still at the terminal. It looks at what you said during design and planning (chat, plan comments, `Revise` notes) and asks about the corrections worth keeping. A failure here never stops the run.
- **After each push once the run has finished**: yok's Stop hook (`offer-learn` in `packages/core/src/hooks/stop.ts`) sees the agent ran `git push` in its reply and has it ask whether to start a learning session; on yes it runs learn. The workflow's own first PR is skipped, and each push is offered once.
- **By hand** with `/yok:learn` in Claude Code or `$learn` in Codex, for example after the PR. In a run it looks only at what was said since the last pass; with a rule (`/yok:learn use pnpm here`) it turns that rule into a learning.

One-off steering and PR review comments are not learnings.

The agent needs Sonnet or Opus: on Haiku the learning files and events were not reliable (see `evals/baseline.md`).

## What it does

- Lists what you said since the last pass (`scripts/candidates.ts`), then finds the corrections worth keeping: ones that would recur, would have prevented the mistake, and say what to do. Most sessions have none.
- Checks `docs/learnings/index.md`. The same lesson gets an occurrence line; a contradicting one is replaced, and the old file deleted.
- Offers a lint rule, type or test instead of prose when one could catch the mistake.
- Otherwise asks you to pick one of up to three different fixes, write your own, or reject it with a reason.
- Writes `docs/learnings/<title>.md` (a short body, then `Occurrences` and `Stale when`) and its index line. It goes in with your current changes.
- Logs one event per candidate to `.yok/learning-events/<session id>.jsonl`, with the yok version and the ids of the transcript messages the learning came from. Samskara's watcher uploads these from enabled folders.

## Files

- `SKILL.md`: the steps and the event fields for each outcome.
- `references/learning-format.md`: the learning file and index line format.
- `scripts/log-event.mjs`: validates an event, looks up the message ids in the session transcript, and appends it.
- `scripts/candidates.ts`: prints what the user said since the last pass, each with the agent's reply before it. Reads transcripts with `@yok/sdk`'s readers. A pass ends with a `learning.reviewed` event in the run's log, which is where the next one starts.
- `scripts/transcript.mjs`: parses a session transcript, for `log-event.mjs`.
- `scripts/plugin.mjs`: the plugin's name and version from its manifest (events folder, `skill_version`).
- `scripts/*.test.mjs`, `scripts/*.test.ts`: unit tests.
- `evals/evals.json`, `evals/files/`: single-prompt evals and their fixtures.
- `evals/sim/`: simulated multi-turn sessions against a dummy repo, end to end to Samskara (costs model calls; run by hand). `evals/baseline.md` has what they measured.
