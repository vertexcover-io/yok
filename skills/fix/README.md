# fix

Fixes a list of things another stage found, test-first, one commit per item, and records what happened to each.

## When it runs

It is the `fix` node in `task`'s qa loop and in both workflows' review loop: each later pass of a loop runs it on the previous pass's list, then the reviewing stage runs again.

Standalone, invoke it with `/yok:fix` in Claude Code or `$fix` in Codex, on a fix list or the path of a JSON file holding one.

## What it does

- Loads the working instructions it shares with implement (`implement.working-instructions`): each package's test, typecheck and lint commands, the run's baseline, and the push rule.
- Fixes each item in order. An `askUser` item goes to the user first, and their answer is the item's `decision`. Every other item gets a failing test that reproduces its `trigger`, then the fix, then one commit naming its `id`. An item it cannot reproduce, or whose fix grows past its `size`, is left with the reason, and its failing test is discarded.
- Runs the full tests, typecheck and lint once every item is closed or left. A failing test that was checking the bug an item fixed is updated; any other new failure reverts that item's commits and leaves it. Then it pushes, in a run only.
- Writes the result file; `done` checks it with the stage's verifier in `scripts/fixes.ts`, and refuses a node given `source` and `round` that does not pass `fixes/SOURCE-ROUND.json`, or whose file does not answer each requested item once, in order, with a `decision` on every `askUser` item.

## Inputs and outputs

Reads `workspace` (where to work), `fixes` (the list of fix requests, or a path to one), and `source` and `round` (who sent the list and which pass of its loop this is). Consumes the `plan` artifact as context when there is one.

With `source` and `round`, produces the `fix-result` artifact, `.yok/RUN_NAME/artifacts/fixes/SOURCE-ROUND.json`: one entry per item, `closed` with its commit or `left` with its reason, each with the user's `decision` when they gave one. The stage output is one line: how many items were closed and left, and the pushed head.

## Files

- `SKILL.md`: the stage contract and the four steps.
- `scripts/fixes.ts`: the stage's verifier. `done` runs it on the `fix-result` file and refuses a malformed one.
- `evals/evals.json`: an eval suite.
