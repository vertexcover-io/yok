#!/bin/sh
# Builds the scratch repo for eval 3: a fix commit for defects-1, then a revert of it, as a fix
# stage leaves the branch when it stops after step 3 reverted a fix.
set -eu
dir="$1"
here="$(cd "$(dirname "$0")" && pwd)"
mkdir -p "$dir"
cd "$dir"
git init -q -b main
git config user.email eval@local
git config user.name eval
cp "$here/../../../code-review/evals/files/eval2_task_manager.ts" task_manager.ts
git add task_manager.ts
git commit -qm "feat: add task manager"

sed 's/    const result = handler(task);/    const result = await handler(task);/' task_manager.ts > task_manager.ts.new
mv task_manager.ts.new task_manager.ts
cat > task_manager.test.ts <<'TEST'
import { expect, test } from "bun:test";
import { createTask, runTask } from "./task_manager";

test("defects-1: a handler that rejects marks the task failed", async () => {
  const task = await createTask("sync", 1);
  const ran = await runTask(task.id, async () => {
    throw new Error("network down");
  });
  expect(ran.status).toBe("failed");
});
TEST
git add task_manager.ts task_manager.test.ts
git commit -qm "fix(review-2 defects-1): await the handler in runTask"
git revert --no-edit HEAD >/dev/null
