# code-quality

The coding standard the other skills write and review against: strict types, immutability, pure functions, small composable functions, and a gate on when to extract a function. It applies to any language, with a reference each for TypeScript and Python.

## When it runs

No workflow runs it as a stage. It applies whenever an agent writes, reviews or refactors code: the `implement` stage loads it, and `code-review`'s Defects and Simplify reviewers check against it. You can also load it yourself:

- Claude Code: `/yok:code-quality`
- Codex: `$code-quality`

Pass a path to a standards file as the argument to put it at the top of the priority list.

## What it does

1. Reads standards in priority order: the argument file, `.claude/yok/code-quality-reference.md`, the repo's own documented standards (`CONTRIBUTING.md`, `CLAUDE.md` and the like), the language reference, then its own defaults. A higher source can add or override a rule; it cannot silently remove one.
2. Bans type escape hatches: `any`, `as Type` and `@ts-ignore` in TypeScript; `Any`, `# type: ignore` and `cast()` in Python.
3. Requires immutable data, pure core logic with side effects at the boundaries, early returns, declarative transformations, and named parameters for functions with three or more arguments.
4. Gates every extraction: a function earns a name only for reuse, for organizing a large body, or for a body a reader cannot decode on sight. A file of two-line helpers is the failure it exists to prevent.
5. Limits comments to ones that are load-bearing, represents expected failures as values rather than exceptions, injects dependencies that cross an I/O boundary, and validates with schemas at trust boundaries only.
6. Ends with a checklist to run before calling code complete.

## Files

- `SKILL.md`: the rules, the extraction gate with examples, and the checklist.
- `references/typescript.md`: strict mode, schema-first boundaries, branded types.
- `references/python.md`: strict type checking, Pydantic validation, frozen dataclasses.
- `evals/`: eval cases and the sample files they review.
