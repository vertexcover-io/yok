import { describe, expect, test } from "bun:test";
import * as z from "zod";
import { measureCoverage, parseChangedLines, parseLcov, RunTestsRepoSchema } from "./coverage.ts";

const lcov = (files: Readonly<Record<string, readonly number[]>>): string =>
  Object.entries(files)
    .map(([file, hits]) =>
      [
        `SF:${file}`,
        ...hits.map((count, index) => `DA:${index + 1},${count}`),
        "end_of_record",
      ].join("\n"),
    )
    .join("\n");

const diffOf = (files: Readonly<Record<string, string>>): string =>
  Object.entries(files)
    .map(([file, hunk]) => `diff --git a/${file} b/${file}\n--- a/${file}\n+++ b/${file}\n${hunk}`)
    .join("\n");

describe("measureCoverage", () => {
  test("SC10: a.ts hits 1,1,0,0 and b.ts hit 1 is 60% overall; changed a.ts 3-4 and b.ts 1 is 33.3% over 3 lines", () => {
    const measured = measureCoverage(
      parseLcov(lcov({ "a.ts": [1, 1, 0, 0], "b.ts": [1] }), "/repo"),
      parseChangedLines(
        diffOf({ "a.ts": "@@ -3,0 +3,2 @@\n+x\n+y", "b.ts": "@@ -1 +1 @@\n-a\n+b" }),
      ),
    );
    expect(measured).toEqual({ coverage: 60, coverageChanged: 33.3, changedLines: 3 });
  });

  test("SC11: a diff touching only README.md leaves coverageChanged null over 0 changed lines", () => {
    const measured = measureCoverage(
      parseLcov(lcov({ "a.ts": [1] }), "/repo"),
      parseChangedLines(diffOf({ "README.md": "@@ -1 +1 @@\n-a\n+b" })),
    );
    expect(measured).toMatchObject({ coverageChanged: null, changedLines: 0 });
  });

  test("SC12: an absolute SF path under the root matches the diff's repo-relative path", () => {
    const measured = measureCoverage(
      parseLcov(lcov({ "/work/repo/src/a.ts": [0] }), "/work/repo"),
      parseChangedLines(diffOf({ "src/a.ts": "@@ -0,0 +1 @@\n+x" })),
    );
    expect(measured).toEqual({ coverage: 0, coverageChanged: 0, changedLines: 1 });
  });
});

describe("RunTestsRepoSchema", () => {
  test("SC15: a null coverage with no reason in notMeasured is refused", () => {
    const parsed = RunTestsRepoSchema.safeParse({
      repo: "yok",
      commands: { unit: "bun test" },
      tests: { all: 3, unit: 3, integration: 0, e2e: 0 },
      seconds: 1,
      coverage: null,
      coverageChanged: 50,
      flaky: [],
      failing: [],
      slow: [],
      notMeasured: {},
      errors: [],
    });
    expect(parsed.success ? "" : z.prettifyError(parsed.error)).toContain(
      "every null value has its reason in notMeasured",
    );
  });
});
