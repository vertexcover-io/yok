# design

Settles what gets built before anyone plans how. It reads the code, asks the user only the questions that change the shape of the build, weighs approaches, and writes a one-page `design.md` the user approves in about a minute.

## When it runs

The `task` workflow runs it as the fourth stage, after `baseline` and before `planning`. The `quick` workflow skips it. You can also invoke it yourself for "design this", "grill me on this" or "help me think this through":

- Claude Code: `/yok:design`
- Codex: `$design`

Standalone, it uses a short kebab-case topic name where a run would use the run name.

## What it does

1. Understand: reads the task and every file it names, finds why the task exists, and sends out fast-model agents in parallel (one Explore agent per repo, a docs scout over `docs/` and `docs/adr/`, and a research agent when the repo has few examples of the pattern). A one-file, one-edit task takes the atomic route and skips the questions.
2. Map what is unknown: walks the coverage map (purpose, actors, scope, data, interfaces, integrations, failure and so on) and turns each gap that would change the shape into a decision with its blockers.
3. Grill in rounds: asks up to four unblocked questions at a time with a recommended option first, records every answer in `design.md` at once, and checks answers against each other for clashes. Low-impact decisions are inferred, not asked.
4. Choose the approach: offers two or three only when real alternatives exist, framed as reuse, extend or build new, and asks the user.
5. Write and check the page against hard caps: 500 words, one diagram, six "what changes" rows, three decisions, three risks.
6. Review and confirm: a self-review, then a fresh-eyes sub-agent that verifies every claim about the code against the code. The whole page is pasted in the reply and the user approves or revises.

## Inputs and outputs

- Reads: `task`, a plain prompt or a ticket's text with its local files.
- Produces: the `design` artifact at `.yok/RUN_NAME/artifacts/design.md` with `status: approved`. The stage has no other output; `planning` and the Spec reviewer in `code-review` read the file.

## Files

- `SKILL.md`: the eight steps, the "would the plan look different" test, and the list of excuses the skill refuses.
- `references/coverage.md`: the coverage map and the lenses that find the questions worth asking.
- `references/design-doc.md`: the `design.md` format, its caps, and the one diagram it may draw.
- `evals/evals.json`: eval cases for the skill.
