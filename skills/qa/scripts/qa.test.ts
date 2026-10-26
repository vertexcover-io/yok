import { describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { VerifierInput } from "@yok/sdk";
import { checkDesignCoverage, QaOutputSchema, VisualMatchSchema } from "./qa.ts";
import { parseReportData } from "./report-media.ts";

const bug = {
  id: "03",
  summary: "the total skips refunds",
  trigger: "check out with a refund",
  hint: "subtract refunds",
};
const report = "verification/proof-report.html";

describe("QaOutputSchema", () => {
  test("SC1: a PASS verdict with no reason parses", () => {
    const result = QaOutputSchema.safeParse({ status: "PASS", report, gaps: [], bugs: [] });

    expect(result.success).toBe(true);
  });

  test.each([
    { status: "PARTIAL", report, bugs: [] },
    { status: "FAIL", report: null, bugs: [{ ...bug, askUser: false }] },
    { status: "BLOCKED", report: null, bugs: [] },
  ])("SC2: a $status verdict fails on reason without one and parses with one", (verdict) => {
    const missing = QaOutputSchema.safeParse({ ...verdict, gaps: [] });
    const given = QaOutputSchema.safeParse({
      ...verdict,
      gaps: [],
      reason: "no-infra: podman is down",
    });

    expect(missing.error?.issues.map((issue) => issue.path)).toEqual([["reason"]]);
    expect(given.success).toBe(true);
  });

  test.each([
    ["SC11: a PASS verdict with no report", "PASS", [], ["report"]],
    ["SC11: a PARTIAL verdict with no report", "PARTIAL", [], ["report"]],
    ["SC12: a FAIL verdict with no bugs", "FAIL", [], ["bugs"]],
  ])("%s is rejected on that field", (_label, status, bugs, path) => {
    const result = QaOutputSchema.safeParse({
      status,
      reason: "why",
      report: null,
      gaps: [],
      bugs,
    });

    expect(result.error?.issues.map((issue) => issue.path)).toEqual([path]);
  });

  test("SC4 (review-loop SC2): a FAIL whose bug is a fix request parses unchanged, and one without askUser or in the old scenario/cause/fix shape is rejected", () => {
    const verdict = { status: "FAIL", reason: "one bug", report: null, gaps: [] };
    const parse = (bugs: readonly object[]) => QaOutputSchema.safeParse({ ...verdict, bugs });

    const given = parse([{ ...bug, askUser: false }]);
    const old = { scenario: "03", cause: "skips refunds", fix: "subtract", needsDecision: false };

    expect(given.data?.bugs[0]).toEqual({ ...bug, askUser: false });
    expect(parse([bug]).success).toBe(false);
    expect(parse([old]).success).toBe(false);
  });

  test("a FAIL with two bugs sharing id 03 is rejected on bugs", () => {
    const result = QaOutputSchema.safeParse({
      status: "FAIL",
      reason: "SC3 failed twice",
      report: null,
      gaps: [],
      bugs: [
        { ...bug, askUser: false },
        { ...bug, summary: "refunds double count", askUser: false },
      ],
    });

    expect(result.error?.issues.map((issue) => [issue.path, issue.message])).toEqual([
      [["bugs"], "each bug id appears once"],
    ]);
  });
});

const INDEX = `| Screen | Local file | Width | Source | Source of truth for |
|---|---|---|---|---|
| Home, desktop | \`design/a.png\` | 1440 | mockup | layout |
| Home, mobile | \`design/b.png\` | 390 | mockup | layout |
`;

const reportWith = (baselines: readonly (string | null)[]): string => {
  const scenarios = baselines.map((baseline, i) => ({
    id: `SC${i + 1}`,
    visualMatch: { baseline, fidelity: baseline === null ? null : 90 },
  }));
  return `<html><body><script type="application/json" id="report-data">${JSON.stringify({ scenarios })}</script></body></html>`;
};

// An artifacts/ folder holding plan.md, verification/proof-report.html and, when given,
// phases/phase-1.md and design/INDEX.md.
const artifactsWith = (files: {
  report: string;
  plan?: string;
  phase?: string;
  index?: string;
}): string => {
  const dir = join(mkdtempSync(join(tmpdir(), "qa-")), "artifacts");
  mkdirSync(join(dir, "phases"), { recursive: true });
  mkdirSync(join(dir, "verification"));
  writeFileSync(join(dir, "plan.md"), files.plan ?? "# Plan\n");
  writeFileSync(join(dir, "verification", "proof-report.html"), files.report);
  if (files.phase !== undefined) writeFileSync(join(dir, "phases", "phase-1.md"), files.phase);
  if (files.index !== undefined) {
    mkdirSync(join(dir, "design"));
    writeFileSync(join(dir, "design", "INDEX.md"), files.index);
  }
  return dir;
};

const reportPath = (dir: string): string => join(dir, "verification", "proof-report.html");

const check = (
  artifacts: { type: string; name: string; path: string }[],
  output: VerifierInput["output"] = { status: "PASS" },
) =>
  checkDesignCoverage({
    run: "r",
    nodeRunId: "nr-1",
    output,
    artifacts,
    args: null,
    nodeInput: null,
  });

const checkReport = (dir: string, output?: VerifierInput["output"]) =>
  check([{ type: "proof-report", name: "proof-report", path: reportPath(dir) }], output);

const gap = (mechanism: string) => ({ scenario: "03", req: "R9", mechanism });

describe("checkDesignCoverage", () => {
  test("SC14 (design): a report whose scenarios compare against ../design/a.png and ../design/b.png passes", async () => {
    const dir = artifactsWith({
      report: reportWith(["../design/a.png", "../design/b.png"]),
      index: INDEX,
    });

    expect(await checkReport(dir)).toEqual({ pass: true, findings: [] });
  });

  test("SC15 (design): a report with no scenario on ../design/b.png fails with one finding naming design/b.png, on the report", async () => {
    const dir = artifactsWith({ report: reportWith(["../design/a.png", null]), index: INDEX });

    const result = await checkReport(dir);

    expect(result.pass).toBe(false);
    expect(result.findings).toHaveLength(1);
    expect(result.findings[0]?.message).toContain("design/b.png");
    expect(result.findings[0]?.path).toBe(reportPath(dir));
  });

  test.each([
    ["a FAIL passes, so its bugs reach the fix loop", "FAIL", [], true],
    [
      "a PARTIAL whose gap names design/b.png passes",
      "PARTIAL",
      [gap("design/b.png: no route")],
      true,
    ],
    ["a PARTIAL whose gaps never name design/b.png fails", "PARTIAL", [gap("no sandbox")], false],
    [
      "a PARTIAL whose gap names design/b.png.old, not the frame, fails",
      "PARTIAL",
      [gap("design/b.png.old: no route")],
      false,
    ],
    [
      "a PARTIAL whose gap names the frame only in its scenario field fails",
      "PARTIAL",
      [{ scenario: "design/b.png", req: "R9", mechanism: "no route" }],
      false,
    ],
  ])("a report that could not compare design/b.png: %s", async (_name, status, gaps, pass) => {
    const dir = artifactsWith({ report: reportWith(["../design/a.png", null]), index: INDEX });

    expect((await checkReport(dir, { status, gaps })).pass).toBe(pass);
  });

  test("a FAIL whose report has no data island passes, so its bugs reach the fix loop", async () => {
    const dir = artifactsWith({ report: "<html></html>", index: INDEX });

    expect(await checkReport(dir, { status: "FAIL", gaps: [] })).toEqual({
      pass: true,
      findings: [],
    });
  });

  test("SC16 (design): a frame phases/phase-1.md records as not built needs no scenario, so the report passes", async () => {
    const dir = artifactsWith({
      report: reportWith(["../design/a.png", null]),
      phase: "design/b.png — not built: same screen as a.png\n",
      index: INDEX,
    });

    expect(await checkReport(dir)).toEqual({ pass: true, findings: [] });
  });

  test("a not-built line with the path in backticks needs no scenario, so the report passes", async () => {
    const dir = artifactsWith({
      report: reportWith(["../design/a.png", null]),
      phase: "`design/b.png` — not built: same screen as a.png\n",
      index: INDEX,
    });

    expect(await checkReport(dir)).toEqual({ pass: true, findings: [] });
  });

  test("a not-built line wrapped after the dash, with a capital N, needs no scenario", async () => {
    const dir = artifactsWith({
      report: reportWith(["../design/a.png", null]),
      phase: "design/b.png —\n  Not built: same screen as a.png\n",
      index: INDEX,
    });

    expect(await checkReport(dir)).toEqual({ pass: true, findings: [] });
  });

  test("a report whose visualMatch fills every field, with a BLOCKER and a HIGH finding, passes", async () => {
    const finding = {
      what: "button",
      baselineShows: "filled",
      buildShows: "ghost",
      evidence: "css",
    };
    const visualMatch = {
      baseline: "../design/a.png",
      build: "screenshots/01_a.design.png",
      width: 1440,
      fidelity: 67,
      matched: "Region order reads as drawn.",
      specRules: [{ rule: "Body text is 14px", held: true, evidence: "font-size: 14px" }],
      findings: [
        { severity: "BLOCKER", ...finding },
        { severity: "HIGH", ...finding },
      ],
    };
    const scenarios = [
      { id: "SC1", visualMatch },
      { id: "SC2", visualMatch: { ...visualMatch, baseline: "../design/b.png" } },
    ];
    const dir = artifactsWith({
      report: `<script type="application/json" id="report-data">${JSON.stringify({ scenarios })}</script>`,
      index: INDEX,
    });

    expect(await checkReport(dir)).toEqual({ pass: true, findings: [] });
  });

  test.each([
    [
      "in plan.md, the dash form with a reason passes",
      "design/b.png — not built: same screen as a.png",
      true,
    ],
    ["in plan.md, the hyphen form with a reason passes", "design/b.png - not built: same", true],
    [
      "in plan.md, a bare not built: with a line below it fails",
      "design/b.png — not built:\n## Next section\n",
      false,
    ],
  ])("a not-built line for design/b.png %s", async (_name, plan, pass) => {
    const dir = artifactsWith({
      report: reportWith(["../design/a.png", null]),
      plan,
      index: INDEX,
    });

    expect((await checkReport(dir)).pass).toBe(pass);
  });

  test("SC17 (design): a report with no design/INDEX.md, and an index with no proof-report artifact, both pass untouched", async () => {
    const noIndex = artifactsWith({ report: reportWith([null]) });
    const noReport = artifactsWith({ report: reportWith([null]), index: INDEX });

    expect(await checkReport(noIndex)).toEqual({ pass: true, findings: [] });
    expect(await check([{ type: "plan", name: "plan", path: join(noReport, "plan.md") }])).toEqual({
      pass: true,
      findings: [],
    });
  });

  test.each([
    ["no report-data island", "<html><body></body></html>"],
    [
      "a visualMatch finding graded LOW",
      reportWith(["../design/a.png"]).replace(
        '"fidelity":90',
        '"fidelity":90,"findings":[{"severity":"LOW","what":"button","baselineShows":"primary","buildShows":"secondary","evidence":"getComputedStyle"}]',
      ),
    ],
  ])(
    "SC18 (design): a report with %s fails with one finding naming the island, not a crash",
    async (_, report) => {
      const dir = artifactsWith({
        report,
        index: "| Screen | Local file |\n|---|---|\n| Home | `design/a.png` |\n",
      });

      const result = await checkReport(dir);

      expect(result.pass).toBe(false);
      expect(result.findings).toHaveLength(1);
      expect(result.findings[0]?.message).toContain("report-data island");
      expect(result.findings[0]?.path).toBe(reportPath(dir));
    },
  );
});

describe("VisualMatchSchema", () => {
  test("SC22 (design): a visualMatch with a re-shoot at 1440 and a broken spec rule parses, and a spec rule with an empty rule does not", () => {
    const visualMatch = {
      baseline: "../design/a.png",
      build: "screenshots/01_a.design.png",
      width: 1440,
      fidelity: 92,
      specRules: [{ rule: "Body text is 14px", held: false, evidence: "font-size: 16px" }],
    };
    const emptyRule = {
      ...visualMatch,
      specRules: [{ rule: "", held: true, evidence: "font-size: 14px" }],
    };

    expect(VisualMatchSchema.safeParse(visualMatch).success).toBe(true);
    expect(VisualMatchSchema.safeParse(emptyRule).success).toBe(false);
  });

  test("the proof-report template's visualMatch scaffold has exactly the schema's fields", () => {
    const template = readFileSync(
      join(import.meta.dir, "../references/proof-report-template.html"),
      "utf8",
    );
    const scenarios = parseReportData(template)?.scenarios;
    const scaffold = Array.isArray(scenarios) ? scenarios[0]?.visualMatch : undefined;

    expect(Object.keys(scaffold ?? {}).toSorted()).toEqual(
      Object.keys(VisualMatchSchema.shape).toSorted(),
    );
  });
});
