# Replay

A replay runs one `code-review` persona, blind, on a clean checkout of the commit the outside
reviewer saw. The persona gets what the real dispatch gives it and nothing that reveals the
answer: no finding, no comment, no PR body, no later commit. Its report is then matched against
the finding by mechanism.

## What the persona receives

Build the prompt from these parts, in this order, pasted as text. The persona shares none of your
context.

1. The first line: *Read your persona file (path below) FIRST, before anything else. Report only
   under that axis.*
2. The governing standards, as `code-review`'s SKILL.md states them: the repo's `.claude/rules/*`
   and `.claude/yok/code-review-reference.md` when present, the standards the repo documents
   (the governance paths in the map, to read in full), and the persona file with the skills it
   names. A breach of the first two is a hard violation; a finding from the third is a judgement
   call.
3. The confinement line: *Work only inside the repo checkout named in the map, plus your persona
   file and the skill files named below. Do not open any other path.*
4. The Severity section of `code-review`'s SKILL.md, verbatim.
5. The dispatch brief from `code-review`'s SKILL.md Step 2, verbatim: the quoted paragraph that
   starts "You own exactly one review axis". Use the working-tree version of the skill, read
   through `yok orchestrate skill ref code-review.NAME`, never a copy.
6. The persona file's absolute path, from `yok orchestrate skill ref --path code-review.NAME`.
   Tell the Defects, Reuse, Simplification, Efficiency and Altitude personas to also invoke the
   `code-quality` skill, as the real dispatch does.
7. The map: the `map-PERSONA.md` the `gap checkout --copies` command wrote for this persona.
   Each persona has its own copy of the checkout, so the brief's "edit freely to test a
   hypothesis and `git checkout --` when you're done" holds.

The map has this shape:

```
## Map
- Repo checkout: /abs/path/checkout-spec (branch `review` is the change, branch `base` is the merge-base)
- Diff command: `git -C /abs/path/checkout-spec diff base...review`
- Commits:
  - b9593cf docs(readme): install, upgrade and uninstall with Homebrew or npm
- Changed files (volume):
  - packages/cli/src/install.ts (+36 -6)
- Governance sources found (rungs 1-3):
  - /abs/path/checkout-spec/CONTRIBUTING.md
```

Give the Spec persona the plan too when `analysis.json` names one: the file at that path in the
checkout, or the PR body only when `plan` says the body is the plan. A PR body that names the
fixes made after the review is withheld.

Save the persona's final message verbatim at `replay/PERSONA.md` in the PR folder.

## Matching a report to a finding

For each finding the persona was replayed for, read its `matchHint` and the persona's report, and
decide:

- `caught`: a finding in the report names the same mechanism, at the same place or at the place
  the mechanism lives. Different words are fine; a different file with the same root cause is
  fine when the trace reaches the finding's line.
- `partial`: the report is in the right area with the wrong mechanism or the wrong consequence,
  or it names the mechanism under `Handoff` without a trace.
- `miss`: nothing in the report touches the mechanism.

Record `evidence`: the finding number or heading in the report that matched, or "no mention of
X" for a miss.

## Diagnosing a miss

Read what the persona actually did, from its report: which files it names, which claims it
checked, where it stopped. Then classify:

- `agent-miss`: the persona file or the brief had a line that leads to this bug, and the agent
  did not follow through. Put that line in `citation`, quoted. Typical shapes: it read the
  function the finding is in and cleared it line by line while the bug is a sequence; it verified
  that the code matches the comment instead of testing the comment; it saw the operation but
  never asked what fires it or what a re-run does.
- `prompt-gap`: nothing in the persona or the brief leads there, or a rule steers away from it.
  Put the missing reasoning step in `citation`: the question the persona would have had to ask.

Then write `proposal`: a general rule, phrased as a question the reviewer asks of every operation
or value, never a pattern to grep for. A pilot showed that pattern lists (`includes()`,
`copyFile().then(() => false)`) overfit the PRs that produced them while questions ("what else
can this value be?") carry to new ones. Name `proposalFile`: the persona file or
`skills/code-review/SKILL.md` for the brief. For an `agent-miss`, the proposal may be "none; the
prompt had it", or a sharpening of the line that was ignored.

The root causes the pilot found, to recognise rather than to re-derive: the persona reads lines
while the bug is a sequence; scope rules fence off callers and runtime; the agent verifies the
author's claim instead of testing it; security is built for injection and misses the absent
check; nobody owns deploy, upgrade and retry; the search stops after three findings.

## Output

`replay.json` in the PR folder:

```json
{"repo": "OWNER/NAME", "number": 0, "sha": "",
 "results": [
   {"id": "OWNER/NAME#N:COMMENT_ID", "persona": "defects", "result": "caught|partial|miss",
    "evidence": "", "cause": "agent-miss|prompt-gap", "citation": "", "proposal": "",
    "proposalFile": "skills/code-review/references/persona-defects.md"}
 ]}
```

`cause`, `citation`, `proposal` and `proposalFile` only for a `miss`.
