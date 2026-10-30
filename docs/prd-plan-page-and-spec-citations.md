# Plan page and spec citations: review a UI plan with the frames in place

## Why

PR #45 (design references) makes every stage use the ticket's screenshots and the written spec.
Reviewing the result is still hard. The plan and its phase files are markdown, so a reviewer
reads "build to `design/02-new-app.png`" and opens the picture by hand. The phase files quote
the rules out of `design/spec.md`, so the same rule lives in two places and drifts the first
time someone edits one of them. And a multi-state HTML mock was shot as one tall board, so a
step that builds one state points at a picture of ten.

This document adds one generated review page, makes the phase files cite the spec instead of
copying it, and keeps the screenshots one per screen. Follow-up to `docs/prd-design-reference-verification.md`.

## Goals

- One file, `artifacts/plan.html`, that a reviewer can open in yok view or receive on its own
  and see the plan, each phase, the frame each step builds to, and the spec that step points at,
  without opening anything else.
- The page is generated from the markdown, never written by the agent, and never stale when the
  reviewer sees it.
- A rule from `design/spec.md` is written once. Phase files point at the part of the spec a step
  must satisfy; planning, implement, qa and the page all read the same file.
- Implement reads the frame and the part of the spec a step points at before it writes the first
  test of that step.
- Everything design-related sits in `artifacts/design/`: the ticket's screenshots, the HTML mock,
  `INDEX.md` and `spec.md`.

## Non-goals

- One HTML file per phase. The page shows one document at a time, but it is one file.
- Agent-authored HTML, or a template the agent fills by hand.
- Per-state screenshot tooling in ticket-fetcher. A sentence in the skill is enough.
- Changing what implement consumes. It is given the markdown plan artifact, never the page.
- Pixel diffing, or any change to how qa grades a screen. Only where qa reads the rules from changes.

## What changes

### 1. Ticket-fetcher: the ticket's screenshots are the frames

The screenshots attached to the ticket are the frames. An HTML mock only fills in a screen or a
state the attachments do not show. The skill says, in a line or two, to shoot one screenshot per
screen or state and never the whole mock page. Nothing else in ticket-fetcher changes. Every
design file stays in `artifacts/design/`, in one place.

### 2. Planning: point at the spec, do not copy it

A step that builds a surface names its frame and, on its own line, points at the part of the spec
it must satisfy:

```
Build to design/02-new-app.png.
Spec: design/spec.md — the New app modal and Modal shell parts
```

The text after the dash is free text naming the part in words. Nothing parses it: `spec.md` has
no fixed format, so there are no section numbers to check. The "the frames settle the following"
bullets and any quoted rule text go away. The plan verifier still rejects a frame that no step
builds to.

### 3. The page: `artifacts/plan.html`

A generator in core reads `plan.md`, every `phases/phase-N.md` and `design/INDEX.md` and writes
one page. It uses the viewer's own markdown renderer and stylesheet, so diffs, headings and colours
match yok view. Layout: a list of Plan and each phase on the left, hash routed so `#phase-3` deep
links; an outline of the shown document; content centred at a 1180px cap. Under a step that
names a frame, the frame appears as a card sized from the image's pixel aspect; several frames
sit in one wrapping row; clicking opens the harness-style lightbox (Esc, backdrop or ✕ closes,
no zoom toolbar). Under a step with a `Spec: design/spec.md` line, the whole spec renders in a
closed block whose summary repeats the line's free text; the reviewer opens it to read. The spec
is rendered once and shared by every block. Images are embedded once, so the file stays small. A `yok` subcommand exposes the same
generator for standalone use.

### 4. `await-approval` builds the page

When planning calls `await-approval`, the command rebuilds `artifacts/plan.html` from the current
markdown before it blocks. A generation error fails the stage instead of showing a stale page.
The planning skill never runs the generator, so a reviewer cannot see a page older than the
markdown: every edit the reviewer asks for goes through the same call. Planning registers two
artifacts, `plan` (plan.md) and `plan-page` (plan.html). The approval request and the Slack
notifier link to the page.

### 5. Implement: read before build

For a step that names a frame or has a `Spec:` line, implement opens the frame and reads
`design/spec.md` for the part the line names before writing the step's first test, then checks
the finished screen against them after. There is no helper command: the line is free text, and
implement reads the spec file itself.

Implement is handed the markdown plan artifact only.

### 6. QA: rules come from the citations

`specRules` for a scenario are the rules of the part of `spec.md` the step's `Spec:` line names,
read from `spec.md`, not text copied into the phase file. Design coverage is unchanged from PR #45.

## Build order

1. Ticket-fetcher sentence and planning's `Spec:` line.
2. Implement's read-before-build rule; qa's `specRules` source.
3. Generator into core, the `yok` subcommand, `await-approval` rebuild, the two artifacts, and the
   approval and notifier links.

## Open

- Whether `done` should also compare a hash of the inputs stored in the page, as a backstop
  against a page edited by hand. Not needed if only `await-approval` writes it.
