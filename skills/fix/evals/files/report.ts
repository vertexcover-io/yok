interface Task {
  id: string;
  title: string;
  status: "pending" | "running" | "done" | "failed";
}

export function pendingSummary(tasks: Task[]): string {
  const pending = tasks.filter((t) => t.status == "pending");
  return `${pending.length} pending: ${pending.map((t) => t.title).join(", ")}`;
}
