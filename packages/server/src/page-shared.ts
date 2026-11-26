import type { AuditMetric, MetricInfo } from "@yok/sdk/internal";
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

// One audit run in the metrics range route's reply, which lists them oldest first.
export type AuditMetricsPoint = Readonly<{
  auditRunId: string;
  periodEnd: string;
  metrics: readonly AuditMetric[];
}>;

export type MetricChange = Readonly<{ delta: number; verdict: "better" | "worse" | "same" }>;

export const formatMetric = (unit: MetricInfo["unit"], value: number): string => {
  if (unit === "percent") return `${Math.round(value * 10) / 10}%`;
  if (unit === "seconds") return formatDuration(value * 1000);
  return value.toLocaleString("en-US");
};

export const formatChange = (unit: MetricInfo["unit"], delta: number): string => {
  const sign = delta < 0 ? "−" : "+";
  const size = Math.abs(delta);
  if (unit === "percent") return `${sign}${Math.round(size * 10) / 10} pts`;
  return `${sign}${formatMetric(unit, size)}`;
};

// One repo's whole-suite value (scope "") or per-type value of a metric in each run; null where a run has none.
export const metricSeries = (
  points: readonly AuditMetricsPoint[],
  repo: string,
  metric: AuditMetric["metric"],
  scope: string,
): readonly (number | null)[] =>
  points.map(
    (point) =>
      point.metrics.find((m) => m.repo === repo && m.metric === metric && m.scope === scope)
        ?.value ?? null,
  );

// The run at index against the run before it in the series; null when either has no value.
export const metricChange = (
  better: MetricInfo["better"],
  series: readonly (number | null)[],
  index: number,
): MetricChange | null => {
  const value = series[index] ?? null;
  const previous = series[index - 1] ?? null;
  if (value === null || previous === null) return null;
  const delta = value - previous;
  if (delta === 0) return { delta, verdict: "same" };
  return { delta, verdict: delta > 0 === (better === "higher") ? "better" : "worse" };
};

// null when the metric has no limit: it is charted and never flagged.
export const meetsLimit = (info: MetricInfo, value: number): boolean | null => {
  if (info.limit === null) return null;
  if (info.better === "higher") return value >= info.limit;
  return value <= info.limit;
};
