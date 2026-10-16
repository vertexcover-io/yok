---
name: review-regression-tests
description: >
  Review the regression tests against the approved scenarios in plan.md and the testing
  standard, and return the findings as a fix list. Never edits files. Runs as the
  review-regression-tests node in the regression workflow's review loop, after
  write-regression-tests.
summary: Say the verdict, which pass this was, and how many findings are open.
mode: inline
allowed-tools: [Agent, Bash, Read, Write, Grep, Glob, Skill]
tier: deep
outputs:
  description: The verdict, the report path, and the findings to fix.
  schema: review-regression-tests.output.v1
  module: scripts/review.ts
consumes:
  - artifact: plan
produces:
  - artifact: test-review
protocols: []
scopes: []
references:
  review:
    path: references/review.md
    description: The brief for the sub-agent that checks the tests against the approved scenarios.
---

# Review Regression Tests

Review the regression tests write-regression-tests wrote, and hand back what needs fixing. You never
change a file but your report; on a later pass of the review loop, write-regression-tests fixes the
findings first.

The input may hold `workspace`, the create-workspace stage's output; review in each repo's
`worktreeDir`, or the current checkout without it. It may also hold `round` and `rounds`: which
pass of the review loop this is, and how many it runs at most. RUN below is the run's spec name.

**This runs unattended: ask the user nothing.**

## 1. Gather the change

Read `.yok/RUN/artifacts/plan.md` and `.yok/RUN/artifacts/implementation.md`, which maps each
scenario to its test and names the commands that run them. Get the test diff in each repo: the
run's branch against its base.

## 2. Review in parallel

Start two fresh sub-agents in one message, so they run in parallel. Neither edits files. Give
each the diff, the files it touches, which test covers each scenario, and the commands that run
the new tests.

- **Plan review.** Its brief is the `review` reference
  (`yok orchestrate skill ref review-regression-tests.review`), plus the path to `plan.md`.
  Tell it the ticked scenarios (`- [x]`) are the plan; an unticked one is out of scope.
- **Test quality.** Its brief is the testing persona: the file at
  `yok orchestrate skill ref code-review.testing --path`, and the files it names, read relative
  to that path. Tell it to report findings without editing files.

## 3. Build the fix list

Check each finding against the code, and drop the ones that are wrong, with the reason in the
report. Drop a test quality finding whose fix would stop the test covering its scenario's Given,
When or every Then. Merge findings that name the same problem.

Number the rest by label: `test-N` for a test that does not do what its scenario says or a test
quality finding, `plan-N` for code that differs from the plan in a way that looks intended,
`product-N` for code that looks wrong. Each finding has `id`, `summary` (what is wrong),
`trigger` (how it shows), `hint` (the suggested fix), and `file` and `line` when it has them.

When the plan review returned BLOCKED, finish the stage with `--error -` and its reason and
failing command.

On the last pass (`round` equals `rounds`), no fix comes after you: list every open finding
in the report as left for the person.

## 4. Report and finish

Load `writing-style`, then write `.yok/RUN/artifacts/test-review.md`: the pass, the scenario
table from the plan review, each finding, and each finding dropped with the reason.

Finish the stage with
`--artifact '{"type":"test-review","name":"test-review","path":"artifacts/test-review.md"}'`
and a JSON output: `verdict` (`APPROVED` or `CHANGES_REQUESTED`), `report`
(`artifacts/test-review.md`) and `findings`, the list from step 3. `verdict` is `APPROVED`
exactly when `findings` is empty.
