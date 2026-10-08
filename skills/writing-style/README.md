# writing-style

How to write anything a person will read: reports, plans, PR and issue bodies, READMEs, release notes, summaries. The test for every sentence is whether an engineer would say it out loud to the colleague sitting next to them.

## When it runs

Not a stage. It applies whenever a skill writes prose for a human, so the stages that produce reports and PR bodies follow it. Load it yourself with `/yok:writing-style` in Claude Code or `$writing-style` in Codex before writing or editing a document. Agent-only files such as `design.md` are exempt.

## What it does

- Puts the answer first: the verdict or the change opens the document, bookkeeping follows.
- Cuts anything that would read the same on a different run.
- Gives the real file, number or error message instead of category words like "issues".
- Uses the plain word, spells out internal jargon, and lets the reason do the work that "robust" and "crucial" would otherwise pretend to do.
- Explains what a thing is before saying what is wrong with it, and glosses each name where it is first needed.
- For reports: matches every claim to an evidence line, quotes evidence verbatim, keeps every repeated number identical, and says what could not be determined.

Code, commands, paths and a skill's fixed vocabulary stay exact; the rules govern prose only.

## Files

- `SKILL.md`: the rules, the report rules, and the ship-check to run before delivering.
