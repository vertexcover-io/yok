import * as z from "zod";
import { NonEmptyStringSchema } from "./contracts.ts";

export type MetricInfo = Readonly<{
  unit: "percent" | "count" | "seconds";
  better: "higher" | "lower";
  // a project's own limit replaces it; null is charted and never flagged
  limit: number | null;
}>;

export const TEST_AUDIT_METRIC_NAMES = [
  "coverage",
  "coverageChanged",
  "testCount",
  "testTime",
  "flakyTests",
  "duplicates",
  "duplicatesPct",
] as const;
export type TestAuditMetric = (typeof TEST_AUDIT_METRIC_NAMES)[number];

// Percent is stored 0-100 and time in seconds.
export const TEST_AUDIT_METRICS = {
  coverage: { unit: "percent", better: "higher", limit: 80 },
  coverageChanged: { unit: "percent", better: "higher", limit: 80 },
  testCount: { unit: "count", better: "higher", limit: null },
  testTime: { unit: "seconds", better: "lower", limit: 240 },
  flakyTests: { unit: "count", better: "lower", limit: 0 },
  duplicates: { unit: "count", better: "lower", limit: 0 },
  duplicatesPct: { unit: "percent", better: "lower", limit: 2 },
} as const satisfies Readonly<Record<TestAuditMetric, MetricInfo>>;

// failing: a test that fails on every run, unlike flaky
export const TEST_AUDIT_PROBLEM_TYPES = ["duplicates", "flaky", "slow", "failing"] as const;
export type TestAuditProblemType = (typeof TEST_AUDIT_PROBLEM_TYPES)[number];

// A periodic audit of one project. The period is the window it looks at, of any length.
export const AuditRunSchema = z.strictObject({
  id: NonEmptyStringSchema,
  runId: NonEmptyStringSchema,
  project: NonEmptyStringSchema,
  audit: z.enum(["test", "qa", "review"]),
  periodStart: z.iso.datetime(),
  periodEnd: z.iso.datetime(),
  // repo name to the commit audited, such as { web: "8c38b2c" }
  commits: z.record(z.string(), NonEmptyStringSchema),
  status: z.enum(["running", "complete", "partial", "failed"]),
  createdAt: z.iso.datetime(),
});
export type AuditRun = z.infer<typeof AuditRunSchema>;
export type AuditName = AuditRun["audit"];

export const AuditStartSchema = AuditRunSchema.omit({ id: true, status: true, createdAt: true });
export type AuditStart = z.infer<typeof AuditStartSchema>;

export const AuditMetricSchema = z.strictObject({
  repo: NonEmptyStringSchema,
  // a new audit adds its own names beside the test audit's
  metric: z.enum(TEST_AUDIT_METRIC_NAMES),
  // '' for the whole suite, else a layer such as unit or e2e, or a code area such as packages/sdk
  scope: z.string(),
  status: z.enum(["measured", "not_measured"]),
  reason: z.string().nullable(),
  value: z.number().nullable(),
  // how the value was measured
  how: z.record(z.string(), z.json()),
});
export type AuditMetric = z.infer<typeof AuditMetricSchema>;

export const AuditResultSchema = z.strictObject({
  // AUDIT_RUN_ID:repo:problemType:slug, chosen by the caller so a retried publish names the
  // same finding again
  id: NonEmptyStringSchema,
  repo: NonEmptyStringSchema,
  problemType: z.enum(TEST_AUDIT_PROBLEM_TYPES),
  state: z.enum(["auto_fixed", "needs_approval", "needs_work"]),
  title: NonEmptyStringSchema,
  proof: z.record(z.string(), z.json()),
  fix: z
    .strictObject({
      summary: NonEmptyStringSchema,
      diff: z.string().optional(),
      prompt: z.string().optional(),
      commit: z.string().optional(),
      pr: z.string().optional(),
      // why the apply run could not apply or revert it
      error: z.string().optional(),
      // when setFix last wrote commit, pr or error
      at: z.iso.datetime().optional(),
    })
    .nullable(),
});
export type AuditResult = z.infer<typeof AuditResultSchema>;
export type AuditFix = NonNullable<AuditResult["fix"]>;

// What the apply run writes onto a result's fix: what it applied, or why it could not. clear
// removes all of it after a revert.
export const AuditFixPatchSchema = z.union([
  z.strictObject({ clear: z.literal(true) }),
  z
    .strictObject({
      commit: NonEmptyStringSchema.optional(),
      pr: NonEmptyStringSchema.optional(),
      error: NonEmptyStringSchema.optional(),
    })
    .refine((patch) => Object.keys(patch).length > 0, "a fix patch sets commit, pr or error"),
]);
export type AuditFixPatch = z.infer<typeof AuditFixPatchSchema>;

// What a finished audit publishes; a retried publish sends the whole report again.
export const AuditReportSchema = z.strictObject({
  status: z.enum(["complete", "partial", "failed"]),
  metrics: z.array(AuditMetricSchema),
  results: z.array(AuditResultSchema),
});
export type AuditReport = z.infer<typeof AuditReportSchema>;

export type AuditRecord = Readonly<{
  run: AuditRun;
  metrics: readonly AuditMetric[];
  results: readonly AuditResult[];
}>;

// from and to keep the audit runs whose period lies inside them; limit keeps the newest
export type AuditRunFilter = Readonly<{ from?: string; to?: string; limit?: number }>;

// A person's choice on a result; the newest is the result's decision.
export const AUDIT_CLICK_TYPES = ["accepted", "rejected", "undone"] as const;
// Written by yok, who "yok", when it starts the apply run that acts on the newest click.
export const AUDIT_RUN_START_TYPES = ["apply_started", "revert_started"] as const;

const eventFields = {
  resultId: NonEmptyStringSchema,
  who: NonEmptyStringSchema,
  payload: z.union([z.strictObject({ feedback: NonEmptyStringSchema }), z.strictObject({})]),
};
const clickFields = { ...eventFields, type: z.enum(AUDIT_CLICK_TYPES), startedRunId: z.null() };
const runStartFields = { ...eventFields, type: z.enum(AUDIT_RUN_START_TYPES) };
const stamp = { id: z.uuid(), ts: z.iso.datetime() };

// Append-only: a later click or run start is a new event.
export const AuditResultEventSchema = z.union([
  z.strictObject({ ...stamp, ...clickFields }),
  // startedRunId turns null when that run is removed
  z.strictObject({ ...stamp, ...runStartFields, startedRunId: NonEmptyStringSchema.nullable() }),
]);
export type AuditResultEvent = z.infer<typeof AuditResultEventSchema>;

export const AuditResultEventDraftSchema = z.union([
  z.strictObject(clickFields),
  z.strictObject({ ...runStartFields, startedRunId: NonEmptyStringSchema }),
]);
export type AuditResultEventDraft = z.infer<typeof AuditResultEventDraftSchema>;

// A result an apply run owes work: apply its fix, or revert the commit it applied.
export type AuditPendingWork = Readonly<{
  auditRunId: string;
  result: AuditResult;
  event: AuditResultEvent;
  action: "apply" | "revert";
}>;
