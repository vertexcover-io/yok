import * as z from "zod";
import { NonEmptyStringSchema } from "./contracts.ts";

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
  // any name: TEST_AUDIT_METRICS lists the test audit's, and a new audit adds its own
  metric: NonEmptyStringSchema,
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
  problemType: NonEmptyStringSchema,
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
    })
    .nullable(),
});
export type AuditResult = z.infer<typeof AuditResultSchema>;

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

export type MetricInfo = Readonly<{
  unit: "percent" | "count" | "seconds";
  better: "higher" | "lower";
  // a project's own limit replaces it; null is charted and never flagged
  limit: number | null;
}>;

// Percent is stored 0-100 and time in seconds.
export const TEST_AUDIT_METRICS = {
  coverage: { unit: "percent", better: "higher", limit: 80 },
  coverageChanged: { unit: "percent", better: "higher", limit: 80 },
  testCount: { unit: "count", better: "higher", limit: null },
  testTime: { unit: "seconds", better: "lower", limit: 240 },
  flakyTests: { unit: "count", better: "lower", limit: 0 },
  duplicates: { unit: "count", better: "lower", limit: 0 },
  duplicatesPct: { unit: "percent", better: "lower", limit: 2 },
} as const satisfies Readonly<Record<string, MetricInfo>>;
export type TestAuditMetric = keyof typeof TEST_AUDIT_METRICS;

export const TEST_AUDIT_PROBLEM_TYPES = ["duplicates", "flaky", "slow"] as const;
export type TestAuditProblemType = (typeof TEST_AUDIT_PROBLEM_TYPES)[number];
