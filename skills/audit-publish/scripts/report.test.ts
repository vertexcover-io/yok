import { describe, expect, test } from "bun:test";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { AuditMetric } from "@yok/sdk";
import type { RunTestsRepo } from "../../run-tests/scripts/coverage.ts";
import type { DuplicatesRepo } from "../../test-duplicates/scripts/duplicates.ts";
import { buildReport, type PublishInput, settleAutoFix } from "./report.ts";

const testsOf = (repo: string, overrides: Partial<RunTestsRepo> = {}): RunTestsRepo => ({
  repo,
  commands: { unit: "bun test", integration: "bun test it", e2e: "playwright test" },
  tests: { all: 12, unit: 8, integration: 3, e2e: 1 },
  seconds: 42,
  coverage: 81.5,
  coverageChanged: 70,
  flaky: [
    { file: "a.test.ts", name: "one", runs: ["pass", "fail", "pass"] },
    { file: "a.test.ts", name: "two", runs: ["fail", "pass", "pass"] },
  ],
  failing: [],
  slow: [],
  notMeasured: {},
  errors: [],
  ...overrides,
});

const duplicatesOf = (repo: string, overrides: Partial<DuplicatesRepo> = {}): DuplicatesRepo => ({
  repo,
  testsAdded: 10,
  duplicates: [
    {
      test: { file: "a.test.ts", line: 9, name: "copy" },
      keeper: { file: "a.test.ts", line: 3, name: "one" },
      reason: "proves the same rule",
    },
  ],
  notMeasured: null,
  errors: [],
  ...overrides,
});

const sortedResult = (slug: string) => ({
  id: `a-1:yok:slow:${slug}`,
  repo: "yok",
  problemType: "slow" as const,
  state: "needs_work" as const,
  title: `${slug} is slow`,
  proof: { where: `${slug}.test.ts`, summary: "It takes long.", blocks: [] },
  fix: { summary: "split it", prompt: "split the file" },
});

const inputOf = (overrides: Partial<PublishInput> = {}): PublishInput => ({
  audit: { id: "a-1", commits: { yok: "abc" } },
  tests: { repos: [testsOf("yok")] },
  duplicates: { repos: [duplicatesOf("yok")] },
  sorted: { results: ["a", "b", "c"].map(sortedResult), autoFix: false, fixes: [] },
  ...overrides,
});

const metricOf = (
  metrics: readonly AuditMetric[],
  metric: AuditMetric["metric"],
  scope = "",
  repo = "yok",
) => metrics.find((row) => row.metric === metric && row.scope === scope && row.repo === repo);

describe("buildReport", () => {
  test("SC17: a fully measured repo publishes every metric at scope '', testCount per type, its 3 results, and is complete", () => {
    const report = buildReport(inputOf());
    const values = Object.fromEntries(
      report.metrics.filter((row) => row.scope === "").map((row) => [row.metric, row.value]),
    );
    expect(values).toEqual({
      coverage: 81.5,
      coverageChanged: 70,
      testCount: 12,
      testTime: 42,
      flakyTests: 2,
      duplicates: 1,
      duplicatesPct: 10,
    });
    expect(
      ["unit", "integration", "e2e"].map(
        (scope) => metricOf(report.metrics, "testCount", scope)?.value,
      ),
    ).toEqual([8, 3, 1]);
    expect(report.results).toHaveLength(3);
    expect(report.status).toBe("complete");
  });

  test("SC18: a test type nothing marks is not_measured with its reason and the audit stays complete", () => {
    const tests = testsOf("yok", {
      tests: { all: 9, unit: 8, integration: null, e2e: 1 },
      notMeasured: { integration: "no test is marked integration" },
    });
    const report = buildReport(inputOf({ tests: { repos: [tests] } }));
    expect(metricOf(report.metrics, "testCount", "integration")).toMatchObject({
      status: "not_measured",
      reason: "no test is marked integration",
      value: null,
    });
    expect(report.status).toBe("complete");
  });

  test("SC19: a coverage run that crashed is saved as not_measured and makes the audit partial", () => {
    const tests = testsOf("yok", {
      coverage: null,
      notMeasured: { coverage: "coverage run crashed" },
      errors: ["coverage run crashed"],
    });
    const report = buildReport(inputOf({ tests: { repos: [tests] } }));
    expect(metricOf(report.metrics, "coverage")).toMatchObject({
      status: "not_measured",
      reason: "coverage run crashed",
    });
    expect(
      report.metrics.filter((row) => row.metric !== "coverage").every((row) => row.value !== null),
    ).toBe(true);
    expect(report.status).toBe("partial");
  });

  test("SC20: no test added in the period makes duplicatesPct a measured 0 with the reason in how", () => {
    const duplicates = duplicatesOf("yok", { testsAdded: 0, duplicates: [] });
    const report = buildReport(inputOf({ duplicates: { repos: [duplicates] } }));
    expect(metricOf(report.metrics, "duplicatesPct")).toMatchObject({
      status: "measured",
      value: 0,
      how: { note: "no test was added in the period" },
    });
  });

  test("SC21: a repo a stage left out is not_measured and partial; a run that measured no repo fails", () => {
    const audit = { id: "a-1", commits: { api: "abc", web: "def" } };
    const partial = buildReport(
      inputOf({
        audit,
        tests: { repos: [testsOf("api")] },
        duplicates: { repos: [duplicatesOf("api"), duplicatesOf("web")] },
      }),
    );
    const web = partial.metrics.filter(
      (row) => row.repo === "web" && !row.metric.startsWith("duplicates"),
    );
    expect(web.length).toBeGreaterThan(0);
    expect(
      web.every(
        (row) =>
          row.status === "not_measured" &&
          row.reason === "the stage reported nothing for this repo",
      ),
    ).toBe(true);
    expect(partial.status).toBe("partial");

    const failed = buildReport(
      inputOf({
        audit,
        tests: { repos: [testsOf("other")] },
        duplicates: { repos: [duplicatesOf("other")] },
      }),
    );
    expect(failed.status).toBe("failed");
  });
});

