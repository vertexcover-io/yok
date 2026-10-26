# design.md — format

Path: `.yok/RUN/artifacts/design.md`. The first gate: a person reads it in under a minute
and says whether the shape is right, before anyone builds a full plan. The planning stage
builds from it, so it must stand without the conversation that produced it.

## What belongs

Every line passes the skill's test: if this answer changed, would the plan look different?
Cite `file:line` for a claim about the code as it is today. Say each thing once.

## Caps

Hard caps, on how many things the page says and on how long each is.

| Block | How many | How long each |
|---|---|---|
| `Problem` | 1 | two sentences |
| `Approach` points | 6 | one or two sentences |
| Rejected | 1 per approach turned down | one line |
| Diagrams | 1 | about 10 nodes |
| `Non-goals` | 3 | one line |
| `Screens` | one per `design/INDEX.md` row | one line |
| `Decisions` | 3 | one line |
| `Risks` | 3 | one line |
| `Hard to undo` | 1 | one line |
| `Unsure` | 3 | one line |
| `Done when` checks | 5 | one line |

A line is one sentence that says one thing. Fit the reason into the same sentence; a second
sentence on a line is a sign the line holds two things.

## Template

Write the blocks in this order, each under a `##` heading: the viewer builds its outline and
each comment's location from those headings. `Problem`, `Approach` and `Done when` are always
present; `Decisions` whenever a fork was taken. Every other block appears only when it holds
something that passes the test; otherwise drop it, heading included. A one-line fix gets a
60-word doc; a new subsystem gets the page.

````markdown
---
status: draft            # approved once the user confirms
route: full              # atomic when step 1 takes the atomic route
task: One line naming what is being designed
---

# TITLE

## Problem

Why this exists, who has the problem, and the outcome they want. Two sentences, citing where
the pain shows in the code or the ticket.

## Approach

1. Numbered points in the order the work flows: what starts it, what handles it, what it
   reuses, what comes back.
2. …

Rejected: one line per whole approach the user turned down, with the trade-off that lost.

```mermaid
flowchart LR
  …
```

## Non-goals

- What a reader could reasonably expect this to do, and it will not.

## Screens

- `design/FILE` — what this frame settles for the build: the components and states it draws.

## Decisions

- D1 *(user)*: what we do, instead of the alternative, because the reason.
- D2 *(agent)*: …

## Risks

- A gap in the task that bites, and what it costs if ignored.

## Hard to undo

What this locks in that every caller will depend on.

## Unsure

- What the task left unclear and nobody settled, and the reading the design took.

## Done when

- A check a person or a test can run after the build: the actor, the action, the result.
````

## Block rules

- **Approach**: each point names a component or a step in the flow, read top to bottom as the
  work runs. A point that names a file or a phase belongs to planning.
- **Rejected**: only approaches the user was shown in step 4 and turned down, or an obvious
  path a reader would ask "why not?" about. An alternative to one decision goes in that
  decision's line, not here.
- **Diagram**: one, placed after `Approach`, only when it shows what a paragraph would hide;
  a small change has none. `flowchart LR` for what talks to what, `sequenceDiagram` for
  order, `stateDiagram-v2` for states, `erDiagram` for records. Name boxes as the code does.
  Show only new or changed parts plus what they touch, about 10 nodes, new parts marked
  `classDef new fill:#e6f4ea,stroke:#1e8e3e` and `class NodeId new`. Quote labels holding
  punctuation.
- **Non-goals**: things that could reasonably be goals and are chosen not to be, so the plan
  cannot grow into them, and every fork the user chose to leave for a later build. Two or
  three lines.
- **Decisions**: one line per fork that changes the shape, highest impact first; a fork that
  changes only code is planning's. Name the mechanism: the service, the key, the value. Tag
  the origin on every line: *(user)* when the user answered the question, *(agent)* when the
  stage closed it on the user's behalf. Cite the ticket or a `file:line` in the reason where
  one drives it.
- **Screens**: only when `design/INDEX.md` exists, one line per row. The rules in
  `design/spec.md` go in one `Decisions` line.
- **Risks**: gaps in the task that bite, not a checklist. Each says what it costs if ignored.
- **Hard to undo**: the one thing approving commits every caller to: a table other code will
  write to, a contract other callers will depend on, a dependency that stays in the build.
  Name it and the decision that creates it. Drop the block when nothing is hard to undo.
- **Unsure**: the stage's own gaps in reading the task, with the reading it took: a sentence in
  the ticket that reads two ways, a term the task uses that the code does not, a claim about
  what exists that no one could confirm. Each line names the gap and the reading, so the user
  can correct it at approval and the planner knows it was a reading, not a fact. Risks in the
  system belong in `Risks`; forks the stage closed belong in `Decisions`.
- **Done when**: three to five checks, each naming the actor, the action and the observable
  result. Planning names a test for each; the Spec reviewer checks the diff against them.
- **Working state**: none in this file. The decision tree from step 2 and whatever else the
  stage needs if the session resumes live in `.yok/RUN/design-tree.md`, outside `artifacts/`,
  so the approval viewer never shows them. Deleted at approval.
- No component table, contract sketches, failure tables, phases or test plans. Those belong to
  planning.
