import { describe, expect, test } from "bun:test";
import { QaOutputSchema } from "./qa.ts";

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