describe("settleAutoFix", () => {
  const autoFixed = {
    id: "a-1:web:duplicates:copy",
    repo: "web",
    problemType: "duplicates" as const,
    state: "auto_fixed" as const,
    title: "copy duplicates one",
    proof: {},
    fix: { summary: "delete copy", diff: "-copy" },
  };
  const prs = new Map([["web", "https://github.com/o/web/pull/7"]]);

  test("SC29: an auto-fix the fix stage closed stays auto_fixed with its commit c1 and its repo's PR", () => {
    const settled = settleAutoFix(
      autoFixed,
      [{ id: autoFixed.id, status: "closed", commit: "c1" }],
      prs,
    );
    expect(settled).toEqual({
      ...autoFixed,
      fix: { ...autoFixed.fix, commit: "c1", pr: "https://github.com/o/web/pull/7" },
    });
  });

  test.each([
    [
      "left by the fix stage",
      [{ id: autoFixed.id, status: "left" as const, reason: "keeper fails" }],
    ],
    ["never reported", []],
  ])(
    "SC30: an auto-fix %s goes to needs_approval with its diff, no commit and no pr",
    (_label, fixResults) => {
      expect(settleAutoFix(autoFixed, fixResults, prs)).toEqual({
        ...autoFixed,
        state: "needs_approval",
      });
    },
  );
});

describe("main", () => {
  test("node show's fix-result:audit-1 and pull-request:yok give the printed auto-fix its commit and PR", () => {
    const dir = mkdtempSync(join(tmpdir(), "report-"));
    const autoFixed = {
      ...sortedResult("copy"),
      id: "a-1:yok:duplicates:copy",
      problemType: "duplicates" as const,
      state: "auto_fixed" as const,
      fix: { summary: "delete copy", diff: "-copy" },
    };
    const fixResult = join(dir, "audit-1.json");
    writeFileSync(
      fixResult,
      JSON.stringify([{ id: autoFixed.id, status: "closed", commit: "c1" }]),
    );
    // the shape `yok orchestrate node show` prints, keys as artifactPaths writes them
    const facts = {
      nodeRunId: "nr-publish",
      stage: "audit-publish",
      attempt: 1,
      input: inputOf({
        sorted: {
          results: [autoFixed],
          autoFix: true,
          fixes: [
            {
              id: autoFixed.id,
              repo: "yok",
              file: "a.test.ts",
              summary: "copy duplicates one",
              trigger: "copy checks what one checks",
              hint: "delete copy; keep one",
            },
          ],
        },
      }),
      consumed: {
        "fix-result:audit-1": fixResult,
        "pull-request:yok": "https://github.com/o/yok/pull/7",
      },
      runDir: dir,
    };
    const ran = Bun.spawnSync({
      cmd: [process.execPath, join(import.meta.dir, "report.ts")],
      stdin: Buffer.from(JSON.stringify(facts)),
    });
    expect(ran.stderr.toString()).toBe("");
    expect(JSON.parse(ran.stdout.toString()).results).toEqual([
      {
        ...autoFixed,
        fix: { ...autoFixed.fix, commit: "c1", pr: "https://github.com/o/yok/pull/7" },
      },
    ]);
  });
});
