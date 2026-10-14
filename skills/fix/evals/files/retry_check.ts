// Copied into the scratch repo as task_manager.test.ts; named so the repo's own suite skips it.
import { expect, test } from "bun:test";
import { createTask, deleteCompletedTasks, getTask, runTask } from "./task_manager";

test("a failed task stays listed so the user can retry it", async () => {
  const task = await createTask("sync", 1);
  await runTask(task.id, () => {
    throw new Error("network down");
  });
  deleteCompletedTasks();

  expect(getTask(task.id)?.status).toBe("failed");
});
