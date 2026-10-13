---
name: code-review
description: >
  Deep code review that hunts for the sequence of events under which a change goes wrong, and
  for code that works but should have been written differently. Runs five reviewer personas
  in parallel, rates each finding by how likely it is to fire, aggregates them into a report,
  and ends with the open findings as a fix list. It never edits code: in a run the workflow's
  review loop hands the list to the fix stage and reviews again on the fix commits; standalone,
  the `fix` skill takes it from `review-fixes.json`.
  Runs as the pipeline's code-review stage, after implement; also use it when the user says
  "/yok:code-review", asks for a review by personas, or "review this against the plan".
summary: Say the verdict, which pass this was, and how many findings are still open or left.
mode: inline
allowed-tools: [Agent, Bash, Read, Write, Edit, Grep, Glob, Skill]
tier: deep
outputs:
  description: The verdict, the report path, and the open Medium-and-above findings to fix.
  schema: review.output.v1
  module: scripts/review.ts
consumes:
  - artifact: plan
    optional: true
  - artifact: design
    optional: true
produces:
  - artifact: review
protocols: []
scopes: []
references:
  defects:
    path: references/persona-defects.md
    description: Finds the sequence of events under which the change does the wrong thing.
  spec:
    path: references/persona-spec.md
    description: Checks the change does what the plan asked, and that the author's claims hold.
  security:
    path: references/persona-security.md
    description: Finds who can reach what they shouldn't, and the check that is missing.
  testing:
    path: references/persona-testing.md
    description: Checks the tests prove the behavior, at the right level.
  simplify:
    path: references/persona-simplify.md
    description: Finds code the repo already has, code that could say the same with less, wasted work, and fixes at the wrong layer.
---

# Code Review

Load the `writing-style` skill before you write the report. Run its ship-check before you hand
the report back. Each reviewer persona gets the same instruction in its dispatch prompt.

You are the **dispatcher**, not a reviewer. Between dispatch and aggregation you run no tools:
the personas' reports are your entire input, and a finding you produce yourself has no axis to
sit under. Present the axes as they came back — a thin result on one axis is signal, not
something for a fuller axis to paper over.

**This runs unattended — ask the user nothing.** Every call is yours: make it, and record
the assumption in the report.

You review and report; you never change the code under review. The report records what you
found, and Finish lists the open findings that need fixing.

## What Governs This Review

**Standards are not negotiable; the repo's own standards are the ceiling and win every
conflict.**

Read these in order, highest priority first. A higher source may **add** rules or
**override** anything below it — including naming, layering, or a house pattern that
contradicts a default. What it cannot do is silently remove a rule by not mentioning it:
absence is a gap, filled by the next source down.

1. The input's `standards`, or `$ARGUMENTS` standalone, when it is a path to an existing file
2. `.claude/rules/*` and `.claude/yok/code-review-reference.md` in the project root
3. Any standards the repo documents — `CODING_STANDARDS.md`, `CONTRIBUTING.md`,
   `STYLE_GUIDE.md`, `docs/` equivalents, the learnings in `docs/learnings/` whose signal or
   `paths` match the change, or the conventions section of `CLAUDE.md`/`AGENTS.md`
4. The `references/persona-*.md` file each agent is given, and the `code-quality` and `tdd`
   skills those files name. Universal defaults, applied when nothing above speaks

## Severity

Severity is impact **times likelihood**. Every finding states its **trigger** — who has to do
what for it to fire — and that sets the level:

| Severity | Trigger |
|---|---|
| **Critical** | Normal use, by any user. Data loss, outage, or a leaked secret. |
| **High** | A realistic user or operator action. |
| **Medium** | An unusual but plausible sequence: two tabs, a retry, a mid-run Ctrl-C, a hand edit the docs invite. |
| **Low** | A trusted person acting in bad faith; a value only our own code can produce (**latent**); a coincidence; a risk the repo accepted in writing; a bug the change inherits and does not worsen (**pre-existing**). |

