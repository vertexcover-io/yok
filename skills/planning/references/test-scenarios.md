# Test Scenarios — every outcome the feature needs, in the fewest tests

The plan lists every outcome that must hold for the feature to ship, gives each one home, and
packs the outcomes that need a test into as few rows as it can. Work in this order, once the
phases' steps are written: list the outcomes, compare with a second list, give each outcome a
home, pack the rows, write the rows, build the matrix, check the set.

## 1. List the outcomes

An outcome is one fact an actor can observe that must hold for the feature to ship. Write each
as one line, numbered `On`, with the id of every source that states it. Where a source carries
no id, number it in plan.md's `## Requirements`.

**From what the feature must do** — each stated requirement, acceptance criterion and named
scenario, each `Done when` check of the design, and each constraint and assumption in plan.md
that changes what an actor observes. Write one outcome for every answer the source has:

- **who may** — the result each permitted actor gets
- **who may not** — the refusal each other actor gets, at the boundary that can refuse it
- **which inputs** — each value that changes the result, and each edge value the input can take
  in use: empty, absent, duplicate, malformed, boundary
- **which variants** — each named variant the feature treats differently, as itself
- **what is saved** — it reads back in its original shape, on the normal read path

**From what the steps change** — each diff, read as written. Write one outcome for every answer
the change has:

- **what crosses** — where the change adds or alters what one piece sends another, the receiver
  acts on it
- **what fails** — what the actor meets when a reply is lost, late or refused
- **who collides** — the result when two actors act at once
- **what came before** — data saved before this change, and a caller built before it
- **what should have ended** — access after it is revoked
- **what stays** — an existing behavior an actor outside this feature observes, in code the
  change modifies; label it `(regression)`
- **what deploy needs** — a release order, a migration or a state of production data the
  feature depends on

**Each `Done when` check also gives one journey outcome:** the path an actor takes carrying the
feature from their first action to the result the check names, in one line. Label it `(journey)`.

**Each frame the plan builds, and each `design/spec.md` rule only eyes can judge,** gives one
outcome labelled `(design)`.

**Write an outcome one home can prove whole.** Split an outcome whose parts need different
levels into one outcome per part.

## 2. Compare with a second list

Dispatch one sub-agent with the design, plan.md, the phases' steps and step 1 of this reference,
never your own list. Two outcomes are the same when one bug would break both. Add every outcome
it lists that yours lacks, and keep every outcome yours has that it lacks.

## 3. Give each outcome one home

| Home | Holds an outcome that |
|---|---|
| a coded test at `unit` | one function or component, constructed alone, makes true or false |
| a coded test at `integration` | needs the real pieces of one running process together |
| a coded test at `e2e` | needs pieces that run separately, started as they run in use, or a rendering browser |
| a QA walk, `qa-agent` | is labelled `(journey)` or `(design)`, or needs the feature's real surroundings; the QA agent (the `qa` stage) drives it after all phases land |
| `existing: TEST` | a test the repo has, and the plan keeps, already proves by reaching the code the outcome is about |
| `deploy: CHECK` | is a release order, a migration run or a state of production data; write the check in plan.md's `## Acceptance` |
| `ask: QUESTION` | needs a product or design decision, or names something no step builds |

- **Choose the cheapest level that exercises the outcome for real.** An outcome climbs a level
  when the level below would have to fake the thing the outcome is about.
- **Give every flow the feature exists for an outcome at `e2e` as well,** wherever a coded test
  can drive it through the product's own surfaces, so the flow keeps running on every later
  change. Word it as what that test proves; a QA walk of the same flow may repeat part of it.
- **Produce a failure where it happens.** An outcome about a lost, failed or refused reply sits
  at the level that makes the real boundary fail; where no coded test can, it goes to a QA walk.
- **An outcome a plain function could decide, held in code no test can construct alone,** is a
  `## Blockers in existing code` entry with a phase step that opens it up, and sits at `unit`.
- **A test library or helper the level needs and the repo lacks** is added by a phase step.
- **An outcome the planned steps would fail** is a defect in the steps: correct the step, and ask
  the user where the correction changes the design.

## 4. Pack the rows

A row is one starting state and one trigger, at one level.

- **Put every outcome observable in that scene into the row.**
- **Keep inputs as cases of one row.** A case changes one input value and nothing else.
- **Open a new row** for a different actor, starting state, trigger or level.
- **Gather the `e2e` outcomes along one journey into one row,** on the shortest path that
  crosses them. Extend the existing `e2e` test where one drives that journey; the row's `Given`
  names it.
- **Merge what an `e2e` or `qa-agent` row proves along its one path into one outcome,** worded
  from the actor's first action to the last result, carrying the sources of every outcome it
  merges.
- **Place a row in the phase that makes its last outcome true.**

## 5. Write the rows

Write a phase's scenarios as **one table** under its `## Test Scenarios` heading, ordered by
level with `unit` first and `qa-agent` last:

| Column | Holds |
|---|---|
| `ID` | `SCn`, unique across the whole plan; `tdd` carries it in the test title. Mark a row whose outcomes are all kept behaviors `SCn (regression)`. |
| `Scenario` | the scene's main outcome, present tense |
| `Given` | the starting state and the trigger, as one situation; a row with cases lists them |
| `Expected` | one line per outcome, opened with `•` and the outcome's id; a case line names its case |
| `Level` | `unit`, `integration`, `e2e` or `qa-agent` |
| `Traces` | the source ids of the row's outcomes |

**State behavior.** `Expected` holds only what an actor observes, asserted at the outermost
boundary the row's level reaches, and stays true through any refactor that leaves the actor's
experience unchanged. A `Given` may name a file.

**Every row reads on its own.** Write each cell in full, so a reader holding only that row can
set it up, run it and judge it.

**The `Scenario` cell is the line the user reads at the plan gate.** Write the negative half
into `Expected` where it matters, in bold.

**A `(design)` outcome's line reads `design`** after its id, then the state of the screen, the
`design/FILE` and its width, or the spec part.

**One cell, one line of markdown.** Break a cell into lines with `<br>`: each `•` outcome in
`Expected`, and each numbered setup step in `Given` when the setup is staged. Escape a `|` inside
a cell as `\|`.

## 6. Build the matrix

Write one row per outcome in plan.md's `## Test Matrix`, grouped by source:

| Column | Holds |
|---|---|
| `Outcome` | `On`, its label where it has one, then the outcome in one line |
| `Source` | the ids of the sources that state it |
| `Type` | the level its home proves it at: the scenario row's `Level`, the level of an `existing:` test, or `deploy` on a `deploy:` home |
| `Home` | exactly one of: the scenario id · `existing: TEST` · `deploy: CHECK` · `ask: QUESTION` |

**Then number the outcomes `O1`, `O2`, … down the matrix,** and rewrite each id in the phase
files' `Expected` lines and in `## Acceptance` to match.

## 7. Check the set

- **Every source has an outcome.**
- **Every outcome has one home and that home's type,** every `Expected` line opens with the id of
  an outcome whose home is that row, and the matrix is numbered in order. The planning stage's
  `done` checks all of these.
- **Every `deploy:` outcome has its line in `## Acceptance`.**
