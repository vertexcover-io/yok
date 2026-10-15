import { describe, expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { cpSync, existsSync, mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  aggregate,
  type Bundle,
  BundleSchema,
  bundleDir,
  countDiffLines,
  inLedger,
  parseSeverity,
  parseTitle,
  pickSha,
  repoOfRemote,
} from "./gap.ts";

const SCRIPT = join(import.meta.dir, "gap.ts");
const FILES = join(import.meta.dir, "..", "evals", "files");

const copyFixture = (name: string): string => {
  const dir = mkdtempSync(join(tmpdir(), "gap-"));
  cpSync(join(FILES, name), dir, { recursive: true });
  return dir;
};

const gap = (args: readonly string[], cwd?: string) =>
  spawnSync("bun", [SCRIPT, ...args], { cwd, encoding: "utf8" });

describe("bundle", () => {
  test("keeps the bug reports, attaches the human reply, and drops style, drift-bot and praise", () => {
    const dir = copyFixture("pr-one");
    const bundle = bundleDir(dir, "acme/widgets");

    expect(bundle.ok).toBe(true);
    if (!bundle.ok) return;
    expect(bundle.value.findings.map((f) => f.commentId)).toEqual([101, 105]);
    expect(bundle.value.findings[0]).toMatchObject({
      id: "acme/widgets#7:101",
      reviewer: "xhawk-ai[bot]",
      severity: "high",
      category: "correctness",
      title: "A partial publish cannot be re-run",
      path: "src/publish.ts",
      line: 12,
      commitSha: "aaa111",
      humanReply: "Fixed in bbb222: each package is checked with npm view first.",
    });
    expect(bundle.value.findings[1]?.severity).toBe("unknown");
    expect(bundle.value.dropped.map((d) => [d.commentId, d.reason])).toEqual([
      [103, "style"],
      [104, "drift-bot"],
      [106, "praise"],
    ]);
    expect(bundle.value.reviews).toHaveLength(1);
    expect(bundle.value.diffLines).toBe(4);
    expect(
      BundleSchema.safeParse(JSON.parse(readFileSync(join(dir, "bundle.json"), "utf8"))).success,
    ).toBe(true);
  });

  test("the CLI prints the counts and exits 0; a missing file exits 1 with its name", () => {
    const dir = copyFixture("pr-one");
    const run = gap(["bundle", dir, "--repo", "acme/widgets"]);
    expect(run.status).toBe(0);
    expect(run.stdout.trim()).toBe("2 findings, 3 dropped, 4 diff lines");

    const missing = gap(["bundle", mkdtempSync(join(tmpdir(), "gap-empty-")), "--repo", "a/b"]);
    expect(missing.status).toBe(1);
    expect(missing.stderr).toContain("pr.json");
  });

  test("severity comes from the badge, the title loses the badge markup", () => {
    expect(parseSeverity("x severity/critical-dark.svg")).toBe("critical");
    expect(parseSeverity("no badge here")).toBe("unknown");
    expect(parseTitle('### Title here <picture><img alt="High"></picture>\n\nbody')).toBe(
      "Title here",
    );
  });

  test("diff lines count changed lines only", () => {
    expect(countDiffLines("--- a\n+++ b\n@@ -1 +1 @@\n-old\n+new\n+more\n context")).toBe(3);
  });
});

describe("repos", () => {
  test("owner/name comes from ssh and https remotes", () => {
    expect(repoOfRemote("git@github.com:vertexcover-io/yok.git")).toBe("vertexcover-io/yok");
    expect(repoOfRemote("https://github.com/vertexcover-io/yok")).toBe("vertexcover-io/yok");
    expect(repoOfRemote("https://gitlab.com/a/b.git")).toBeUndefined();
  });
});

const bundleWith = (findings: Bundle["findings"]): Bundle => ({
  repo: "a/b",
  number: 1,
  title: "t",
  prBody: "",
  state: "closed",
  mergedAt: null,
  baseRef: "main",
  baseSha: "base",
  headSha: "head",
  diffLines: 1,
  findings,
  dropped: [],
  reviews: [],
  issueComments: [],
  commits: [
    { sha: "c1", message: "" },
    { sha: "c2", message: "" },
  ],
});

const finding = (commentId: number, commitSha: string): Bundle["findings"][number] => ({
  id: `a/b#1:${commentId}`,
  commentId,
  reviewer: "x",
  severity: "high",
  category: "correctness",
  title: "t",
  path: "p",
  line: 1,
  commitSha,
  body: "",
  replies: [],
  humanReply: "",
});

describe("checkout commit", () => {
  test("the commit most findings name wins; a tie goes to the earlier commit; no findings means the head", () => {
    expect(pickSha(bundleWith([finding(1, "c2"), finding(2, "c2"), finding(3, "c1")]))).toBe("c2");
    expect(pickSha(bundleWith([finding(1, "c2"), finding(2, "c1")]))).toBe("c1");
    expect(pickSha(bundleWith([]))).toBe("head");
  });
});

describe("ledger", () => {
  test("a PR is skipped only when every top-level comment on this head is already judged", () => {
    const bundle = bundleWith([finding(1, "c1"), finding(2, "c1")]);
    const judged = [{ key: "a/b#1@head", commentIds: [1, 2], at: "" }];
    expect(inLedger(judged, bundle)).toBe(true);
    expect(inLedger([{ key: "a/b#1@head", commentIds: [1], at: "" }], bundle)).toBe(false);
    expect(inLedger([{ key: "a/b#1@other", commentIds: [1, 2], at: "" }], bundle)).toBe(false);
  });
});

describe("aggregate", () => {
  test("ranks the two-PR cluster above the one-PR cluster, reports precision, writes one jsonl row per finding, and fills the ledger once", () => {
    const dir = copyFixture("aggregate");
    const options = {
      out: dir,
      report: join(dir, "out", "review-gap.md"),
      findings: join(dir, "out", "findings.jsonl"),
      ledger: join(dir, "ledger.jsonl"),
      clusters: join(dir, "clusters.json"),
      now: new Date("2026-10-13T00:00:00Z"),
    };

    const first = aggregate(options);
    expect(first.ok).toBe(true);
    const report = readFileSync(options.report, "utf8");
    const twoPlaces = report.indexOf("### 1. Same fact decided in two places (score 6");
    const catchAll = report.indexOf("### 2. Catch-all before an irreversible step (score 3");
    expect(twoPlaces).toBeGreaterThan(-1);
    expect(catchAll).toBeGreaterThan(twoPlaces);
    expect(report).toContain("| xhawk-ai[bot] | 3 | 1 | 0 | 75% |");
    expect(report).toContain("| Replays: caught / partial / miss | 1 / 0 / 2 |");
    expect(report).toContain("| Misses: agent-miss / prompt-gap | 1 / 1 |");
    expect(report).toContain("Missing step: nothing asks where else the target is decided");
    expect(report).toContain("(in `skills/code-review/references/persona-spec.md`)");
    expect(report).toContain('acme/widgets#9 xhawk-ai[bot]: style, "Rename dir to pkg"');

    const rows = readFileSync(options.findings, "utf8")
      .trim()
      .split("\n")
      .map((l) => JSON.parse(l));
    expect(rows).toHaveLength(4);
    expect(rows.find((r) => r.id === "acme/widgets#7:701")).toMatchObject({
      verdict: "real",
      cluster: "two-places",
      replay: [{ persona: "spec", result: "miss", cause: "prompt-gap" }],
    });

    expect(readFileSync(options.ledger, "utf8").trim().split("\n")).toHaveLength(3);
    const again = aggregate(options);
    expect(again.ok).toBe(true);
    expect(readFileSync(options.ledger, "utf8").trim().split("\n")).toHaveLength(3);
  });

  test("without a clusters file, real findings cluster by lens", () => {
    const dir = copyFixture("aggregate");
    const report = join(dir, "r.md");
    const done = aggregate({
      out: dir,
      report,
      findings: join(dir, "f.jsonl"),
      ledger: undefined,
      clusters: undefined,
      now: new Date(),
    });
    expect(done.ok).toBe(true);
    expect(readFileSync(report, "utf8")).toContain(
      "### 1. Where else is this fact decided? (score 6",
    );
    expect(existsSync(join(dir, "ledger.jsonl"))).toBe(false);
  });

  test("the CLI refuses a broken analysis file by name", () => {
    const dir = copyFixture("aggregate");
    const bad = join(dir, "acme", "widgets", "7", "analysis.json");
    spawnSync("sh", ["-c", `echo '{"repo":1}' > "${bad}"`]);
    const run = gap([
      "aggregate",
      "--out",
      dir,
      "--report",
      join(dir, "r.md"),
      "--findings",
      join(dir, "f.jsonl"),
    ]);
    expect(run.status).toBe(1);
    expect(run.stderr).toContain(bad);
  });

  test("list prints the real findings with their lens and mechanism", () => {
    const run = gap(["list", "--out", join(FILES, "aggregate")]);
    expect(run.status).toBe(0);
    expect(run.stdout).toContain("acme/widgets#9:901\thigh\tA\tcatch-all turns every failure");
    expect(run.stdout).not.toContain("acme/widgets#9:902");
  });
});
