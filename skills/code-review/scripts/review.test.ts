import { describe, expect, test } from "bun:test";
import { ReviewOutputSchema } from "./review.ts";

const finding = {
  id: "defects-1",
  axis: "defects",
  severity: "High",
  size: "small",
  file: "src/run.ts",
  line: 42,
  summary: "runTask does not await the save",
  trigger: "a task finishes while the save is still pending",
  hint: "await the save; keep the return value",
};
const report = "artifacts/review.md";
const reviewed = { yok: "f69949a" };

describe("ReviewOutputSchema", () => {
  test.each([
    { verdict: "APPROVED", findings: [] },
    { verdict: "CHANGES_REQUESTED", findings: [finding] },
  ])("SC9: $verdict with matching findings parses", (output) => {
    expect(ReviewOutputSchema.safeParse({ ...output, report, reviewed }).success).toBe(true);
  });

  test.each([
    { verdict: "APPROVED", findings: [finding] },
    { verdict: "CHANGES_REQUESTED", findings: [] },
  ])("SC9: $verdict that disagrees with its findings is rejected on verdict", (output) => {
    const result = ReviewOutputSchema.safeParse({ ...output, report, reviewed });

    expect(result.error?.issues.map((issue) => issue.path)).toEqual([["verdict"]]);
  });

  test.each([
    ["no file", { ...finding, file: undefined }],
    ["no severity", { ...finding, severity: undefined }],
    ["no axis", { ...finding, axis: undefined }],
    ["no size", { ...finding, size: undefined }],
    ["a Low severity", { ...finding, severity: "Low" }],
    ["an old axis", { ...finding, axis: "reuse" }],
    ["an id that is not AXIS-N", { ...finding, id: "$(touch x)" }],
    ["an absolute file", { ...finding, file: "/etc/passwd" }],
  ])("SC10: a finding with %s is rejected", (_, bad) => {
    const result = ReviewOutputSchema.safeParse({
      verdict: "CHANGES_REQUESTED",
      report,
      reviewed,
      findings: [bad],
    });

    expect(result.success).toBe(false);
  });

  test.each([
    ["missing", {}],
    ["empty", { reviewed: {} }],
  ])("an output whose reviewed heads are %s is rejected on reviewed", (_, heads) => {
    const result = ReviewOutputSchema.safeParse({
      verdict: "APPROVED",
      report,
      findings: [],
      ...heads,
    });

    expect(result.error?.issues.map((issue) => issue.path)).toEqual([["reviewed"]]);
  });

  test("reviewed heads keyed by a camelCase repo name, as create-workspace emits it, parse", () => {
    const output = { verdict: "APPROVED", report, reviewed: { myApi: "f69949a" }, findings: [] };

    expect(ReviewOutputSchema.safeParse(output).success).toBe(true);
  });

  test("two findings with one id are rejected on findings", () => {
    const result = ReviewOutputSchema.safeParse({
      verdict: "CHANGES_REQUESTED",
      report,
      reviewed,
      findings: [finding, { ...finding, line: 50 }],
    });

    expect(result.error?.issues.map((issue) => issue.path)).toEqual([["findings"]]);
  });

  test("a malformed finding and a disagreeing verdict are both named in one parse", () => {
    const result = ReviewOutputSchema.safeParse({
      verdict: "APPROVED",
      report,
      reviewed,
      findings: [{ ...finding, file: undefined }],
    });

    expect(result.error?.issues.map((issue) => issue.path)).toEqual([
      ["findings", 0, "file"],
      ["verdict"],
    ]);
  });

  test.each([
    ["an APPROVED verdict", { verdict: "APPROVED", reviewed }, [["verdict"], ["findings"]]],
    [
      "no reviewed heads",
      { verdict: "CHANGES_REQUESTED", reviewed: {} },
      [["reviewed"], ["findings"]],
    ],
  ])("%s and two findings sharing an id are both named in one parse", (_, top, paths) => {
    const result = ReviewOutputSchema.safeParse({ ...top, report, findings: [finding, finding] });

    expect(result.error?.issues.map((issue) => issue.path)).toEqual(paths);
  });

  test.each([
    ["findings is not a list", { verdict: "APPROVED", findings: "none" }, [["findings"]]],
    ["verdict is not a known one", { verdict: "MAYBE", findings: [finding] }, [["verdict"]]],
    ["a finding is null", { verdict: "CHANGES_REQUESTED", findings: [null] }, [["findings", 0]]],
    [
      "two findings are not objects",
      { verdict: "CHANGES_REQUESTED", findings: ["x", "x"] },
      [
        ["findings", 0],
        ["findings", 1],
      ],
    ],
  ])("when %s the cross-field checks are skipped, not thrown", (_, top, paths) => {
    const parse = () => ReviewOutputSchema.safeParse({ ...top, report, reviewed });

    expect(parse).not.toThrow();
    expect(parse().error?.issues.map((issue) => issue.path)).toEqual(paths);
  });

  test("an output that is not an object is refused without running the cross-field checks", () => {
    expect(ReviewOutputSchema.safeParse("done").error?.issues.map((issue) => issue.path)).toEqual([
      [],
    ]);
  });
});
