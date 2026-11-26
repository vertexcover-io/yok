#!/usr/bin/env bun
import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { relative, resolve } from "node:path";
import { parseArgs } from "node:util";
import { NonEmptyStringSchema } from "@yok/sdk";
import * as z from "zod";

export const TEST_TYPES = ["unit", "integration", "e2e"] as const;

const CountSchema = z.int().nonnegative().nullable();
const PercentSchema = z.number().min(0).max(100).nullable();
const TestSchema = z.strictObject({ file: NonEmptyStringSchema, name: NonEmptyStringSchema });
const MEASURED_FIELDS = ["all", ...TEST_TYPES, "seconds", "coverage", "coverageChanged"] as const;
type MeasuredField = (typeof MEASURED_FIELDS)[number];

const RunTestsRepoShape = z.strictObject({
  repo: NonEmptyStringSchema,
  // the command that ran each type, saved as how its metrics were measured
  commands: z.partialRecord(z.enum(TEST_TYPES), NonEmptyStringSchema),
  tests: z.strictObject({
    all: CountSchema,
    unit: CountSchema,
    integration: CountSchema,
    e2e: CountSchema,
  }),
  seconds: z.number().nonnegative().nullable(),
  coverage: PercentSchema,
  coverageChanged: PercentSchema,
  // what the test did in each run, in run order
  flaky: z.array(
    TestSchema.extend({ runs: z.array(z.enum(["pass", "fail", "skip", "missing"])).min(2) }),
  ),
  failing: z.array(TestSchema.extend({ message: z.string() })),
  slow: z.array(
    z.strictObject({
      file: NonEmptyStringSchema,
      seconds: z.number().nonnegative(),
      share: z.number().min(0).max(1),
    }),
  ),
  // why each null above was not measured
  notMeasured: z.partialRecord(z.enum(MEASURED_FIELDS), NonEmptyStringSchema),
  // the steps that broke; any one makes the audit partial
  errors: z.array(NonEmptyStringSchema),
});

const readField = (repo: z.infer<typeof RunTestsRepoShape>, field: MeasuredField): number | null =>
  field === "seconds" || field === "coverage" || field === "coverageChanged"
    ? repo[field]
    : repo.tests[field];

export const RunTestsRepoSchema = RunTestsRepoShape.refine(
  (repo) =>
    MEASURED_FIELDS.every(
      (field) => readField(repo, field) !== null || repo.notMeasured[field] !== undefined,
    ),
  "every null value has its reason in notMeasured",
);
export type RunTestsRepo = z.infer<typeof RunTestsRepoSchema>;

export const RunTestsOutputSchema = z.strictObject({ repos: z.array(RunTestsRepoSchema).min(1) });
export type RunTestsOutput = z.infer<typeof RunTestsOutputSchema>;
export const schemas = { "run-tests.output.v1": RunTestsOutputSchema };

// lcov: SF:FILE opens a file's record and DA:LINE,HITS is one measured line.
export const parseLcov = (
  text: string,
  root: string,
): ReadonlyMap<string, ReadonlyMap<number, number>> => {
  const files = new Map<string, Map<number, number>>();
  let current: Map<number, number> | undefined;
  for (const line of text.split("\n")) {
    if (line.startsWith("SF:")) {
      current = new Map();
      files.set(relative(root, resolve(root, line.slice(3).trim())), current);
      continue;
    }
    const hit = /^DA:(\d+),(\d+)/.exec(line);
    if (hit !== null && current !== undefined) current.set(Number(hit[1]), Number(hit[2]));
  }
  return files;
};

// git diff -U0: "+++ b/FILE" names a file and "@@ -A +START,COUNT @@" the lines it added or changed.
export const parseChangedLines = (diff: string): ReadonlyMap<string, ReadonlySet<number>> => {
  const changed = new Map<string, Set<number>>();
  let current: Set<number> | undefined;
  for (const line of diff.split("\n")) {
    if (line.startsWith("+++ ")) {
      const path = line.slice(4);
      current = path === "/dev/null" ? undefined : new Set();
      if (current !== undefined) changed.set(path.replace(/^b\//, ""), current);
      continue;
    }
    const hunk = /^@@ -\S+ \+(\d+)(?:,(\d+))? @@/.exec(line);
    if (hunk === null || current === undefined) continue;
    const start = Number(hunk[1]);
    const count = hunk[2] === undefined ? 1 : Number(hunk[2]);
    for (let at = start; at < start + count; at++) current.add(at);
  }
  return changed;
};

const toPercent = (covered: number, total: number): number | null =>
  total === 0 ? null : Math.round((covered / total) * 1000) / 10;

export const measureCoverage = (
  lcov: ReadonlyMap<string, ReadonlyMap<number, number>>,
  changed: ReadonlyMap<string, ReadonlySet<number>>,
): Readonly<{ coverage: number | null; coverageChanged: number | null; changedLines: number }> => {
  const lines = [...lcov].flatMap(([file, hits]) =>
    [...hits].map(([line, count]) => ({ file, line, count })),
  );
  const touched = lines.filter(({ file, line }) => changed.get(file)?.has(line) === true);
  return {
    coverage: toPercent(lines.filter(({ count }) => count > 0).length, lines.length),
    coverageChanged: toPercent(touched.filter(({ count }) => count > 0).length, touched.length),
    changedLines: touched.length,
  };
};

// git's empty tree: a repo with no commit before the period counts every line as changed.
const EMPTY_TREE = "4b825dc642cb6eb9a060e54bf8d69288fbee4904";

const git = (cwd: string, args: readonly string[]) =>
  spawnSync("git", [...args], { cwd, encoding: "utf8" });

const USAGE = "usage: coverage LCOV --repo WORKTREE --since ISO_TIME\n";

export const main = async (argv: readonly string[]): Promise<void> => {
  const { values, positionals } = parseArgs({
    args: [...argv],
    options: { repo: { type: "string" }, since: { type: "string" } },
    allowPositionals: true,
  });
  const [lcovPath] = positionals;
  if (lcovPath === undefined || values.repo === undefined || values.since === undefined) {
    process.stderr.write(USAGE);
    process.exitCode = 2;
    return;
  }
  // --first-parent: a merged branch's commits dated before the period are still the period's work.
  const before = git(values.repo, [
    "rev-list",
    "-1",
    "--first-parent",
    `--before=${values.since}`,
    "HEAD",
  ]);
  if (before.status !== 0) {
    process.stderr.write(before.stderr);
    process.exitCode = 1;
    return;
  }
  const base = before.stdout.trim() || EMPTY_TREE;
  // The user's color and path-quoting settings would hide the "+++ b/FILE" lines from the parser.
  const diff = git(values.repo, [
    "-c",
    "core.quotePath=false",
    "diff",
    "--no-color",
    "-U0",
    base,
    "HEAD",
  ]);
  if (diff.status !== 0) {
    process.stderr.write(diff.stderr);
    process.exitCode = 1;
    return;
  }
  const lcov = parseLcov(readFileSync(lcovPath, "utf8"), values.repo);
  const measured = measureCoverage(lcov, parseChangedLines(diff.stdout));
  process.stdout.write(`${JSON.stringify({ base, ...measured })}\n`);
};

if (import.meta.main) {
  await main(process.argv.slice(2)).catch((error: unknown) => {
    console.error(error);
    process.exitCode = 1;
  });
}
