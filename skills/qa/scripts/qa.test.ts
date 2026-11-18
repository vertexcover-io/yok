import { describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { VerifierInput } from "@yok/sdk";
import { checkDesignCoverage, checkReportShape, QaOutputSchema, VisualMatchSchema } from "./qa.ts";
import { parseReportData } from "./report-media.ts";

const bug = {
  id: "03",
  summary: "the total skips refunds",
  trigger: "check out with a refund",
  hint: "subtract refunds",
};
const report = "verification/proof-report.html";
const gap = { scenario: "07", req: "R5", mechanism: "runs in a nightly job" };

describe("QaOutputSchema", () => {
  test("SC1: a PASS verdict with no reason parses", () => {
    const result = QaOutputSchema.safeParse({ status: "PASS", report, gaps: [], bugs: [] });

    expect(result.success).toBe(true);
  });

  test.each([
    { status: "PARTIAL", report, gaps: [gap], bugs: [] },
    { status: "FAIL", report: null, gaps: [], bugs: [{ ...bug, askUser: false }] },
    { status: "BLOCKED", report: null, gaps: [], bugs: [] },
  ])("SC2: a $status verdict fails on reason without one and parses with one", (verdict) => {
    const missing = QaOutputSchema.safeParse(verdict);
    const given = QaOutputSchema.safeParse({
      ...verdict,
      reason: "no-infra: podman is down",
    });

    expect(missing.error?.issues.map((issue) => issue.path)).toEqual([["reason"]]);
    expect(given.success).toBe(true);
  });

  test.each([
    ["SC11: a PASS verdict with no report", "PASS", null, [], ["report"]],
    ["SC11: a PARTIAL verdict with no report", "PARTIAL", null, [gap], ["report"]],
    ["SC12: a FAIL verdict with no bugs", "FAIL", null, [], ["bugs"]],
    ["a PARTIAL verdict with no gaps", "PARTIAL", report, [], ["gaps"]],
  ])("%s is rejected on that field", (_label, status, givenReport, gaps, path) => {
    const result = QaOutputSchema.safeParse({
      status,
      reason: "why",
      report: givenReport,
      gaps,
      bugs: [],
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

  test.each(["PASS", "PARTIAL", "BLOCKED"])(
    "a %s verdict that names a bug is rejected on bugs, since a bug makes the verdict FAIL",
    (status) => {
      const result = QaOutputSchema.safeParse({
        status,
        reason: "why",
        report: status === "BLOCKED" ? null : report,
        gaps: status === "PARTIAL" ? [gap] : [],
        bugs: [{ ...bug, askUser: false }],
      });

      expect(result.error?.issues.map((issue) => [issue.path, issue.message])).toEqual([
        [["bugs"], "only a FAIL names bugs: a bug makes the derived verdict FAIL"],
      ]);
    },
  );

  test("a PARTIAL with two gaps naming R5 is rejected on gaps, and one gap per requirement of a scenario parses", () => {
    const parse = (gaps: readonly object[]) =>
      QaOutputSchema.safeParse({ status: "PARTIAL", reason: "why", report, gaps, bugs: [] });

    const twice = parse([gap, { ...gap, mechanism: "no browser path" }]);
    const perRequirement = parse([gap, { ...gap, req: "EC1" }]);

    expect(twice.error?.issues.map((issue) => [issue.path, issue.message])).toEqual([
      [["gaps"], "each gap req appears once"],
    ]);
    expect(perRequirement.success).toBe(true);
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

const clean = { text: "The screen reads as drawn.", result: "pass" };
// A screen read against its design: a drawn one is shown beside the screen as built.
const drawn = (baseline: string | null, more: Record<string, unknown> = {}) => ({
  baseline,
  ...(baseline === null ? {} : { build: "screenshots/01_a__01_open.png" }),
  checks: [clean],
  ...more,
});

const reportWith = (
  baselines: readonly (string | null)[],
  coverage: readonly { req: string; scenario: string; verdict: string }[] = [],
): string => {
  const scenarios = baselines.map((baseline, i) => ({
    n: `SC${i + 1}`,
    visualMatch: drawn(baseline),
  }));
  return `<html><body><script type="application/json" id="report-data">${JSON.stringify({ scenarios, coverage })}</script></body></html>`;
};

// An artifacts/ folder holding plan.md, verification/proof-report.html and, when given,
// phases/phase-1.md, design/INDEX.md and design/spec.md.
const artifactsWith = (files: {
  report: string;
  plan?: string;
  phase?: string;
  index?: string;
  spec?: string;
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
  if (files.spec !== undefined) {
    mkdirSync(join(dir, "design"), { recursive: true });
    writeFileSync(join(dir, "design", "spec.md"), files.spec);
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

const frameGap = (mechanism: string) => ({ scenario: "03", req: "R9", mechanism });

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
      [frameGap("design/b.png: no route")],
      true,
    ],
    [
      "a PARTIAL whose gaps never name design/b.png fails",
      "PARTIAL",
      [frameGap("no sandbox")],
      false,
    ],
    [
      "a PARTIAL whose gap names design/b.png.old, not the frame, fails",
      "PARTIAL",
      [frameGap("design/b.png.old: no route")],
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

  const reportOf = (scenarios: readonly unknown[]): string =>
    `<script type="application/json" id="report-data">${JSON.stringify({ scenarios })}</script>`;

  test("a report whose visualMatch fills every field, with a check worth a look, passes", async () => {
    const visualMatch = {
      baseline: "../design/a.png",
      build: "screenshots/01_a.design.png",
      width: 1440,
      checks: [
        clean,
        { text: "Two buttons are small to tap.", result: "warn", note: "Not new.", proofs: ["p1"] },
      ],
    };
    const scenarios = [
      { n: "SC1", visualMatch },
      { n: "SC2", visualMatch: { ...visualMatch, baseline: "../design/b.png", width: 390 } },
    ];
    const dir = artifactsWith({ report: reportOf(scenarios), index: INDEX });

    expect(await checkReport(dir)).toEqual({ pass: true, findings: [] });
  });

  test("a PASS or PARTIAL whose scenario carries a failed design check fails, naming the scenario, with or without a design index; a FAIL passes", async () => {
    const broken = drawn("../design/a.png", {
      checks: [{ text: "The empty state shows.", result: "fail", saw: "The region is blank." }],
    });
    const scenarios = [
      { n: "SC1", visualMatch: broken },
      { n: "SC2", visualMatch: drawn("../design/b.png") },
    ];
    const indexed = artifactsWith({ report: reportOf(scenarios), index: INDEX });
    const unindexed = artifactsWith({ report: reportOf(scenarios) });

    const result = await checkReport(indexed);

    expect(result.pass).toBe(false);
    expect(result.findings.map(({ message }) => message)).toEqual([expect.stringContaining("SC1")]);
    expect(result.findings[0]?.message).toContain("FAILURE");
    expect((await checkReport(indexed, { status: "PARTIAL", gaps: [gap] })).pass).toBe(false);
    expect((await checkReport(unindexed)).pass).toBe(false);
    expect(await checkReport(indexed, { status: "FAIL" })).toEqual({ pass: true, findings: [] });
  });

  test("a scenario that read design/b.png at a width other than the index's 390 fails, naming the frame and both widths", async () => {
    const at = (width: number) => [
      { n: "SC1", visualMatch: drawn("../design/a.png") },
      { n: "SC2", visualMatch: drawn("../design/b.png", { build: "screenshots/02.png", width }) },
    ];
    const wrong = artifactsWith({ report: reportOf(at(1440)), index: INDEX });
    const right = artifactsWith({ report: reportOf(at(390)), index: INDEX });

    const result = await checkReport(wrong);

    expect(result.pass).toBe(false);
    expect(result.findings).toHaveLength(1);
    expect(result.findings[0]?.message).toContain("design/b.png");
    expect(result.findings[0]?.message).toContain("1440");
    expect(result.findings[0]?.message).toContain("390");
    expect(await checkReport(right)).toEqual({ pass: true, findings: [] });
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

  const COVERAGE = [
    { req: "R1", scenario: "01", verdict: "SUCCESS" },
    { req: "R2", scenario: "02", verdict: "SUCCESS" },
  ];

  test("SC718: a PASS on a run with design/spec.md whose coverage has no SPEC: row fails, and passes once one is added", async () => {
    const baselines = ["../design/a.png", "../design/b.png"];
    const spec = "# Spec\n\nThe modal is 420px wide.\n";
    const noSpecRow = artifactsWith({
      report: reportWith(baselines, COVERAGE),
      index: INDEX,
      spec,
    });
    const specRow = { req: "SPEC: modal is 420px wide", scenario: "02", verdict: "SUCCESS" };
    const withSpecRow = artifactsWith({
      report: reportWith(baselines, [...COVERAGE, specRow]),
      index: INDEX,
      spec,
    });

    const result = await checkReport(noSpecRow);

    expect(result.pass).toBe(false);
    expect(result.findings).toHaveLength(1);
    expect(result.findings[0]?.message).toContain("design/spec.md");
    expect(result.findings[0]?.message).toContain("SPEC:");
    expect(result.findings[0]?.path).toBe(reportPath(noSpecRow));
    expect(await checkReport(withSpecRow)).toEqual({ pass: true, findings: [] });
  });

  test("a run with design/spec.md and no design/INDEX.md still needs a SPEC: row in a PASS or PARTIAL, and a FAIL passes through", async () => {
    const spec = "# Spec\n\nThe modal is 420px wide.\n";
    const specRow = { req: "SPEC: modal is 420px wide", scenario: "02", verdict: "SUCCESS" };
    const noSpecRow = artifactsWith({ report: reportWith([null], COVERAGE), spec });
    const withSpecRow = artifactsWith({ report: reportWith([null], [...COVERAGE, specRow]), spec });

    const result = await checkReport(noSpecRow);

    expect(result.pass).toBe(false);
    expect(result.findings.map(({ message }) => message)).toEqual([
      expect.stringContaining("no SPEC: row"),
    ]);
    expect((await checkReport(noSpecRow, { status: "PARTIAL", gaps: [] })).pass).toBe(false);
    expect(await checkReport(noSpecRow, { status: "FAIL" })).toEqual({ pass: true, findings: [] });
    expect(await checkReport(withSpecRow)).toEqual({ pass: true, findings: [] });
  });

  test("a spec.md that holds only headings states no rule, so a PASS needs no SPEC: row", async () => {
    const spec = "## Clear all spec\n\n\n## Notes\n";
    const dir = artifactsWith({ report: reportWith([null], COVERAGE), spec });

    expect(await checkReport(dir)).toEqual({ pass: true, findings: [] });
  });

  test("SC719: a run with no design/spec.md passes with coverage rows that are all R-style", async () => {
    const dir = artifactsWith({
      report: reportWith(["../design/a.png", "../design/b.png"], COVERAGE),
      index: INDEX,
    });

    expect(await checkReport(dir)).toEqual({ pass: true, findings: [] });
  });

  test.each([
    ["no report-data island", "<html><body></body></html>"],
    [
      "a visualMatch check graded minor",
      reportWith(["../design/a.png"]).replace('"result":"pass"', '"result":"minor"'),
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
  test("SC22 (design): a visualMatch with a re-shoot at 1440 and a failed check parses, and a check with no text does not", () => {
    const visualMatch = {
      baseline: "../design/a.png",
      build: "screenshots/01_a.design.png",
      width: 1440,
      checks: [{ text: "Body text is the drawn size.", result: "fail", saw: "It is larger." }],
    };
    const emptyText = { ...visualMatch, checks: [{ text: "", result: "pass" }] };

    expect(VisualMatchSchema.safeParse(visualMatch).success).toBe(true);
    expect(VisualMatchSchema.safeParse(emptyText).success).toBe(false);
  });

  test("a drawn screen names the screen as built, an undrawn one needs none, and a width needs a build", () => {
    const undrawn = { baseline: null, checks: [clean] };

    expect(VisualMatchSchema.safeParse(undrawn).success).toBe(true);
    expect(VisualMatchSchema.safeParse(drawn("../design/a.png")).success).toBe(true);
    expect(VisualMatchSchema.safeParse({ ...undrawn, baseline: "../design/a.png" }).success).toBe(
      false,
    );
    expect(VisualMatchSchema.safeParse({ ...undrawn, width: 1440 }).success).toBe(false);
  });

  test("a visualMatch says what was looked at: no checks is rejected", () => {
    expect(VisualMatchSchema.safeParse({ baseline: null, checks: [] }).success).toBe(false);
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

const shapeReport = (scenarios: unknown[]): string =>
  `<html><body><script type="application/json" id="report-data">${JSON.stringify({ scenarios })}</script></body></html>`;

const checkShape = (scenarios: unknown[], output: VerifierInput["output"] = { status: "PASS" }) => {
  const dir = artifactsWith({ report: shapeReport(scenarios) });
  return checkReportShape({
    run: "r",
    nodeRunId: "nr-1",
    output,
    artifacts: [{ type: "proof-report", name: "proof-report", path: reportPath(dir) }],
    args: null,
    nodeInput: null,
  });
};

const proof = { id: "p1", label: "Database", claim: "The row is stored.", holds: true, raw: "row" };
const passed = { text: "The total updates.", result: "pass", proofs: ["p1"] };
const failed = { text: "The total updates.", result: "fail", saw: "It stays the same." };
const step = (...checks: unknown[]) => ({ when: "The user saves the invoice.", checks });
const scenario = (more: Record<string, unknown>) => ({
  n: "01",
  group: "journey",
  verdict: "SUCCESS",
  title: "Does saving an invoice update its total?",
  given: ["An invoice has one line."],
  steps: [step(passed)],
  proofs: [proof],
  ...more,
});

const messages = async (given: Record<string, unknown>): Promise<string[]> =>
  (await checkShape([scenario(given), scenario({ n: "02" })])).findings.map(
    ({ message }) => message,
  );

describe("checkReportShape", () => {
  test("a passed scenario, a failed one and one nothing could drive each pass in the shape their verdict owes", async () => {
    const result = await checkShape([
      scenario({}),
      scenario({ n: "02", verdict: "FAILURE", steps: [step(failed)], proofs: [] }),
      scenario({
        n: "03",
        verdict: "NOT VERIFIED",
        steps: [step({ text: "The total updates." })],
        proofs: [],
      }),
    ]);

    expect(result).toEqual({ pass: true, findings: [] });
  });

  test("a scenario carried over as four paragraphs is named for its given and its steps", async () => {
    const result = await checkShape([
      { n: "04", verdict: "SUCCESS", given: "g", when: "w", output: "o" },
      scenario({}),
    ]);

    expect(result.pass).toBe(false);
    expect(result.findings.every(({ message }) => message.startsWith("scenario 04"))).toBe(true);
    expect(result.findings.map(({ message }) => message).join(" ")).toContain("steps");
  });

  test.each([
    ["no title", { title: "" }, "title"],
    ["given written as a paragraph", { given: "An invoice has one line." }, "given"],
    ["a step with no check", { steps: [step()], proofs: [] }, "at least one check"],
    ["a step with no when", { steps: [{ checks: [passed] }] }, "when"],
    [
      "a driven check with no result",
      { steps: [step({ text: "It saves." })], proofs: [] },
      "result",
    ],
    ["a failed check on a SUCCESS", { steps: [step(failed)], proofs: [] }, "FAILURE"],
    ["no failed check on a FAILURE", { verdict: "FAILURE" }, "no failed check"],
    [
      "a failed check that does not say what was seen",
      { verdict: "FAILURE", steps: [step({ ...failed, saw: "" })], proofs: [] },
      "saw",
    ],
    ["a check citing a proof the scenario lacks", { proofs: [] }, "p1"],
    ["a proof no check cites", { proofs: [proof, { ...proof, id: "p2" }] }, "p2"],
    ["a proof with no id", { proofs: [proof, { ...proof, id: undefined }] }, "id"],
    ["a proof whose holds is a string", { proofs: [{ ...proof, holds: "true" }] }, "holds"],
    ["a proof whose holds is omitted", { proofs: [{ ...proof, holds: undefined }] }, "holds"],
    ["no group", { group: undefined }, "group"],
    [
      "a group heading that runs long",
      { group: "Everything that can go wrong with names" },
      "5 words",
    ],
    [
      "the journey group on a scenario only a test recorded",
      { recordings: [{ video: "a.mp4" }] },
      "primary journey",
    ],
    [
      "a proof whose raw runs long",
      {
        proofs: [{ ...proof, raw: Array.from({ length: 16 }, (_, i) => `value ${i}`).join("\n") }],
      },
      "15 lines",
    ],
    [
      "a proof whose raw carries the script that read the page",
      {
        proofs: [{ ...proof, raw: "(() => document.querySelector('h1').innerText)()\n→ Invoices" }],
      },
      "script",
    ],
    [
      "a computed style in a check",
      { steps: [step({ ...passed, text: "The header is rgb(255, 255, 255)." })] },
      "plain words",
    ],
    [
      "a request line in a step",
      { steps: [{ ...step(passed), when: "POST /invoices is sent." }] },
      "plain words",
    ],
  ])("a scenario with %s is named for it", async (_name, given, expected) => {
    const found = await messages(given);

    expect(found.length).toBeGreaterThan(0);
    expect(found.every((message) => message.startsWith("scenario 01"))).toBe(true);
    expect(found.join(" ")).toContain(expected);
  });

  test("a design check cites proofs like any other, and its failure makes the scenario a FAILURE", async () => {
    const design = (result: string) => ({
      baseline: null,
      checks: [{ text: "The label fits.", result, saw: "It is cut off.", proofs: ["p1"] }],
    });
    const cited = { steps: [step({ ...passed, proofs: [] })] };

    expect(await messages({ ...cited, visualMatch: design("warn") })).toEqual([]);
    expect((await messages({ ...cited, visualMatch: design("fail") })).join(" ")).toContain(
      "FAILURE",
    );
  });

  test("a report whose scenarios are all in named groups is asked for its primary journeys", async () => {
    const result = await checkShape([scenario({ group: "Name checks" })]);

    expect(result.findings.map(({ message }) => message).join(" ")).toContain("primary journey");
  });

  test("a FAIL passes whatever its report holds, so its bugs reach the fix loop", async () => {
    const result = await checkShape([{ n: "07", verdict: "FAILURE" }], { status: "FAIL" });

    expect(result).toEqual({ pass: true, findings: [] });
  });
});
