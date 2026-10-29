---
name: handoff
description: >
  Writes the handoff note a fresh session resumes from, in place of /compact. Used only when
  yok types it into a run's session before replacing that session; no user or model fires it.
disable-model-invocation: true
allowed-tools: Write
---

# Handoff

Write the handoff note: the one record of this conversation the next session gets. Once this
turn ends, yok starts a fresh session and puts in front of it, in this order, its own lead-in,
this note, and the user's own messages from this session, word for word, newest first, up to
about 20,000 tokens. Everything else is gone: tool results, files read, decisions, dead ends.
The note is where those live now. `README.md` beside this file says the same for people.

Write it in your head and then to the note. Nothing else runs: no command, no file read, no
yok command. The conversation is the only source.

## Input

The arguments are one line, and both parts are optional: the note path, then the custom
instructions. The first token is the path when it ends in `.md`; otherwise the whole line is
instructions.

| Part | Meaning |
|---|---|
| path | the note, `.yok/RUN_NAME/handoff.md` when yok passes one. Without it, `handoff.md` in the working directory. Overwrite whatever is there. |
| instructions | everything after the path. What to keep in more detail, the way `/compact INSTRUCTIONS` is used. |

## 1. Write the note

Use this exact shape:

```
# Handoff

## Progress and decisions
## Context and constraints
## Next steps
## References
```

Fill each section for a reader who knows the codebase and the tools but has not seen this
conversation:

- **Progress and decisions:** what is done, where the work stopped, and each decision with the
  reason it was made and the option it beat. A dead end counts as a decision: name it so the
  next session does not walk it again.
- **Context and constraints:** what the task must respect: rules the user set, limits found in
  the code, preferences the user showed. Point at the user's words instead of repeating them
  ("as the user asked", "the user's second message"): yok puts those messages beside the note.
- **Next steps:** the remaining work as an ordered list, each step with what tells it is done.
  The first step is the one to take right now.
- **References:** the facts the next session cannot recover by itself: a command that worked
  and its exact flags, an error message, an identifier, a branch name, a run or workspace path.
  Name code by `path:line` and quote at most five lines of it, only where the exact text
  matters.

When the instructions ask for something, give it more room in the section it belongs to; a
request that fits no section goes under References.

What stays out, because yok or the next session supplies it:

- the user's messages, copied: refer to them;
- a lead-in, greeting or framing for the next session: the note starts at `# Handoff`;
- a list of files to read first: the next stage's own skill names its files.

Keep the note under about 2,000 words. The step is done when the note at the path holds the
four headings, every decision made in this session and every piece of work still open has a
line under one of them, and the instructions' subject has its extra depth.

## 2. Reply

Reply with one line naming the note's path, then stop. yok watches for the turn to end.
