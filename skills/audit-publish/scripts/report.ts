#!/usr/bin/env bun
import { readFileSync } from "node:fs";
import {
  type AuditMetric,
  type AuditReport,
  type AuditResult,
  type JsonValue,
  NonEmptyStringSchema,
  type TestAuditMetric,
} from "@yok/sdk";
import * as z from "zod";
import { AuditSortOutputSchema } from "../../audit-sort/scripts/sort.ts";
import {
  RunTestsOutputSchema,
  type RunTestsRepo,
  TEST_TYPES,
} from "../../run-tests/scripts/coverage.ts";
import {
  type DuplicatesRepo,
  TestDuplicatesOutputSchema,
} from "../../test-duplicates/scripts/duplicates.ts";

export const PublishInputSchema = z.object({
  audit: z.object({
    id: NonEmptyStringSchema,
    commits: z.record(z.string(), NonEmptyStringSchema),
  }),
  tests: RunTestsOutputSchema,
  duplicates: TestDuplicatesOutputSchema,
  sorted: AuditSortOutputSchema,
});
export type PublishInput = z.infer<typeof PublishInputSchema>;

// What `yok orchestrate node show` prints; consumed maps an artifact to its path or url.
const NodeFactsSchema = z.object({
  input: PublishInputSchema,
  consumed: z.record(z.string(), z.string()).default({}),
});

export const AuditPublishOutputSchema = z.strictObject({
  auditRunId: NonEmptyStringSchema,
  status: z.enum(["complete", "partial", "failed"]),
  metrics: z.int().nonnegative(),
  results: z.int().nonnegative(),
});
export const schemas = { "audit-publish.output.v1": AuditPublishOutputSchema };

const MISSING = "the stage reported nothing for this repo";

type Measure = Readonly<{
  value: number | null;
  reason: string | undefined;
  how: Record<string, JsonValue>;
}>;

const toMetric = (
  repo: string,
  metric: TestAuditMetric,
  scope: string,
  { value, reason, how }: Measure,
): AuditMetric => ({
  repo,
  metric,
  scope,
  status: value === null ? "not_measured" : "measured",
  reason: value === null ? (reason ?? "not measured") : null,
  value,
  how,
});

// A repo a stage left out is measured as nothing, with the reason, and counts as a broken step.
const missingTests = (repo: string): RunTestsRepo => ({
  repo,
  commands: {},
  tests: { all: null, unit: null, integration: null, e2e: null },
  seconds: null,
  coverage: null,
  coverageChanged: null,
  flaky: [],
  failing: [],
  slow: [],
  notMeasured: {
    all: MISSING,
    unit: MISSING,
    integration: MISSING,
    e2e: MISSING,
    seconds: MISSING,
    coverage: MISSING,
    coverageChanged: MISSING,
  },
  errors: [MISSING],
});

const missingDuplicates = (repo: string): DuplicatesRepo => ({
  repo,
  testsAdded: null,
  duplicates: [],
  notMeasured: MISSING,
  errors: [MISSING],
});

const buildTestMetrics = (tests: RunTestsRepo): readonly AuditMetric[] => {
  const how = { commands: { ...tests.commands } };
  const { repo, notMeasured } = tests;
  return [
    toMetric(repo, "coverage", "", { value: tests.coverage, reason: notMeasured.coverage, how }),
    toMetric(repo, "coverageChanged", "", {
      value: tests.coverageChanged,
      reason: notMeasured.coverageChanged,
      how,
    }),
    toMetric(repo, "testCount", "", { value: tests.tests.all, reason: notMeasured.all, how }),
    ...TEST_TYPES.map((type) =>
      toMetric(repo, "testCount", type, {
        value: tests.tests[type],
        reason: notMeasured[type],
        how: { command: tests.commands[type] ?? null },
      }),
    ),
    toMetric(repo, "testTime", "", { value: tests.seconds, reason: notMeasured.seconds, how }),
    toMetric(repo, "flakyTests", "", {
      value: tests.tests.all === null ? null : tests.flaky.length,
      reason: notMeasured.all,
      how: { ...how, runs: 3 },
    }),
  ];
};

// No test added means nothing could duplicate: 0%, and the metric's how says why.
const toDuplicatesPct = (duplicates: number, testsAdded: number | null): number | null => {
  if (testsAdded === null) return null;
  if (testsAdded === 0) return 0;
  return Math.round((duplicates / testsAdded) * 1000) / 10;
};

