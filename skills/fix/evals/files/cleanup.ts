interface Task {
  id: string;
  title: string;
  status: "pending" | "running" | "done" | "failed";
}

export function stalePending(tasks: Task[], olderThan: Set<string>): Task[] {
  const pending = tasks.filter((t) => t.status == "pending");
  return pending.filter((t) => olderThan.has(t.id));
}