Every finding also states its **fix size**: `small` means one place, nothing changes for normal
users, no new abstraction, and the persona names what it must not break. A rare-but-real Low
with a small fix is rated **Medium** so it gets closed; a pre-existing, latent or cosmetic Low
stays Low. Never more than one step up; a fix that grows is left by the fixer, with why. A Low
never moves the verdict.

## Input

In a run, the input may hold these fields. RUN is the run's spec name. Standalone, the same
names are flags: `/yok:code-review [--plan PATH] [--pr NUMBER] [--commits RANGE] [--output PATH]`.

| Field | Meaning |
|---|---|
| `workspace` | the create-workspace stage's output. Review inside each repo's `worktreeDir`; without it, the current checkout. |
| `plan` | the plan or design doc the change was written from, for the Spec agent. In a run it defaults to `.yok/RUN/artifacts/plan.md`, with `design.md` beside it. With neither, the Spec agent infers intent from the commits, PR description and branch name. |
| `pr` | review a PR diff (`gh pr diff NUMBER`). |
| `commits` | review a commit range, such as `HEAD~3..HEAD`. |
| `output` | where to write the report. In a run it is always `.yok/RUN/artifacts/review.md`. |
| `round`, `rounds` | which pass of the workflow's review loop this is, and how many it runs at most. Absent or `1`, the first pass. Above `1`, a later pass: see "A later pass" below. |
| `previous` | on a later pass, the previous pass's JSON output: its `findings` and the `reviewed` head of each repo. |

**Scope** (first match wins): `pr` → the PR diff · `commits` → that range, three-dot against its
start ref · in a run, `round` above 1 → the fix commits, as "A later pass" says · in a run → the run's branch against its
merge-base with the base branch · none → the working tree (`git diff HEAD`, staged and unstaged).

## Step 1 — Preflight

Every failure below stops here, not inside the sub-agent fan-out.

1. **Pin the fixed point and capture the diff command once.** Use **three-dot**
   (`git diff <base>...HEAD`) so the comparison is against the merge-base — two-dot would
   report commits that landed on the base branch after this work started as if they were part
   of it. Confirm the ref resolves (`git rev-parse`). For PRs, also read the description
   (`gh pr view NUMBER`).
2. **Stop and report** on: empty diff (write no report; a later pass has its own rule),
   unresolvable ref, PR not found or
   `gh` unauthenticated (suggest `gh auth login`), a `plan` path that doesn't exist, or —
   under `pr` — `git rev-parse HEAD` not matching the PR's `headRefOid` (name both SHAs). In a
   run, finish the stage with `--error -` and that reason.
3. **Commit the tree before dispatch.** `git status --porcelain` decides: commit any dirty
   tracked file as a WIP commit, fold it into the reviewed range, and note it in the report
   header — this is what makes a persona's edit-and-revert experiment recoverable.

Then gather the **map**, not the territory: the diff command, the commit list
(`git log <base>..HEAD --oneline`), the changed-file list with change volume, the languages
present, and the paths of the governance sources you found on rungs 1–3. Skip generated files
(lock files, build output) entirely.

## Step 2 — Dispatch in parallel

Each axis has one persona reference. Spawn **one `general-purpose` sub-agent per axis, five in
a single message** so they run concurrently. One agent holding every axis at once matches
shallowly across all of them.

| Agent | Reference | Model | Also give it |
|---|---|---|---|
| Defects | `defects` | default | — |
| Spec | `spec` | default | the full text of the plan and `design.md`, when they exist |
| Security | `security` | default | — |
| Testing | `testing` | `sonnet` | — |
| Simplify | `simplify` | `sonnet` | — |

Get each persona file's path with `yok orchestrate skill ref --path
code-review.NAME`, which honors a project's replacement. Outside a run, the files are this
skill's `references/persona-NAME.md`.

Set the Agent tool's `model` option to `sonnet` for Testing and Simplify; leave it unset for
the other three. An agent with no `model` option (Codex) runs all five on its default model.
Defects, Spec and Security bound the wall clock; if Simplify becomes the slowest, it holds too
much and should be split again.

**All five run on every review, with one exception:** when every changed path is prose for
people (`README.md`, `CHANGELOG.md`, `docs/`), data config (`*.json`, `*.toml`, `*.yaml` that no
engine runs) or CI (`.github/`), skip Simplify and write `### Simplify` with the line "Skipped:
the diff touches no code file." Text an agent or engine follows is code here: a `SKILL.md`, a
skill's `references/`, `CLAUDE.md`, `AGENTS.md`, a workflow file. There is no other gate: an axis
with nothing to report returns nothing, and that emptiness is a result you present.