const buildDuplicateMetrics = (found: DuplicatesRepo): readonly AuditMetric[] => {
  const { repo, testsAdded, duplicates } = found;
  const reason = found.notMeasured ?? undefined;
  const how = { testsAdded };
  return [
    toMetric(repo, "duplicates", "", {
      value: testsAdded === null ? null : duplicates.length,
      reason,
      how,
    }),
    toMetric(repo, "duplicatesPct", "", {
      value: toDuplicatesPct(duplicates.length, testsAdded),
      reason,
      how: testsAdded === 0 ? { ...how, note: "no test was added in the period" } : how,
    }),
  ];
};

const decideStatus = (metrics: readonly AuditMetric[], errors: number): AuditReport["status"] => {
  if (metrics.every((metric) => metric.status === "not_measured")) return "failed";
  return errors > 0 ? "partial" : "complete";
};

// What the fix stage did with each item, from its fix-result artifact.
const FixResultsSchema = z.array(
  z.object({
    id: NonEmptyStringSchema,
    status: z.enum(["closed", "left"]),
    commit: NonEmptyStringSchema.optional(),
  }),
);
type FixResults = z.infer<typeof FixResultsSchema>;

// An auto-fix the fix stage closed carries its commit and PR; any other goes to a person.
export const settleAutoFix = (
  result: AuditResult,
  fixResults: FixResults,
  prs: ReadonlyMap<string, string>,
): AuditResult => {
  if (result.state !== "auto_fixed" || result.fix === null) return result;
  const done = fixResults.find((item) => item.id === result.id);
  if (done?.status !== "closed" || done.commit === undefined) {
    return { ...result, state: "needs_approval" };
  }
  const pr = prs.get(result.repo);
  return {
    ...result,
    fix: { ...result.fix, commit: done.commit, ...(pr === undefined ? {} : { pr }) },
  };
};

export const buildReport = (
  input: PublishInput,
  fixResults: FixResults = [],
  prs: ReadonlyMap<string, string> = new Map(),
): AuditReport => {
  const repos = Object.keys(input.audit.commits).sort();
  const tests = repos.map(
    (repo) => input.tests.repos.find((found) => found.repo === repo) ?? missingTests(repo),
  );
  const duplicates = repos.map(
    (repo) =>
      input.duplicates.repos.find((found) => found.repo === repo) ?? missingDuplicates(repo),
  );
  const metrics = [
    ...tests.flatMap(buildTestMetrics),
    ...duplicates.flatMap(buildDuplicateMetrics),
  ];
  const errors = [...tests, ...duplicates].reduce((sum, repo) => sum + repo.errors.length, 0);
  return {
    status: decideStatus(metrics, errors),
    metrics,
    results: input.sorted.results.map((result) => settleAutoFix(result, fixResults, prs)),
  };
};

// node show keys a consumed artifact TYPE, or TYPE:NAME when its name differs; visual-pr names
// each pull-request after its repo.
const readFixResults = (consumed: Readonly<Record<string, string>>): FixResults => {
  const path = Object.entries(consumed).find(([key]) => key.startsWith("fix-result"))?.[1];
  return path === undefined ? [] : FixResultsSchema.parse(JSON.parse(readFileSync(path, "utf8")));
};

const readPullRequests = (
  consumed: Readonly<Record<string, string>>,
): ReadonlyMap<string, string> =>
  new Map(
    Object.entries(consumed).flatMap(([key, url]) =>
      key.startsWith("pull-request:") ? [[key.slice("pull-request:".length), url] as const] : [],
    ),
  );

export const main = async (_argv: readonly string[]): Promise<void> => {
  const facts = NodeFactsSchema.safeParse(JSON.parse(await Bun.stdin.text()));
  if (!facts.success) {
    process.stderr.write(`report: ${z.prettifyError(facts.error)}\n`);
    process.exitCode = 1;
    return;
  }
  const { input, consumed } = facts.data;
  const report = buildReport(input, readFixResults(consumed), readPullRequests(consumed));
  process.stdout.write(`${JSON.stringify(report)}\n`);
};

if (import.meta.main) {
  await main(process.argv.slice(2)).catch((error: unknown) => {
    console.error(error);
    process.exitCode = 1;
  });
}
