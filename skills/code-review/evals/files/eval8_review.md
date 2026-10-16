# Code review: task manager

- Date: 2026-10-13
- Scope: `task_manager.ts`, the run's branch against its merge-base with `main`
- Plan: `skills/code-review/evals/files/eval2_plan.md`
- Reviewed head: task-manager aaaaaaa (pass 1)

The change adds an in-memory task manager: create, look up, run and list tasks, with events for each step.

**Verdict: `CHANGES_REQUESTED`**

### Defects

- **defects-1 · High · small** `task_manager.ts:44` — `runTask` calls `handler(task)` without `await`. `task.result` holds a pending promise, and the task is marked `done` before the handler finishes. A handler that rejects never reaches the `catch`, so the failure is lost as an unhandled rejection. Trigger: any caller runs a task whose handler is async. Fix: `await handler(task)`; it must keep the `failed` path for a handler that throws.

### Spec

Nothing found.

### Security

Nothing found.

### Testing

Nothing found.

### Simplify

Nothing found.

## Left unfixed

Nothing yet.

## Summary per axis

- Defects: 1 finding; worst is defects-1.
- Spec, Security, Testing, Simplify: 0 findings.
