# adr

Records one architecture decision as a permanent file in the project's `docs/adr/` folder, so the next person or agent knows why the code is the way it is and does not undo it by accident. The skill checks each candidate against four gates and writes nothing when one fails.

## When it runs

No shipped workflow runs it as its own stage. The planning stage calls it for the task and for every decision the user approved. You can also invoke it yourself:

- Claude Code: `/yok:adr`
- Codex: `$adr`

Give it the decision in one sentence and the reason behind it. Alternatives, the source ticket or document, and related ADRs are optional.

## What it does

1. Reads `docs/adr/INDEX.md` and every related ADR, so it reuses existing tags and spots overlap.
2. Checks the four gates: hard to reverse, surprising without context, a real trade-off, and relevant to future work. It also drops a decision with no reason or one the task never called for.
3. Drafts the ADR in the fixed format: front matter (status, date, source, tags), a title that states the decision, context, considered options, decision outcome with a `because`, and consequences.
4. Sends the draft to a review agent on a fast model, which returns `keep`, `rewrite`, `covered by NNNN`, or `drop`.
5. Writes `docs/adr/NNNN-slug.md`, marks any ADR it contradicts `inactive`, and updates `INDEX.md`.
6. Returns `written: PATH`, `covered by: PATH`, or `dropped: REASON`.

## Files

- `SKILL.md`: the gates, the ADR and INDEX.md formats, the steps, and the review agent's brief.