Every prompt names that agent's persona file by path and tells it to read the file first, before
anything else. Give each agent its own file and no other, so the only axis it can report under
is its own. Tell the Defects and Simplify agents to also invoke the `code-quality` skill: it is
the standard both check against, with the project's overrides applied.

Then write one brief file in your scratch folder, once per pass: the map from Step 1, the
governance sources you found on rungs 1–3 as their full text, the Severity section above, and
the brief below. Every prompt tells its agent to read that file in full right after its persona
file. A sub-agent shares none of your context, so a summary of a governance source leaves that
standard out of the review: copy the text, never paraphrase it.

**One diff, one review, five agents.** A change spanning several packages or several repos is
still one change. Give every agent the whole diff and treat the working set as a single tree.

> *"You own exactly one review axis — the persona file named for you — and report only under it.
> A real problem outside it goes under a `Handoff` heading at the end, one line each, so the
> dispatcher can file it. Review the system as it is after the change: follow every changed line
> to its callers and to every other place that decides the same fact; code the change now relies
> on is in scope even when the diff did not touch it. A problem that predates the change and the
> change does not worsen is still a finding — mark it pre-existing. Every finding names the
> thing, gives a `file:line`, says what it costs, states the trigger — who has to do what for it
> to fire — and the fix size with what the fix must not break. Show the path: the line where
> the bad value starts, the line where the damage lands, and the steps between; if you cannot
> follow it in the code, write "unverified" instead of stating the damage as fact. A claim in a
> comment or commit ("safe to re-run", "fails open") is a hypothesis: test it. Before you
> return, reopen every file:line you cite and check the quoted text is there. Report everything
> you can prove, worst first; drop only what you cannot stand behind. A finding changes what
> the code does or what it costs; style, formatting, a name that does not mislead, and "run the
> tests" are not findings. When the repo wrote the rule down, cite the source file and rule.
> The tree was committed before you were dispatched, so
> edit freely to test a hypothesis and `git checkout --` when you're done. Return your report as
> your final message — write no files."*

**The tool result is the report.** Nothing lands on disk until you write it — wait for all
five results and go straight to Step 3 with them.

## Step 3 — Aggregate

Present each persona's report under a heading named for its axis — `### Defects`,
`### Spec`, `### Security`, `### Testing`, `### Simplify` — verbatim or lightly cleaned. Do **not** merge or rerank across axes: that
masking is what the separation exists to prevent. Drop only exact duplicates (same
`file:line`, same finding); when two axes disagree, keep both — the disagreement is signal.
Keep each Simplify finding's section tag (`[Reuse: …]`, `[Simplification: …]`, `[Efficiency: …]`,
`[Altitude: …]`), and add it where the persona left it off.

Move each `Handoff` line under the axis it names, marked `(handoff from AXIS)`. A handoff is
unverified and never sets the verdict, and it stays out of `findings[]`. Then apply the
Severity adjustments (Low + small fix → Medium; pre-existing → Low) and note each one next to
its finding.

Open the file with a header: date, scope, the plan path or "intent inferred", and one line per
pass and repo, `Reviewed head: REPO SHA (pass N)`, the `git rev-parse HEAD` this pass reviewed in
that repo. The JSON's `reviewed` carries the same heads for the next pass. Then a 2-3 sentence
summary of what the change does, and the verdict:

- **`CHANGES_REQUESTED`** — at least one finding rated Medium or above is open: not closed, and
  not left by the fixer.
- **`APPROVED`** — nothing open above Low. The Lows in the report are the suggestions.

When a finding at Medium or above was left by the fixer, the verdict line says so, `APPROVED —
2 findings left unfixed, worst High`, and so does the stage summary. A reader must never take
an approval for "nothing is wrong".

