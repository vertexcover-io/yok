# Test Scenarios — what to test, at which level

One row per requirement in plan.md's `## Test Matrix`: **requirement · level · strategy ·
phase**, ordered by level — `unit` first, `qa-agent` last — so the pyramid is visible at a
glance. Each scenario is written out in the phase file that proves it — in
full, exactly once, never restated elsewhere or replaced by an id-only pointer. A flow
provable only after every phase lands rows to plan.md's `## Acceptance`; the phase that
completes the journey authors and runs it. Examples here use a neutral domain (user auth)
unrelated to the feature being planned.

## Derive what to test

The finished set is a **basis**: every scenario is a direction no other scenario covers, and
together they span the behavior. Both halves bind — a row that spans nothing new is dropped
or folded into the row that already covers it, and a gap left by folding is a missing row,
not a saved one. The gate on each row: **name the failure only it catches.** Two rows no
single bug can tell apart are one row.

Start from what the PRD already gives — stated requirements, acceptance criteria, named
scenarios — and cite their ids. Then add what it implies but does not say:

- the negative/failure half of every requirement that has one
- edge cases: empty, absent, duplicate, malformed, boundary value
- state transitions beyond create (edit, delete) and the round-trip: saved data reads
  back in its original shape, on the normal read path
- config- or data-driven behavior: vary the driving data and assert the output follows —
  never assert a constant
- every capability an actor exercises across screens or services: one flow scenario per
  named variant — a variant is never covered by substituting a peer
- **the enforcement negative** — a gated requirement ("only an admin deletes") needs its
  rejection asserted at the boundary that can actually reject the write, not only the UI
  that hides the button. Assert the desired rejection even when today's code would accept
  it — flag the gap, never invert the assertion. When no in-scope boundary can reject it,
  record that omission as a one-line decision in the phase file; never fabricate an API
  test.
- **regression, when shared code is touched** — every existing behavior flowing through
  code this plan modifies gets a scenario asserting it is unchanged, one per named
  variant, labelled `(regression)`. When the source doc names no such requirement, add
  the requirement and note the gap.

Before writing phase files, pair every source item (requirement, edge case, risk, named
variant, "shall not change" clause) with the scenario id(s) covering it, then read the
pairing back the other way — as scratch work, never as an output section. Forward, it
catches what a linear read misses: the third variant, the enforcement negative, the plain
create-then-read. Backward, it proves the basis: a scenario pairing to nothing is dropped,
and scenarios pairing to the same item survive only where each names a failure the others
miss.

**Red flag:** two scenarios sharing a `Given`, or one whose named failure another already
catches. Both are one scenario.

## Behavior, not implementation

A scenario states an **observable outcome** for an **actor** (user, API caller, another
service) given a starting state and a trigger. It never names a private function, a call
order, or an internal data shape — so it stays true across refactors.

| Implementation (rewrite it) | Behavior |
|---|---|
| "`hash(pw)` returns a 60-char string" | "the stored password is not the plaintext; the right password verifies, a wrong one doesn't" |
| "`buildOptions()` calls `config.filter`" | "a viewer-role editor offers read only — never delete" |

The litmus: **if the assertion would change when internals are refactored without changing
what the actor experiences, rewrite it.** Assert at the outermost stable boundary —
rendered output, the public method and its persisted effect, the HTTP response. Naming a
file in the setup is fine; the expectations assert only what an actor observes.

## Format

Write a phase's scenarios as **one table** under its `## Test Scenarios` heading, one row per
scenario, ordered by level with `unit` first and `qa-agent` last:

| Column | Holds |
|---|---|
| `ID` | `SCn`, unique across the whole plan; `tdd` carries it in the test title. Mark a regression `SCn (regression)`. |
| `Scenario` | the one observable outcome, present tense, with no rationale clause |
| `Given` | the starting state and the trigger, as one situation |
| `Expected` | every outcome observable in that situation, each on its own line opened with `•` |
| `Level` | `unit`, `integration`, `e2e` or `qa-agent`, chosen as the next section says |
| `Traces` | the requirement, edge-case and risk ids the row proves |

**One cell, one line of markdown.** Break a cell into lines with `<br>`: each `•` outcome in
`Expected`, and each numbered setup step in `Given` when the setup is genuinely staged. Escape a
`|` inside a cell as `\|`.

**The `Scenario` cell is the line the user reads at the plan gate.** It states the outcome alone;
the `Given` and `Expected` cells supply the why by being concrete. Write the negative half into
`Expected` where it matters, in bold.

**One `Given` is one scene.** Every outcome observable in it belongs to that row's `Expected`,
however many facts that is. A second row is earned by a different starting state or a different
trigger, never by a further fact visible in the same scene. A `Given` joining two independent
conditions with "and" is either staged setup or two rows.

**Trace every row.** A row with an empty `Traces` cell is dropped, or flags a missing requirement.

## Choose the level — pyramid, not ladder

Four levels:

- `unit` — a function or component constructed and asserted on its own
- `integration` — real pieces wired together: an API route with its store, a component
  with its children, a service against a real (local) dependency
- `e2e` — a browser or full system driving the feature as an actor would
- `qa-agent` — a property no automated assertion can check: visual correctness, copy tone,
  "does this feel right" judgments. These rows are not coder-written tests — the QA agent
  (the `qa` stage) drives the running app after all phases land and films
  the proof. Use it for what genuinely needs eyes, never as an overflow bucket.

Pick the **lowest level that gives confidence** (heuristic:
`../../tdd/references/integration-e2e.md`): the finished matrix leans heavily on `unit`
rows, carries some `integration` rows, and holds few `e2e` rows.

An e2e row is earned only by a fact no lower level can see — computed layout, focus,
navigation, a cross-service journey. Two checks before accepting any climb:

- **Code shape is never a reason.** If the behavior would test at `unit` in a plain
  function but the unit cannot be constructed in a test alone, that is a `## Blockers in
  existing code` entry with a phase step that fixes it — not a silent level climb.
- **A missing tool is a step, not a reason.** A test library or helper that does not
  exist yet gets added by a phase. The reverse climb is also wrong: a level that cannot
  see the property proves nothing — jsdom measures nothing, so sizes, truncation, and
  overflow stay in a browser however small the unit.

**Red flag:** more than a third of rows at `e2e`. Account for every one — a real-browser
fact keeps its row; anything else traces to a named Blocker.

The strategy column tells the coder what the scenario leaves open: what is faked, what is
diffed, what is data-driven. A requirement with no row means the plan is incomplete or the requirement is
not real — both are findings.
