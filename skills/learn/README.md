# learn

Turns a correction from the current session into a short learning in `docs/learnings/`, after you pick between different fixes. Every proposal, accepted or not, is logged so the skill itself can be measured and improved.

## When it runs

Not a stage of any shipped workflow. Invoke it with `/yok:learn` in Claude Code or `$learn` in Codex. It also offers itself, once the corrected work is done, after a correction that applies beyond the task ("use pnpm here, not npm", "services go in src/services") or the same correction twice. One-off steering and PR review comments are not learnings.

Claude rarely starts a skill like this on its own, so the plugin's hooks (`hooks/hooks.json`) help. On each user message, a small model checks in the background whether it corrected the agent; if the model can't answer in time, a regex decides. When the agent then finishes a reply that hands the turn back, it is asked once to consider the skill. It stays silent when the correction was a one-off.

## What it does

- Finds the corrections worth keeping: ones that would recur, would have prevented the mistake, and say what to do. Most sessions have none.
- Checks `docs/learnings/index.md`. The same lesson gets an occurrence line; a contradicting one is replaced, and the old file deleted.
- Offers a lint rule, type or test instead of prose when one could catch the mistake.
- Otherwise asks you to pick one of up to three different fixes, write your own, or reject it with a reason.
- Writes `docs/learnings/<title>.md` (a short body, then `Occurrences` and `Stale when`) and its index line. It goes in with your current changes.
- Logs one event per candidate to `.yok/learning-events/<session id>.jsonl`, with the yok version and the ids of the transcript messages the learning came from. Samskara's watcher uploads these from enabled folders.

## Files

- `SKILL.md`: the steps and the event fields for each outcome.
- `references/learning-format.md`: the learning file and index line format.
- `scripts/log-event.mjs`: validates an event, looks up the message ids in the session transcript, and appends it.
- `scripts/learn-hooks.mjs`: the correction check and the nudge, run by `hooks/hooks.json` on each user message and at the end of each reply.
- `scripts/transcript.mjs`: reads a session transcript, for both scripts.
- `scripts/plugin.mjs`: the plugin's name and version from its manifest (events folder, env switches, `skill_version`).
- `scripts/*.test.mjs`: unit tests.
- `evals/evals.json`, `evals/files/`: single-prompt evals and their fixtures.
- `evals/sim/`: simulated multi-turn sessions against a dummy repo, end to end to Samskara (costs model calls; run by hand). `evals/baseline.md` has what they measured.
