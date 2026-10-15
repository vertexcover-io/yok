---
name: learn
description: "Turns corrections the user made into short learnings in docs/learnings/, after the user agrees how each should read, and records every proposal. Runs as the pipeline's learn stage right after planning, and whenever the user runs /yok:learn (with or without the rule) in a yok run or says \"add a learning\" or \"remember that…\". Reads what the user said since the last learn pass. Not for one-off steering about one task, PR review comments, or architecture decisions (that is adr)."
mode: inline
allowed-tools: [Bash, Read, Edit, Write, Grep, Glob, AskUserQuestion]
tier: fast
protocols: []
scopes: []
references:
  learning-format:
    path: references/learning-format.md
    description: The learning file and index line format.
  candidates:
    path: scripts/candidates.ts
    description: Prints what the user said since the last learn pass, with the agent's reply before each message.
  log-event:
    path: scripts/log-event.mjs
    description: Validates one learning event and appends it to .yok/learning-events/.
---

# Learn

Turn what the user had to correct into a learning short enough to be read every time it matters.
Most passes produce none. A wrong learning is worse than a missing one, because the agent will
follow it in every later session.

Trigger is `auto` when this runs as the pipeline's learn stage, or after the user said yes to the
learning session yok offers when the agent pushes once the run has finished. It is `manual` when
the user invoked it unprompted (`/yok:learn`, or they asked for a learning). Text the user gave with `/yok:learn` is the rule
they want; with none, look at everything since the last pass.

**Only in a yok run.** Learn reads the run's log to know which sessions to look at and where the
last pass stopped. When `$YOK_RUN_ID` is not set, say in one line that learn works only in a yok
run, and stop.

**Running the scripts.** Run a script with `yok orchestrate skill run learn.NAME ARGS` and read a
reference with `yok orchestrate skill ref learn.NAME`. Always run them from the project's folder:
the event goes in the repo you run from.

## 1. Find candidates

When the user gave the rule, skip the script: that rule is the only candidate.

Otherwise run `candidates` with no arguments. It lists the run's sessions, starting after the last
pass's mark. It reads Claude Code transcripts only:
in another agent, or when it prints no session, work from this conversation, and ask the user what
they corrected if it isn't clear.
It prints, per session, each message the user typed (`TYPED`, or `QUEUED` when typed while you
worked) and each answer to a question (`ANSWER`, such as a plan `Revise` with notes) since the last
learn pass, under the end of the agent's reply before it. Plan comments from the viewer arrive as
`[review]` messages. Long text is cut; open the transcript only if an exchange is unclear. Note each
message's session id: step 7 logs against it.

