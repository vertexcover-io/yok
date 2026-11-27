import { describe, expect, spyOn, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import * as z from "zod";
import {
  main,
  measureCoverage,
  parseChangedLines,
  parseLcov,
  RunTestsRepoSchema,
} from "./coverage.ts";

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

  test("SC16: a file in two lcov records keeps every line, and a line either record hit counts as hit", () => {
    const merged = [
      "SF:a.ts\nDA:1,1\nDA:2,0\nend_of_record",
      "SF:b.ts\nDA:1,0\nend_of_record",
      "SF:a.ts\nDA:2,3\nDA:3,0\nend_of_record",
    ].join("\n");

    const lines = parseLcov(merged, "/repo");
    const measured = measureCoverage(lines, new Map());

    expect(lines.get("a.ts")).toEqual(
      new Map([
        [1, 1],
        [2, 3],
        [3, 0],
      ]),
    );
    expect(measured.coverage).toBe(50);
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

// Runs git in REPO with both commit dates set to AT, and returns its trimmed stdout.
const gitAt = (repo: string, at: string, args: readonly string[]): string => {
  const ran = spawnSync("git", ["-c", "user.name=t", "-c", "user.email=t@t", ...args], {
    cwd: repo,
    encoding: "utf8",
    env: { ...process.env, GIT_AUTHOR_DATE: at, GIT_COMMITTER_DATE: at },
  });
  if (ran.status !== 0) throw new Error(ran.stderr);
  return ran.stdout.trim();
};

const commitFile = (repo: string, at: string, file: string): string => {
  writeFileSync(join(repo, file), "x\n");
  gitAt(repo, at, ["add", file]);
  gitAt(repo, at, ["commit", "-m", file]);
  return gitAt(repo, at, ["rev-parse", "HEAD"]);
};

// What main prints to stdout for ARGV, parsed.
const printedBy = async (argv: readonly string[]): Promise<unknown> => {
  const written: string[] = [];
  const write = spyOn(process.stdout, "write").mockImplementation((chunk) => {
    written.push(String(chunk));
    return true;
  });
  try {
    await main(argv);
  } finally {
    write.mockRestore();
  }
  return JSON.parse(written.join(""));
};

describe("main", () => {
  test("a side-branch commit dated just before the period but merged in it is not the base: the base is main's last commit before the period", async () => {
    const repo = mkdtempSync(join(tmpdir(), "coverage-"));
    gitAt(repo, "2026-11-01T00:00:00Z", ["init", "-q", "-b", "main"]);
    commitFile(repo, "2026-11-01T00:00:00Z", "start.ts");
    gitAt(repo, "2026-11-01T00:00:00Z", ["branch", "side"]);
    const mainBefore = commitFile(repo, "2026-11-02T00:00:00Z", "m.ts");
    gitAt(repo, "2026-11-02T00:00:00Z", ["checkout", "-q", "side"]);
    commitFile(repo, "2026-11-02T23:00:00Z", "s.ts");
    gitAt(repo, "2026-11-04T00:00:00Z", ["checkout", "-q", "main"]);
    gitAt(repo, "2026-11-04T00:00:00Z", ["merge", "-q", "--no-ff", "-m", "merge side", "side"]);
    const lcovPath = join(repo, "lcov.info");
    writeFileSync(lcovPath, lcov({ "m.ts": [1], "s.ts": [0] }));

    expect(await printedBy([lcovPath, "--repo", repo, "--since", "2026-11-03T00:00:00Z"])).toEqual({
      base: mainBefore,
      coverage: 50,
      coverageChanged: 0,
      changedLines: 1,
    });
  });

  test("with color.ui=always, a changed file named é.ts still counts its changed line", async () => {
    const repo = mkdtempSync(join(tmpdir(), "coverage-"));
    gitAt(repo, "2026-11-01T00:00:00Z", ["init", "-q", "-b", "main"]);
    gitAt(repo, "2026-11-01T00:00:00Z", ["config", "color.ui", "always"]);
    commitFile(repo, "2026-11-01T00:00:00Z", "start.ts");
    commitFile(repo, "2026-11-04T00:00:00Z", "é.ts");
    const lcovPath = join(repo, "lcov.info");
    writeFileSync(lcovPath, lcov({ "é.ts": [1] }));

    expect(
      await printedBy([lcovPath, "--repo", repo, "--since", "2026-11-03T00:00:00Z"]),
    ).toMatchObject({ coverageChanged: 100, changedLines: 1 });
  });
});
