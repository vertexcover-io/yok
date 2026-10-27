---
signal: Use when a function calls several Result-returning functions and only passes their errors up
paths: ["packages/core/src/**/*.ts", "packages/server/src/**/*.ts", "packages/cli/src/**/*.ts"]
tags: [errors, result]
strength: default
---
# Don't pass a Result up unchanged; unwrap it and catch once where the error is handled

`if (!x.ok) return x;` does nothing with the error. It only passes it up, the way `throw` would.
Writing that line after every call is `throw` by hand.

So:
- At each call, use `unwrap(...)` from `packages/core/src/agents/common.ts`. It returns the value,
  or throws the error.
- Catch once, in the function that does something with the error: logs it, records it as the
  step's outcome, or shows it to the user.
- The functions in between return plain values (`boolean`, `void`, a small union).

The test: between the call and the catch, does any line read `.error`? No → unwrap. Yes → that
function needs the `Result`.

Keep `Result` when:
- the function's callers expect one (`ITerminal`, `IAgentProvider`, an orchestrate reply). Unwrap
  inside, catch at that function's own edge;
- errors are data, such as a validation that lists every problem;
- the caller handles different errors in different ways.

**Occurrences:**
- 2026-10-25 · PR #41: `context-step.ts` passed tmux and engine Results up through five functions, with two overlapping enums; replaced by `unwrap` and one catch per step

**Stale when:** `unwrap` is removed from `packages/core/src/agents/common.ts`.
