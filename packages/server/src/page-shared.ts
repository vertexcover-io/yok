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

declare const location: { pathname: string; search: string; assign(url: string): void };

// A gated server answers a signed-out dashboard request with 401; the person signs in and comes
// back to this page.
export const fetchSignedIn = async (input: string, init?: RequestInit): Promise<Response> => {
  const res = await fetch(input, init);
  if (res.status === 401) {
    location.assign(`/login?next=${encodeURIComponent(location.pathname + location.search)}`);
  }
  return res;
};

// An EventSource or a websocket cannot read why it failed, so a failure asks /api/me, which
// fetchSignedIn turns into a trip to /login when the answer is 401.
export const checkSignedIn = (): Promise<unknown> =>
  fetchSignedIn("/api/me").catch(() => undefined);
