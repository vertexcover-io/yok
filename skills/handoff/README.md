# handoff

Writes a handoff note so yok can start a fresh session in place of `/compact`. The note stands in for the old conversation; it works the same in Claude Code and Codex.

## When it runs

Only yok invokes it, at a context step: `/yok:handoff PATH [INSTRUCTIONS]` in Claude Code or `$handoff PATH [INSTRUCTIONS]` in Codex. Neither the user nor the model fires it.

## What it does

- Takes an optional note path (`.yok/RUN_NAME/handoff.md` when yok passes one, else `handoff.md` in the working directory) and, after it, optional instructions used the way `/compact INSTRUCTIONS` is: they say what to keep in more detail. The first token is the path when it ends in `.md`.
- Writes one note with four sections: progress and decisions, context and constraints, next steps, references. The instructions add depth; the sections stay.
- Writes it from the conversation alone: no commands, no file reads, no yok commands. The user's messages are not copied in, since yok adds them to the new session word for word; the note refers to them instead. No lead-in and no reading list either, since yok writes the lead-in and the next stage's skill names its files.
- Overwrites any earlier note at the path, then replies with one line naming it.

## Files

- `SKILL.md`: the input, the note's shape and what stays out, the reply.
- `evals/evals.json`: six evals, one per promise the skill makes.
