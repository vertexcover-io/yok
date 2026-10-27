# plan.md and phases/phase-N.md — the contract

Paths: `.yok/RUN/artifacts/plan.md` · `.yok/RUN/artifacts/phases/phase-N.md`.

The planner writes both directly. The user approves them and a coder builds from them, so they
are the whole record of the plan. Examples below use a neutral domain, user auth, unrelated to
the feature being planned.

## Who reads them

| Consumer | Reads | Uses it for |
|---|---|---|
| `implement` | `plan.md`, the `## Phase Breakdown` section | reads the digraph, builds the phases in order |
| a coder | one `phases/phase-N.md`, plus `plan.md` | what it builds, and the scenarios that prove it |
| `code-review`, spec persona | `design.md` and `plan.md` | the intent to review the diff against |
| `qa` | `plan.md`, the `## Design Frames` section | the frame and width each screen is checked against |

## Contents

- [Who reads them](#who-reads-them)
- [Fixed format — do not vary](#fixed-format--do-not-vary)
- [Writing for a coder](#writing-for-a-coder)
- [File references](#file-references)
- [Sections are available, not required](#sections-are-available-not-required)
- [phase-N.md](#phase-nmd)
- [Implementation steps](#implementation-steps)

## Fixed format — do not vary

Six things are matched by name or by shape. Rename or reshape one, and a downstream skill
fails without saying why.

| Item | Read by | Rule |
|---|---|---|
| the `## Phase Breakdown` heading | implement | exact text |
| the digraph inside it | implement | `digraph phases { … }`, one node per phase id, `pN -> pM` edges |
| the `## Acceptance` heading | the coder | exact text |
| `# Phase N: TITLE` and `Depends on:` | the coder | the first two lines of every phase file |
| scenario ids | tdd | the format in `test-scenarios.md`, unique across the whole plan |
| the `## Design Frames` heading | implement, qa | exact text |

Everything else is prose. The rules below govern it.

## Writing for a coder

**The coder sees one phase file and `plan.md`. Nothing else.** It cannot open a sibling phase
file. Never write "as in phase 2" or "the helper phase 1 builds" — name the thing, and put its
signature in the index.

**Write one reading.** A person asks when a sentence is ambiguous. A coder picks a reading and
builds it. A sentence carrying two meanings is a defect, not a style preference. Choose the
meaning and write that one.

**Every line competes with code.** The phase file loads into the coder's context beside the
files it must read. A line that does not change what the coder builds takes attention it needs
elsewhere.

The `writing-style` skill governs both files.

## File references

One rule everywhere in the plan: `step-card.md` — *Addresses*.

## Sections are available, not required

Include a section when it has content that meets its trigger. Omit it otherwise. An absent
section costs nothing. A thin one costs context, and it states "considered, nothing found" —
a claim you did not mean to make.

The floor is real: a small change can be its overview, approach, phases and their scenarios, and
nothing else. That is a complete plan.

**Write plan.md in the table's order.** A reviewer reads it top to bottom: what the plan builds
and how, the phases, what proves them, what was decided, and last the reference material a coder
looks up.

| plan.md section | Include when |
|---|---|
| `## Overview` | always — what the plan builds and for whom, the inputs it builds from (`design.md` and the ticket), and what it adds to them |
| `## Approach` | always — what gets built, where it sits in the code, and which existing code it reuses, in a few sentences |
| `## Diagrams and data changes` | the work has a flow, a structure or a state change worth drawing, or it changes stored data — mermaid diagrams, then each table, column, index and migration it adds or changes |
| `## Phase Breakdown` | always — one entry per phase, linked to its file, then the digraph |
| `## Signature index` | a name is defined in one phase and used in another |
| `## Global constraints` | something binds every phase and is invisible to one built in isolation — fixed values, verbatim copy, platform limits. A value used in one phase belongs in that step. |
| `## Blockers in existing code` | existing code must be repaired or worked around to build **or test** this |
| `## Test Matrix` | requirements exist — one row per requirement |
| `## Acceptance` | something is provable only after every phase lands |
| `## Assumptions` | the plan took a decision without asking anyone |
| `## Decisions` | the user answered a question during planning, or the code contradicted `design.md` and the user's answer changed it |
| `## ADRs` | the docs scout returned ADRs that bind this work, or this stage wrote a new ADR |
| `## Project Docs` | the docs scout returned docs under `docs/`, outside `docs/adr/`, that bind this work |
| `## Requirements` | there is no requirements document, so planning established the ids itself |
| `## Deferred` | work was deliberately excluded, or the design deferred it |
| `## Design System` | a project extension produced a component inventory — that extension owns the section's shape |
| `## Design Frames` | a design exists — always the last section |

No status fields — progress derives from git and the digraph. No file inventory, no patterns
table: those belong in the steps they govern. Which existing component draws each element of a
frame is the UI mapping of the step that builds it, per `step-card.md`.

### Phase Breakdown

**One entry per phase, opened by a link to its file.** The link's text is `Phase N: CAPABILITY`
and its target `phases/phase-N.md`; the plan page opens that phase when the reviewer clicks it.
Under the link: the repos it touches, what it builds and needs, and why the cut sits there.

**The digraph closes the section.** One node per phase id. An edge means "must land first".
`implement` reads it to order the phases.

    digraph phases {
      p1 [label="1: CAPABILITY"]
      p2 [label="2: CAPABILITY"]
      p1 -> p2
    }

### The signature index

**Flat, one line per new or changed signature, grouped by phase.** It exists because the coder
cannot open the phase file that defines the name, so duplication is the point of an index.

**The steps copy from it.** A step that uses a name another phase builds, or builds a name
another phase uses, carries that entry on its Uses or Provides line, per `step-card.md`. Every
entry is defined by a step; a name here that no step builds is a finding.

### Blockers

Only what must be repaired or worked around to build this — problems that block the work, or
make the new code hard to write, test, or understand. Each one gets a phase.

**A unit no test can construct is a blocker, even when the feature builds fine around it.** The
symptom shows up in the Test Matrix, not in the steps: rows climb to `e2e` because
nothing lower can reach the behavior. Name the shape that forces the climb, quote it, and give a
phase the step that opens it up. `test-scenarios.md`'s red flag says when to go looking.

Pre-existing problems in a file you happen to be touching are out of scope. A long list dilutes the entries that actually block. If a row's
resolution would be "leave the code as is", it is not a blocker — delete the row.

Quote the code. The coder matches the quoted text to find the place; four lines locate it, and
a paragraph describing it does not.

### Decisions

**One entry per answer that shaped the plan.** For a question the user answered: what was asked,
the answer, and the steps it changed. For a contradiction between the code and `design.md`: what
the design assumed, what the code shows, and what the design says now.

### ADRs

One row per ADR the coder must follow. The coder never sees the docs scout's results or
`docs/adr/`, and could undo a decision it was never told about.

    | ADR | Status | What it requires of this work |
    |---|---|---|
    | docs/adr/0003-postgres-only-datastore.md | existing | embeddings stay in Postgres |
    | docs/adr/0008-semantic-search-adds-vector-arm.md | new | keep the tsquery arm; add the vector arm beside it |

- **existing** — every ADR the docs scout returned.
- **new** — every ADR the `adr` skill wrote in this stage. A `covered by` result
  lists that existing ADR; a `dropped` result adds nothing.

### Project Docs

One line per doc under `docs/`, outside `docs/adr/`, that the docs scout returned — the path only.

    - docs/architecture/search.md
    - docs/runbooks/reindex.md

### Design Frames

**The last section: one row per screen**, copied from `design/INDEX.md` without its source
column — the screen, its file and its width. A coder building one phase in isolation reads which
screens are drawn, where, and at what width; qa reads each frame's width from it. The plan page
shows every frame as a card under this section.

**The step carries the frame; this section carries the paths.** The step that builds the screen
holds its Design line and UI mapping. A screen no step builds is a finding; where that is
deliberate, its row reads `design/FILE — not built: REASON`.

Omit the section when no design exists, and say so in the step instead, per `step-card.md`.

## phase-N.md

Header: `# Phase N: THE CAPABILITY TITLE`, then a `Depends on:` line.

| Section | Answers only | Must not contain |
|---|---|---|
| `## Goal` | why this phase exists, what it unlocks, and the `Done when` check it makes pass or the part of one it proves | file lists, steps |
| `## Implementation` | how, as ordered steps; each step names the signatures it uses from other phases and provides to them | scenario prose, done-criteria |
| `## Test Scenarios` | the behavior that proves it, grouped `### Unit` · `### Integration` · `### E2E` · `### QA Agent` — only the subsections this phase has | implementation detail, cross-phase flows |
| `## Commit` | the message | — |

**A seam lives on the step that crosses it.** The names a phase takes from earlier phases and
hands to later ones sit on the Uses and Provides lines of the steps that use or build them. The
scenarios are the definition of done. Cut content that restates another section.

## Implementation steps

A step is a **card**: a fixed set of parts. `step-card.md` carries the parts, their triggers,
and the register — read it before writing the `## Implementation` section, and write to it.

The card governs where things go and what they are called. It never governs how much a step says,
or which part carries the weight.

A step's change is a ```` ```diff ```` block — removed lines `-`, added lines `+`, a hunk header
`@@ -from,count +to,count @@` — under a line naming the file and range. The coder applies it; a
before-and-after pair makes them reconstruct it.

### Test-file steps

Not a step. The scenarios define what the tests assert. Where the *strategy* is a real
decision — what is faked, what is driven by data — it belongs in the matrix's strategy column.
