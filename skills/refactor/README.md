# refactor

How to assess code for refactoring and apply the change safely: what to look for, how to rank findings, and the techniques to use. Refactoring changes structure, never behaviour.

## When it runs

It is not a workflow stage. The `tdd` skill points to it for the REFACTOR step after tests go green, scoped to the code just written. You can also invoke it with `/yok:refactor` in Claude Code or `$refactor` in Codex, or ask to clean up a module; it then asks what to focus on and never refactors "everything".

## What it does

- Fixes the scope: the last GREEN step's code, or the file, module or last commit the user names.
- Commits the working code first as the rollback point.
- Scans eight dimensions: naming and language conventions, structural simplicity, knowledge duplication, abstraction, immutability and purity, functional patterns, consistency across peer modules, and test code quality.
- Ranks each finding Critical, High, Nice or Skip and writes a short assessment with the recommended actions.
- Applies one technique at a time (extract function, guard clauses, dispatch table, parameter object, inline, and so on), running the tests after each step. Red means undo and take a smaller step.
- Commits the refactor separately from the feature, with a `refactor:` subject.

## Files

- `SKILL.md`: modes, the eight dimensions, the smell and technique catalogue, priority table and checklist.
- `evals/`: an eval suite with Python and TypeScript fixture files.