From that list, pick corrections that would also apply beyond this task, and things that took
several attempts. A correction is any way the user told the agent the approach was wrong for this
repo, whatever the wording: "use X, not Y", "that goes in …", "why did you …", "I told you …",
"that's not how we …". Not candidates: a one-off preference about this task only ("rename it to
fetchUsers"), a PR review comment the user relays (that belongs to the PR), an answer to your own
clarifying question, and an architecture decision (that is the adr skill).

Keep a candidate only if all three hold:
- **It would recur.** Another session in this repo would plausibly make the same mistake.
- **It would have prevented it.** Having it in context would have changed what the agent did.
  Flaky infrastructure, typos and one-off environment problems fail this.
- **It is concrete.** It states what to do. "Be careful with X" is not a learning.

Zero candidates is a normal result. Say so in one line, log nothing, and go to step 9.

## 2. Already known?

Read `docs/learnings/index.md` (one line per learning: title and signal) and pick the learnings
that could be about the same thing, by meaning, not by shared words. Open those files to decide.
No index yet means no learnings yet; go to step 3.

- **This skill already logged it earlier in this session** (a learning, a check, or the user's
  rejection; read `.yok/learning-events/<session id>.jsonl` at the top of the repo when you can't
  tell from the conversation, such as after a compact): say so in one line, log nothing, and move
  to the next candidate. It is the same incident, and the user already answered. A learning written some other way, say the user asked
  you to edit `docs/learnings/` directly, still needs its event: log it now as `new` with status
  `accepted` (and `replaces` if it superseded an old one), without asking again.
- **An existing learning says the same thing:** add one line under its `**Occurrences:**`
  (`- <date> · <what happened>`); if the file has no such section, add it above `**Stale when:**`,
  or at the end. Log it with `outcome: "occurrence"` and move to the next candidate.
- **An existing learning contradicts it** (old: "use npm", now: "use pnpm"): continue as usual, and
  when you ask the user in step 5, show the old learning's text and say it will be removed. When you
  write the new learning in step 6, delete the old file and its `index.md` line, and log the new
  event with `replaces` set to the old file's path.

## 3. Could a linter catch it?

If a lint rule, type check or test could catch this mechanically, and the repo already has that
lint config, type checking or test suite, a check beats prose. Show the user the exact check (the
rule and the config it goes in, or the test) and ask whether to add it now. With no such setup,
skip this step and write a learning in step 4.
- **Yes:** add it as part of the user's current changes, and run it once to confirm it catches the
  mistake. Log `outcome: "lint"`, `status: "accepted"`, `learningFile` set to the file you changed.
- **No:** log `outcome: "lint"`, `status: "rejected"`, with their reason if they gave one.

Either answer settles the candidate: write no learning for it, and move on.

## 4. Prepare the options

**If the user stated the rule** (`/yok:learn <rule>`, or "remember that …"), their rule is the
only option: tidy it into a learning without changing what it says.

**Otherwise**, write one to three options, each a **different fix**: a different thing the rule
could tell the next agent to do, not the same rule at different reach or with extras added. First
list every fix a reasonable team in this repo might choose, at least three, even ones you will
drop. Keep each one that is a real choice here, and drop one only when the repo rules it out (say
why in one line, to yourself). Offer as many as survive that check: one when only one does, three
when three do.

```
Caught errors in background jobs are only logged to the console. Which should the rule be?
1. Rethrow caught errors so the job fails and gets retried
2. Log caught errors with the structured logger instead of console.log
3. Report caught errors to Sentry with captureException
```

Before wording them, list the adjacent cases: where else in this repo would the same mistake happen,
and where would it not apply? Word every option for exactly that reach (here: background jobs and
webhooks, not every catch block), and set `paths` in the learning to match.

Write in your own words. The user's phrasing is about this one incident; the learning has to read
correctly in a different one.

## 5. Ask the user

Prepare every candidate first (steps 2 to 4), then ask about them together: one `AskUserQuestion`
holding up to 4 questions, one per candidate, so the user answers them on one screen. With more than
4, ask the rest in a second call. Each question has the fix options, plus `Reject` (the tool adds
"Other" itself). Where `AskUserQuestion` isn't available, ask in plain text, numbered, with the same
choices.

The question may come a while after the correction, so open each one with one line of context:
where it happened and a few of the user's own words, then the question. Nothing longer.

```
During planning you said "retries go in the job runner". Which should the rule be?
```

Write and log a candidate only after the user answers its question. If they put it off ("not now", "finish the
fix first") or moved on without answering, nothing is approved: ask again when they come back to it.

- **Picked an option or wrote their own:** if they ask for changes, revise and confirm again.
- **Reject:** ask for the reason in one line, and log it with `outcome: "rejected"`.
- **Took it back later in the session** ("drop that learning"): delete the file and its index line,
  and log `outcome: "rejected"` with their reason, so the record matches what is in the repo.

## 6. Write it

Read [references/learning-format.md](references/learning-format.md) and copy its template exactly:
frontmatter with `signal`, `paths` (inline list), `tags` and `strength`, then `# <title>`, a body of a
few sentences, `**Occurrences:**` and `**Stale when:**` with a concrete condition a later cleanup can
check. Save it as `docs/learnings/<kebab-title>.md` and add its line to `docs/learnings/index.md`.
The learning says only what the user agreed to; add no rules of your own. The learning goes in with the
user's current changes, so it gets reviewed in their PR; don't commit it separately.

## 7. Log every outcome

Log one event for each candidate that reached step 2, apart from the ones step 2 says to skip:

```bash
yok orchestrate skill run learn.log-event SESSION_ID <<'EOF'
{"trigger": "auto", "whyTriggered": "…", "evidenceFrom": "…", "evidenceTo": "…",
 "optionsShown": ["…"], "proposedLearning": "…", "optionUserPicked": "2", "outcome": "new",
 "status": "edited", "finalLearning": "…", "rejectionReason": "",
 "learningFile": "docs/learnings/….md"}
EOF
```

SESSION_ID is the session the `candidates` list showed the correction under. When it showed none
(the user stated the rule, or the agent's transcripts can't be read), leave SESSION_ID out: the
script uses your own session's id.

Every event has `trigger` (`manual`/`auto`), `whyTriggered` (one sentence: what in the session
made this a candidate), and the two ends of the exchange it came from, each a few words copied
character for character from one message (not from tool output, not a paraphrase):
- `evidenceTo`: from the user's correction, the first time they made it. When the user stated the
  rule with `/yok:learn <rule>` and nothing was corrected, it is from that message.
- `evidenceFrom`: from your own message or tool call (code you wrote or a command you ran counts)
  that they corrected. Never the user's words. Leave it out only for a rule the user stated with
  nothing corrected.

The script finds those messages in the session transcript and stores their ids, so the whole
exchange can be read later. The rest depends on the outcome:

| Outcome | `proposedLearning` | `optionsShown` | `optionUserPicked` | `status` | `finalLearning` | also |
|---|---|---|---|---|---|---|
| `new`, option taken as is | the picked option | all shown | `"1"`–`"3"` | `accepted` | `""` | `learningFile` |
| `new`, option edited | the picked option, before edits | all shown | `"1"`–`"3"` | `edited` | the edited text | `learningFile` |
| `new`, user wrote their own | your recommended option | all shown | `"other"` | `edited` | their text | `learningFile` |
| `rejected` | your recommended option | all shown | `""` | `rejected` | `""` | `rejectionReason` |
| `occurrence` | the candidate, one line | `[]` | `""` | `existing` | `""` | `learningFile` (the existing one) |
| `lint`, added | the check, one line | `[]` | `""` | `accepted` | `""` | `learningFile` (the config or test changed) |
| `lint`, declined | the check, one line | `[]` | `""` | `rejected` | `""` | `rejectionReason` if given |

When the user stated the rule, `optionsShown` is that one option and `optionUserPicked` is `"1"`.
For a learning written outside this skill (step 2), `optionsShown` is `[]` and `optionUserPicked`
is `""`.
`finalLearning` is filled only when `status` is `edited`; otherwise `proposedLearning` is what was
saved. When the new learning superseded an old one, also set `replaces` to the deleted file's path.
Leave any field that doesn't apply as `""`.

The script adds the event id, session id, timestamp, working directory and yok version, and
writes to `.yok/learning-events/<session id>.jsonl` at the top of the repo. If it prints an
error, nothing was written: fix the JSON or the snippet and run it again. If a snippet still isn't
found after two tries, drop only the snippet the error names and log again. A failed log never
blocks the learning itself.

## 8. Report

One line per candidate: what happened, and the file written or updated.

## 9. Mark the pass

Record that everything said so far was looked at, so the next pass starts after it. Do this even
when there were no candidates:

```bash
yok orchestrate emit learning.reviewed --source learn --payload '{}'
```

As the pipeline's learn stage, finish with the reply's `done` command and the step 8 lines as the
output.