Give every finding an id, `AXIS-N` (`defects-1`, `simplify-3`), unique in the report and kept
across passes. Its `file` is relative to its repo's checkout; in a multi-repo workspace, `repo`
names that repo. Set `askUser: true` on a finding whose fix would go against the plan or
`design.md`, or needs a bigger change than the finding names — a new component, a changed
contract, more scope. It stays in the fix list; the fix stage asks the user before touching it.

Close with one line per axis: total findings, and the worst issue *within that axis*. Don't
pick a single winner across axes.

**Where it goes** — always write the file:

- **In a run** → `.yok/RUN/artifacts/review.md`.
- **Standalone with `--output PATH`** → write there and report the verdict plus every open
  finding at Medium or above.
- **Standalone without it** → write `.yok/review.md`, falling back to `./REVIEW.md` when
  there's no `.yok/`, **and** print the full review inline. A human asked; make them open a
  file to see the answer and they won't.

## A later pass (round 2 and up)

By round 2, the fix stage has already worked on the last round's findings. This pass checks
those fixes, and looks only at the code they changed.

Read these first:

- `review.md`: the findings so far, each with its id.
- `previous`: the last pass's output, with the head it reviewed in each repo.
- `.yok/RUN/artifacts/fixes/review-ROUND.json`: what the fixer did with each finding —
  `closed` with its commit, or `left` with why (and the user's `decision`, if it asked).

Then:

1. **Get the fix diff** in each repo: `git diff PREV...HEAD`, where PREV is `previous.reviewed`
   for that repo. When it is empty in every repo, the fixer left everything: go to step 3.
2. **Send the personas**, in one message: Defects, plus each persona that owns a `closed`
   finding, on the same models as Step 2. Write a new brief file for this pass: the fix diff as
   its map, the governance sources and the Severity section as in Step 2, and in place of the
   Step 2 brief: *"Review the lines this fix diff changed, and follow them to their callers only
   to check the fix did not break them. Report only a problem the fix diff added, not one that
   was already there."* Give each one that brief, its own findings, and what the fixer did with
   them. Each answers two questions:
   - Is each of its closed findings really fixed? If not, why, with `file:line`.
   - Did the fix diff add a new problem?
3. **Update `review.md` in place**, never a second file:
   - each old finding gets a status: `closed`, `still open` with the persona's reason, or
     `left` with the fixer's reason (left ones move under **Left unfixed**);
   - each new finding goes under its axis, marked `(pass ROUND)`;
   - add this pass's `Reviewed head` lines, and rewrite the verdict.
4. **Rebuild the JSON** from the updated report. `findings[]` holds the findings at Medium or
   above that are `still open` or new. `left` ones are out, so no later pass retries them.

On the last pass (`round` equals `rounds`), no fixer comes after you: list every finding still
open under **Left unfixed** as well, marked "loop ended", and keep it in `findings[]` so the
verdict stays `CHANGES_REQUESTED`. The run carries on.

## Finish

In a run, push as the Push section of `yok orchestrate skill ref implement.working-instructions`
says: Step 1 may have made a WIP commit.

In a run, finish the stage with `--artifact '{"type":"review","name":"review","path":"artifacts/review.md"}'` and this JSON as the
output, checked against `review.output.v1` in `scripts/review.ts`. `verdict` comes first;
`findings[]` is the fix list the workflow hands the fix stage, so write each `summary`, `trigger`
and `hint` to stand on its own, without the report beside it:

```json
{
  "verdict": "CHANGES_REQUESTED | APPROVED",
  "report": "artifacts/review.md",
  "reviewed": { "yok": "the HEAD this pass reviewed, per repo" },
  "findings": [{ "id": "defects-1", "axis": "defects", "severity": "High", "size": "small",
    "file": "src/run.ts", "line": 42, "summary": "what is wrong", "trigger": "who does what for it to fire",
    "hint": "the fix, and what it must not break" }]
}
```

Standalone, write `findings[]` as a JSON array to `review-fixes.json` in the same folder as the
report, wherever Step 3 put it, and end by telling the user to run `/yok:fix` with that file as
`fixes`.

Standalone, this skill runs only when explicitly invoked — never trigger it on context clues.
