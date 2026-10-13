# Slice reviewer prompt

Fill in `REPO`, `SLICE_FILES` and `NEIGHBOUR_FILES`, then send this to one subagent per slice.

---

You are auditing the test suite of the repo at REPO for redundant tests. READ-ONLY: do not edit,
create or delete any file in the repo. Do not run the full test suite; you may run single files.

YOUR SLICE (read every test in these files fully, plus the source they test):
SLICE_FILES

Also check overlap against tests outside your slice where relevant (grep is fine), especially:
NEIGHBOUR_FILES

Flag tests that are:

1. DUPLICATE — asserts the same behaviour as another test (same or another file), even if worded
   differently.
2. SUBSUMED — another layer already proves it: an e2e test re-checks a branch a unit test owns, or a
   unit test re-checks what one e2e test proves. Say which one to keep and why.
3. PARAMETERIZABLE — several near-identical tests differing only in input that could collapse into
   one `test.each` (this cuts count, not coverage; list separately).
4. LOW-VALUE — checks only the framework or schema library, a constant, a mock called with what the
   test just passed, or the text of a shipped file.

Evidence rules:

- Flag a pair only if you read both tests and can name the exact shared assertion.
- Do not flag a test that covers a distinct edge case or error branch.
- Keep an e2e test that is the only proof of a real wiring path.
- Note modules with no unit tests whose branches are proved only by slow e2e tests.

OUTPUT (your final message, markdown, no preamble):

## Slice summary
- tests read: N, flagged for removal: N, flagged for merge: N

## Remove
One line per test: `file:line` — test name — category — kept by `file:line` (or "none, low-value") —
one-line reason.

## Merge into test.each
Group: list of `file:line` — what varies — resulting single test.

## Cross-slice notes
Structural patterns, each with a rough count of tests affected.
