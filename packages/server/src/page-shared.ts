import type { AuditMetric, AuditResult, AuditResultEvent, MetricInfo } from "@yok/sdk/internal";
import type { RunStatus } from "./overview.ts";
import type { AuditEventBody } from "./protocol.ts";

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

// A fix's pr is the pull request's URL; a bare number or "#112" also reads as PR #112.
export const prLabel = (pr: string): string => {
  const number = /\/pull\/(\d+)\/?$/.exec(pr)?.[1] ?? /^#?(\d+)$/.exec(pr)?.[1];
  return number === undefined ? pr : `PR #${number}`;
};

// The apply or revert run yok started for a result, as the detail route gives it.
export type AuditApplyRun = Readonly<{ id: string; status: RunStatus }>;

export type ResultPageState =
  | Readonly<{ kind: "auto-fixed" | "needs-work" | "open" }>
  | Readonly<{ kind: "waiting"; action: "apply" | "revert" }>
  | Readonly<{ kind: "applying" | "stopped" | "run-failed"; runId: string }>
  | Readonly<{ kind: "applied"; commit: string; pr: string | null }>
  | Readonly<{ kind: "failed"; reason: string }>
  | Readonly<{ kind: "rejected"; feedback: string | null }>;

const ACTIVE_RUN: ReadonlySet<RunStatus> = new Set<RunStatus>(["starting", "running", "blocked"]);
const FAILED_RUN: ReadonlySet<RunStatus> = new Set<RunStatus>(["failed", "cancelled"]);

// An error written before the person's newest click belongs to an earlier try, not this one.
const freshError = (fix: AuditResult["fix"], decision: AuditResultEvent): string | null => {
  if (fix?.error === undefined) return null;
  return fix.at === undefined || fix.at >= decision.ts ? fix.error : null;
};

export const resultPageState = (
  result: Pick<AuditResult, "state" | "fix">,
  decision: AuditResultEvent | null,
  applyRun: AuditApplyRun | null,
): ResultPageState => {
  if (result.state === "auto_fixed") return { kind: "auto-fixed" };
  if (result.state === "needs_work") return { kind: "needs-work" };
  if (applyRun !== null && ACTIVE_RUN.has(applyRun.status)) {
    return { kind: "applying", runId: applyRun.id };
  }
  // A run whose agent died stays open until someone resumes or cancels it from its run page.
  if (applyRun?.status === "gone") return { kind: "stopped", runId: applyRun.id };
  if (decision === null) return { kind: "open" };
  if (decision.type === "rejected") {
    return {
      kind: "rejected",
      feedback: "feedback" in decision.payload ? decision.payload.feedback : null,
    };
  }
  const fix = result.fix;
  const error = freshError(fix, decision);
  if (error !== null) return { kind: "failed", reason: error };
  if (decision.type === "undone" && fix?.commit === undefined) return { kind: "open" };
  if (decision.type === "accepted" && fix?.commit !== undefined) {
    return { kind: "applied", commit: fix.commit, pr: fix.pr ?? null };
  }
  // A stale error means an earlier run failed and PR 3's tick already reported it; this click waits for a new run.
  if (applyRun !== null && FAILED_RUN.has(applyRun.status) && fix?.error === undefined) {
    return { kind: "run-failed", runId: applyRun.id };
  }
  return { kind: "waiting", action: decision.type === "undone" ? "revert" : "apply" };
};

type PeriodRun = Readonly<{ id: string; periodStart: string; periodEnd: string }>;

// The metrics route keeps only runs wholly inside from..to, so from is the earliest start of any
// run in the range, not the first run's; runIds then drops a run that window pulls in from outside.
export const trendRange = (runs: readonly PeriodRun[], fromId: string, toId: string) => {
  const inRange = runs.slice(
    runs.findIndex((run) => run.id === fromId),
    runs.findIndex((run) => run.id === toId) + 1,
  );
  return {
    from: inRange.map((run) => run.periodStart).reduce((a, b) => (b < a ? b : a)),
    to: inRange.map((run) => run.periodEnd).reduce((a, b) => (b > a ? b : a)),
    runIds: inRange.map((run) => run.id),
  };
};

export type ResultAction = "accept" | "reject" | "undo" | "copy-prompt";

// Undo is offered once the person has decided; nothing while yok's run holds the result.
export const resultActions = (
  state: ResultPageState,
  hasPrompt: boolean,
): readonly ResultAction[] => {
  if (state.kind === "needs-work") return hasPrompt ? ["copy-prompt"] : [];
  if (state.kind === "open") return ["accept", "reject"];
  if (["auto-fixed", "applying", "stopped"].includes(state.kind)) return [];
  return ["undo"];
};

export const rejectBody = (feedback: string): AuditEventBody => {
  const text = feedback.trim();
  return text === "" ? { type: "rejected" } : { type: "rejected", feedback: text };
};

// Publish gives every auto-fixed result of a repo that repo's one PR, and the board shows one
// repo, so the first PR found is the column's; null when the fix stage opened none.
export const autoFixedPr = (
  results: readonly Readonly<{ state: AuditResult["state"]; fix: AuditResult["fix"] }>[],
): string | null =>
  results.find((result) => result.state === "auto_fixed" && result.fix?.pr !== undefined)?.fix
    ?.pr ?? null;

// yok has no cancel: a stopped run is resumed, or removed so the next tick marks its results failed.
export const stoppedRunHelp = (runId: string): string =>
  `resume it with yok resume --run-id ${runId}, or remove it with yok rm ${runId}`;

// Each load works on its own copy of the state, and only the newest load's copy comes back: an
// older, slower one that ends last would otherwise show one run's results under another's name.
export const newestWins = <S extends object>() => {
  let latest = 0;
  return async (state: S, load: (draft: S) => Promise<void>): Promise<S | null> => {
    latest += 1;
    const mine = latest;
    const draft = { ...state };
    await load(draft);
    return mine === latest ? draft : null;
  };
};
