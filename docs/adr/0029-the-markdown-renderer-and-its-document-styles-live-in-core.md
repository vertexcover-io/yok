---
status: active
date: 2026-10-26
source: docs/prd-plan-page-and-spec-citations.md
tags: [core, harness-server, orchestrate-script]
---

# The markdown renderer and its document styles live in core, shared by yok view and the plan page

## Context and Problem Statement

`await-approval` (core) must build a page that renders markdown exactly as yok view does, but the renderer and its styles lived in the server, and the server depends on core, so core cannot import them.

## Considered Options

- Move `renderMarkdown`, its diff highlighting, the repo-file helpers and `doc.css` into core; the server imports them
- Give core a second markdown-it setup and stylesheet, and leave the viewer's alone
- Build the page in the server, with `await-approval` calling a server route

## Decision Outcome

Chosen: move the renderer and styles into core, because it is the only option where one renderer serves both surfaces and `await-approval` works without the server. A second copy would drift from the viewer the first time either changes, and a server route breaks the rule that orchestrate commands call core directly and never the server (`docs/guide/03-core-principles.md`), and would fail whenever the server is down. Core takes `markdown-it` and `highlight.js` as dependencies.

## Consequences

A change to how markdown renders, in yok view or plan.html, is made in `packages/core/src/markdown.ts` and `doc.css`. The viewer page carries a `{{DOC_STYLES}}` slot filled from core.
