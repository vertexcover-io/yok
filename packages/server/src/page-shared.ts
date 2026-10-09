import type { RunStatus } from "./overview.ts";

export const RUN_STATUS_WORDS: Readonly<Record<RunStatus, string>> = {
  starting: "starting",
  running: "running",
  blocked: "needs you",
  completed: "done",
  failed: "failed",
  cancelled: "cancelled",
  missing: "no run folder",
  unreadable: "state unreadable",
  gone: "agent gone",
};

export const formatDuration = (ms: number): string => {
  const s = Math.max(0, Math.floor(ms / 1000));
  if (s < 60) return `${s}s`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}m ${String(s % 60).padStart(2, "0")}s`;
  return `${Math.floor(m / 60)}h ${m % 60}m`;
};
